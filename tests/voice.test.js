// Logging insulin by voice ("Alexa, tell my sugar 4 units of R insulin") and the dose
// exchange with su94r Mini. What must hold: nothing is logged without a spoken yes; a
// repeated dose is called out before the yes; doses from the computer and from Alexa meet
// in one list; deletions only happen when asked; unsigned requests are refused.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { durationMs } from '../workers/alexa.js';

const NOW = Date.now();
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123', ALEXA_SKILL_ID: 'amzn1.ask.skill.test' };

// In-memory stand-in for the dose store (same interface as workers/doses.js).
function memStore() {
  const rows = new Map();
  return {
    ready: true,
    rows,
    async recent(pid, now = Date.now()) {
      return [...rows.values()].filter((d) => !d.deleted && now - d.t < 48 * 3600e3 && (!pid || d.pid === pid)).sort((a, b) => b.t - a.t);
    },
    // Like the real store: an update never clears a deletion.
    async upsert(list) { for (const d of list) rows.set(d.id, { ...rows.get(d.id), ...d, t: new Date(d.t).getTime(), deleted: rows.get(d.id)?.deleted || false }); return list.length; },
    async markDeleted(ids) { for (const id of ids) if (rows.has(id)) rows.get(id).deleted = true; },
  };
}

// LibreLinkUp with one person, Ken (pid p1).
function fakeLibre(url, init = {}) {
  const u = new URL(url);
  const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
  const meas = { FactoryTimestamp: new Date(NOW).toLocaleString('en-US', { timeZone: 'UTC' }), ValueInMgPerDl: 120, GlucoseUnits: 1, TrendArrow: 3 };
  const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: meas };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  return res({ status: 0, data: { connection: conn, graphData: [] } });
}

let store, forecasts;
function memForecasts() {
  const rows = new Map();
  return { ready: true, rows, async save(list) { for (const f of list) rows.set(f.p, f); }, async get(pid) { return rows.get(pid) || null; } };
}
const deps = () => ({ store, forecasts, verifyAlexa: async () => {} });
const alexa = (intent, confirmationStatus = 'NONE') => new Request('https://cgm.test/alexa', {
  method: 'POST',
  body: JSON.stringify({
    version: '1.0',
    context: { System: { application: { applicationId: 'amzn1.ask.skill.test' } } },
    request: { type: 'IntentRequest', timestamp: new Date().toISOString(), intent: { ...intent, confirmationStatus } },
  }),
});
const say = async (intent, status) => {
  const r = await (await handleCgm('alexa', alexa(intent, status), ENV, deps())).json();
  return { text: r.response.outputSpeech?.text || '', directive: r.response.directives?.[0]?.type, end: r.response.shouldEndSession };
};
const logR = (units = '4', insulin = 'R', extra = {}) => ({
  name: 'LogInsulinIntent',
  slots: { units: { name: 'units', value: units }, insulin: { name: 'insulin', value: insulin }, ...extra },
});

beforeEach(() => {
  resetCaches();
  store = memStore();
  forecasts = memForecasts();
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
});

