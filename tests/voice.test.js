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
    async upsert(list) { for (const d of list) rows.set(d.id, { ...rows.get(d.id), ...d, t: new Date(d.t).getTime(), deleted: false }); return list.length; },
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

let store;
const deps = () => ({ store, verifyAlexa: async () => {} });
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
  it('needs the display key', async () => {
    expect((await sync({ markers: [] }, 'wrong')).status).toBe(401);
  });
});