describe('logging insulin by voice', () => {
  it('asks to confirm first and logs nothing until yes', async () => {
    const r = await say(logR());
    expect(r.text).toBe('Log 4 units of regular insulin now?');
    expect(r.directive).toBe('Dialog.ConfirmIntent');
    expect(store.rows.size).toBe(0);
  });
  it('logs after a yes, as regular insulin for the person followed', async () => {
    const r = await say(logR(), 'CONFIRMED');
    expect(r.text).toMatch(/^Logged 4 units of regular insulin now\./);
    const [d] = [...store.rows.values()];
    expect(d).toMatchObject({ pid: 'p1', kind: 'short', amount: 4, source: 'alexa' });
    expect(Math.abs(d.t - Date.now())).toBeLessThan(5000);
  });
  it('a no logs nothing', async () => {
    expect((await say(logR(), 'DENIED')).text).toMatch(/did not log/);
    expect(store.rows.size).toBe(0);
  });
  it('warns about a dose already logged on the computer, before asking', async () => {
    await store.upsert([{ id: 'x1', pid: 'p1', t: Date.now() - 45 * 60e3, kind: 'rapid', amount: 4, source: 'extension' }]);
    const r = await say(logR());
    expect(r.text).toMatch(/^Careful\. You already logged 4 units rapid 45 minutes ago/);
    expect(r.text).toMatch(/Do you still want to log 4 units of regular insulin now\?$/);
  });
  it('understands "are" for R, brand names and "minutes ago"', async () => {
    expect((await say(logR('4', 'are'))).text).toMatch(/regular/);
    expect((await say(logR('20', 'Lantus'))).text).toMatch(/20 units of long-acting/);
    const r = await say(logR('3', 'Humalog', { ago: { name: 'ago', value: 'PT30M' } }));
    expect(r.text).toBe('Log 3 units of rapid insulin 30 minutes ago?');
  });
  it('asks for what is missing and refuses silly amounts', async () => {
    expect((await say(logR('', 'R'))).directive).toBe('Dialog.ElicitSlot');
    expect((await say(logR('4', 'banana'))).text).toMatch(/Which insulin/);
    expect((await say(logR('400', 'R'), 'CONFIRMED')).text).toMatch(/more than 100\. I did not log it/);
    expect(store.rows.size).toBe(0);
  });
  it('says when insulin was last taken, from every source', async () => {
    await store.upsert([
      { id: 'a', pid: 'p1', t: Date.now() - 130 * 60e3, kind: 'short', amount: 4, source: 'alexa' },
      { id: 'b', pid: 'p1', t: Date.now() - 9 * 3600e3, kind: 'basal', amount: 20, source: 'extension' },
    ]);
    const r = await say({ name: 'LastInsulinIntent', slots: {} });
    expect(r.text).toBe('Last insulin: 4 units of regular, 2 hours 10 minutes ago. And 20 units of long-acting, 9 hours ago.');
  });
  it('refuses a request that fails the signature check', async () => {
    const res = await handleCgm('alexa', alexa(logR(), 'CONFIRMED'), ENV, { store, verifyAlexa: async () => { const { AlexaVerifyError } = await import('../workers/alexa-verify.js'); throw new AlexaVerifyError('bad'); } });
    expect(res.status).toBe(401);
    expect(store.rows.size).toBe(0);
  });
  it('without a test override, an unsigned request is refused', async () => {
    const res = await handleCgm('alexa', alexa(logR(), 'CONFIRMED'), ENV, { store });
    expect(res.status).toBe(401);
  });
  it('reads Alexa durations', () => {
    expect(durationMs('PT30M')).toBe(30 * 60e3);
    expect(durationMs('PT1H30M')).toBe(90 * 60e3);
    expect(durationMs('nonsense')).toBeNull();
  });
});

describe('dose exchange with su94r Mini', () => {
  const sync = (body, key = 'tv-key-123') => handleCgm('voice/sync', new Request(`https://cgm.test/voice/sync?key=${key}`, { method: 'POST', body: JSON.stringify(body) }), ENV, deps());
  it('takes the computer\'s insulin markers and returns the doses said to Alexa', async () => {
    await store.upsert([{ id: 'v1', pid: 'p1', t: Date.now() - 10 * 60e3, kind: 'short', amount: 4, source: 'alexa' }]);
    const r = await (await sync({ markers: [{ id: 'm1', p: 'p1', t: Date.now() - 60e3, type: 'insulin', kind: 'rapid', amount: 3 }, { id: 'meal', p: 'p1', t: Date.now(), type: 'meal', amount: 40 }] })).json();
    expect(r.doses.map((d) => d.id)).toEqual(['v1']);
    expect(r.doses[0]).toMatchObject({ p: 'p1', type: 'insulin', kind: 'short', amount: 4, source: 'alexa' });
    expect(store.rows.get('m1')).toMatchObject({ source: 'extension', amount: 3 });
    expect(store.rows.has('meal')).toBe(false);
  });
  it('deletes only what the computer says it deleted', async () => {
    await store.upsert([
      { id: 'v1', pid: 'p1', t: Date.now() - 10 * 60e3, kind: 'short', amount: 4, source: 'alexa' },
      { id: 'other-pc', pid: 'p1', t: Date.now() - 5 * 60e3, kind: 'rapid', amount: 2, source: 'extension' },
    ]);
    const r = await (await sync({ markers: [], removed: ['v1'] })).json();
    expect(r.doses).toEqual([]);
    expect(store.rows.get('v1').deleted).toBe(true);
    expect(store.rows.get('other-pc').deleted).toBe(false);   // not in this computer's list, but not deleted
  });
  it('a computer that has not heard about a deletion cannot undo it', async () => {
    await store.upsert([{ id: 'v1', pid: 'p1', t: Date.now() - 10 * 60e3, kind: 'short', amount: 4, source: 'alexa' }]);
    await sync({ markers: [], removed: ['v1'] });
    // Another computer still has it and sends it again.
    const r = await (await sync({ markers: [{ id: 'v1', p: 'p1', t: Date.now() - 10 * 60e3, type: 'insulin', kind: 'short', amount: 4, source: 'alexa' }] })).json();
    expect(store.rows.get('v1').deleted).toBe(true);
    expect(r.doses).toEqual([]);
  });
  it('needs the display key', async () => {
    expect((await sync({ markers: [] }, 'wrong')).status).toBe(401);
  });
});

describe('logging a meal by voice', () => {
  const carbs = (grams = '40', extra = {}) => ({ name: 'LogCarbsIntent', slots: { grams: { name: 'grams', value: grams }, ...extra } });
  it('asks to confirm first, logs after a yes, and a no logs nothing', async () => {
    expect((await say(carbs())).text).toBe('Log 40 grams of carbs now?');
    expect(store.rows.size).toBe(0);
    expect((await say(carbs(), 'DENIED')).text).toMatch(/did not log/);
    expect(store.rows.size).toBe(0);
    expect((await say(carbs(), 'CONFIRMED')).text).toMatch(/^Logged 40 grams of carbs now\./);
    expect([...store.rows.values()][0]).toMatchObject({ pid: 'p1', kind: 'carbs', amount: 40, source: 'alexa' });
  });
  it('asks for the grams, takes "30 minutes ago", refuses silly amounts', async () => {
    expect((await say(carbs(''))).directive).toBe('Dialog.ElicitSlot');
    expect((await say(carbs('25', { ago: { name: 'ago', value: 'PT30M' } }))).text).toBe('Log 25 grams of carbs 30 minutes ago?');
    expect((await say(carbs('900'), 'CONFIRMED')).text).toMatch(/more than 300\. I did not log it/);
    expect(store.rows.size).toBe(0);
  });
  it('reaches su94r Mini as a meal, and is not counted as insulin', async () => {
    await say(carbs('40'), 'CONFIRMED');
    const r = await (await handleCgm('voice/sync', new Request('https://cgm.test/voice/sync?key=tv-key-123', { method: 'POST', body: JSON.stringify({ markers: [] }) }), ENV, deps())).json();
    expect(r.doses[0]).toMatchObject({ p: 'p1', type: 'meal', amount: 40, source: 'alexa' });
    expect(r.doses[0].kind).toBeUndefined();
    expect((await say({ name: 'LastInsulinIntent', slots: {} })).text).toBe('I have no insulin logged in the last 24 hours.');
    expect((await say({ name: 'LogInsulinIntent', slots: { units: { value: '4' }, insulin: { value: 'R' } } })).text).toBe('Log 4 units of regular insulin now?');
  });
});

describe('where the glucose is heading', () => {
  const sync = (body) => handleCgm('voice/sync', new Request('https://cgm.test/voice/sync?key=tv-key-123', { method: 'POST', body: JSON.stringify({ markers: [], ...body }) }), ENV, deps());
  const ask = () => say({ name: 'ForecastIntent', slots: {} });
  it('reads a trusted estimate su94r Mini sent, with its range, and never suggests a dose', async () => {
    await sync({ forecasts: [{ p: 'p1', at: Date.now() - 60e3, mg: 120, trusted: true, horizon: 60, h30: { mg: 128, lo: 112, hi: 144 }, h60: { mg: 141, lo: 115, hi: 168 } }] });
    const r = await ask();
    expect(r.text).toBe('In half an hour, likely about 128, between 112 and 144. In an hour, likely about 141, between 115 and 168. This is an estimate from your own past data, not a reason to dose.');
    expect(r.text).not.toMatch(/units|take|inject/i);
  });
  it('says so when the low end is under 70', async () => {
    await sync({ forecasts: [{ p: 'p1', at: Date.now(), mg: 85, trusted: true, horizon: 60, h30: { mg: 76, lo: 64, hi: 88 }, h60: null }] });
    expect((await ask()).text).toMatch(/The low end of that range is under 70, so keep fast sugar close\./);
  });
  it('an untrusted learner, an old estimate, or none: no guess', async () => {
    expect((await ask()).text).toMatch(/^I don't have a fresh estimate/);
    await sync({ forecasts: [{ p: 'p1', at: Date.now(), trusted: false }] });
    expect((await ask()).text).toMatch(/has not earned trust yet/);
    await sync({ forecasts: [{ p: 'p1', at: Date.now() - 45 * 60e3, mg: 120, trusted: true, h30: { mg: 120, lo: 110, hi: 130 } }] });
    expect((await ask()).text).toMatch(/^I don't have a fresh estimate/);
  });
  it('drops estimates that are not shaped right', async () => {
    await sync({ forecasts: [{ p: 'p1', at: Date.now(), mg: 120, trusted: true, h30: { mg: 900, lo: 1, hi: 2 } }, { p: 'p1', at: 'soon' }, 'junk'] });
    expect(forecasts.rows.size).toBe(0);
  });
});
