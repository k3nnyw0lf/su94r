// Do alerts reach anyone (coverage.js), the morning report, the compression-low wording and phone
// calls (night.js, calls.js), and "can I drive?" (drive.js). What must hold: with no phone, chat or
// answered drill the state is 'none'; each drill channel has its own answer and an answer works
// once; last night's unanswered lows are reported once; a fast night drop still alerts, with the
// meter advice; calls happen only when set up, after the alerts went unanswered, owner first and
// family later, and pressing 1 answers the low; the driving check follows the DVLA lines.

import { describe, it, expect, vi } from 'vitest';
import { coverageOf, runDrill, drillAnswer, logEpisode, morningReport } from '../workers/coverage.js';
import { nightCheck, nightRoute, nightBoundary, callNumbers, NIGHT_DEFAULTS } from '../workers/night.js';
import { dialer, texml, callRoute, telnyxReady } from '../workers/calls.js';
import { driveCheck } from '../workers/drive.js';
import { sha256 } from '../workers/screens.js';

const MIN = 60e3;
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const base = (over = {}) => ({ id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {}, drill: {}, morning: {}, ...over });

describe('coverage and the drill', () => {
  it('none, untested or ok', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(coverageOf(base(), { now }).state).toBe('none');
    expect(coverageOf(base(), { pushes: { me: 1 }, now }).state).toBe('untested');
    expect(coverageOf(base({ drill: { got: { 'me.ntfy': now - 5 * 864e5 } } }), { now }).state).toBe('ok');
    expect(coverageOf(base({ drill: { got: { 'me.ntfy': now - 40 * 864e5 } } }), { now }).state).toBe('none');   // too old
    expect(coverageOf(base({ drill: { got: { 'family.push': now } } }), { now }).family.confirmed).toEqual(['push']);
  });

  it('one alert per channel and role, each with its own answer, answered once', async () => {
    const out = [];
    const send = {
      ntfy: async (topic, msg) => { out.push({ c: 'ntfy', topic, url: msg.actions[0].url }); return true; },
      telegram: async (role, msg) => { out.push({ c: 'telegram', role, url: msg.actions[0].url }); return role === 'me' ? 1 : 0; },
      push: async (role, msg) => { out.push({ c: 'push', role, url: msg.actions[0].url }); return 0; },
    };
    const row = base();
    const d = await runDrill(row, { send, ackBase: 'https://x/night/ack', now: 1000 });
    expect(Object.keys(d.sent).sort()).toEqual(['family.ntfy', 'me.ntfy', 'me.telegram']);
    expect(new Set(out.map((o) => o.url)).size).toBe(6);
    const tgToken = new URL(out.find((o) => o.c === 'telegram' && o.role === 'me').url).searchParams.get('t');
    const a = await drillAnswer({ ...row, drill: d }, tgToken, 2000);
    expect(a.via).toBe('me.telegram');
    expect(a.drill.got['me.telegram']).toBe(2000);
    expect(await drillAnswer({ ...row, drill: a.drill }, tgToken, 3000)).toBeNull();
    expect(await drillAnswer({ ...row, drill: d }, 'f'.repeat(32))).toBeNull();
  });

  it('night/ack answers a drill when it is not a low; night/drill and night/coverage need the owner key', async () => {
    let row = base();
    const store = { ready: true, async get() { return structuredClone(row); }, async patch(f) { row = { ...row, ...structuredClone(f) }; } };
    const urls = [];
    const call = (path, { method = 'POST', key = 'owner' } = {}) => {
      const url = new URL(`https://cgm.test/${path}${key ? `?key=${key}` : ''}`);
      return nightRoute(path, new Request(url, { method }), url, { SUPABASE_URL: 'https://db.test' }, {
        store, json, keyOk: async (k) => k === 'owner', snapshot: async () => ({ people: [] }),
        push: async (topic, msg) => { urls.push(msg.actions[0].url); return true; },
        counts: async () => ({ pushes: { me: 0, family: 0 }, chats: { me: 0, family: 0 } }),
      });
    };
    expect((await call('night/drill', { key: 'nope' })).status).toBe(401);
    expect((await (await call('night/coverage', { method: 'GET' })).json()).state).toBe('none');
    const r = await (await call('night/drill')).json();
    expect(r.sent).toEqual({ 'me.ntfy': true, 'family.ntfy': true });
    expect(urls[0]).toMatch(/^https:\/\/db\.test\/functions\/v1\/su94r-cgm\/night\/ack\?t=[0-9a-f]{32}$/);
    const t = new URL(urls[0]).searchParams.get('t');
    const ack = await (await nightRoute('night/ack', new Request(`https://cgm.test/night/ack?t=${t}`, { method: 'POST' }), new URL(`https://cgm.test/night/ack?t=${t}`), {}, { store, json, keyOk: async () => false, snapshot: async () => ({ people: [] }) })).json();
    expect(ack).toMatchObject({ ok: true, drill: 'me.ntfy' });
    expect((await (await call('night/coverage', { method: 'GET' })).json()).state).toBe('ok');
  });
});

describe('the morning report', () => {
  const tz = 'America/New_York';
  const endAt = Date.parse('2026-10-04T11:00:00Z');               // 7 AM
  it('lists last night\'s lows once, and says which were not answered', () => {
    const state = {};
    logEpisode(state, 'p1', { notified: 1, since: Date.parse('2026-10-04T06:20:00Z'), lowest: 53, lowestAt: Date.parse('2026-10-04T06:31:00Z'), count: 3, name: 'Ken' }, Date.parse('2026-10-04T06:50:00Z'));
    logEpisode(state, 'p1', { notified: 1, since: Date.parse('2026-10-04T08:00:00Z'), lowest: 64, count: 1, ackAt: 1 }, Date.parse('2026-10-04T08:20:00Z'));
    logEpisode(state, 'p1', { since: 1, lowest: 60 }, 2);           // never alerted: not logged
    expect(state._log).toHaveLength(2);
    const opts = { now: endAt + 30 * MIN, nightStartAt: endAt - 9 * 3600e3, nightEndAt: endAt, day: '2026-10-04', clock: (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) };
    const m = morningReport(state, base(), opts);
    expect(m.report).toMatchObject({ for: '2026-10-04', unanswered: 1 });
    expect(m.msg.title).toBe('Last night: 2 lows, 1 not answered');
    expect(m.msg.message).toMatch(/^Lowest 53 mg\/dL at 2:31 AM\. 1 of them got no "I'm OK"/);
    expect(m.msg.es.title).toBe('Anoche: 2 bajas, 1 sin responder');
    expect(morningReport(state, base({ morning: { for: '2026-10-04' } }), opts)).toBeNull();
    expect(morningReport(state, base(), { ...opts, now: endAt - MIN })).toBeNull();
    const quiet = morningReport({}, base(), opts);
    expect(quiet.msg).toBeNull();
    expect(nightBoundary(Date.parse('2026-10-04T15:00:00Z'), tz, 7)).toBe(endAt);
    expect(nightBoundary(Date.parse('2026-10-04T09:00:00Z'), tz, 7)).toBeNull();
  });
});

describe('compression lows and phone calls', () => {
  const NIGHT = Date.parse('2026-10-04T07:00:00Z');                 // 3 AM in New York
  const person = (mg, t, history = []) => ({ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: { t, mg, trend: 1 }, history });

  it('a fast night drop still alerts, with the meter advice; a quick bounce says pressure fits', async () => {
    const row = base();
    const msgs = [];
    const run = async (p, now) => { const r = await nightCheck({ row, people: [p], now, push: async (topic, m) => { msgs.push(m); }, ackUrl: (t) => t }); row.state = r.state; };
    row.state = { _last: { p1: { t: NIGHT - 10 * MIN, mg: 98 } } };
    await run(person(64, NIGHT), NIGHT);
    expect(msgs[0].title).toBe('Low: 64 mg/dL ↓');
    expect(msgs[0].message).toMatch(/dropped fast: lying on the sensor/);
    await run(person(95, NIGHT + 15 * MIN), NIGHT + 15 * MIN);
    expect(msgs.find((m) => m.title.startsWith('Back up')).message).toMatch(/fits pressure on the sensor/);
    expect(row.state._log[0]).toMatchObject({ lowest: 64, answered: false, alerts: 1 });
  });

  it('calls only when set up, after the alerts went unanswered: owner, family 10 minutes later, owner again; 1 answers', async () => {
    const dialed = [];
    const dial = async (to, o) => { dialed.push({ to, ...o }); return true; };
    const numbers = callNumbers([{ name: 'Me', phone: '+1 (239) 555-0101', role: 'me' }, { name: 'Mom', phone: '+12395550102', role: 'family', lang: 'es' }, { phone: '555' }]);
    expect(numbers.map((n) => n.phone)).toEqual(['+12395550101', '+12395550102']);
    const row = base({ call_enabled: true, call_numbers: numbers });
    const run = async (mg, now) => { const r = await nightCheck({ row, people: [person(mg, now)], now, push: async () => {}, ackUrl: (t) => t, dial }); row.state = r.state; };
    await run(64, NIGHT);                                            // first alert: no call yet
    expect(dialed).toHaveLength(0);
    await run(63, NIGHT + 10 * MIN);                                 // second reminder unanswered: call the owner
    expect(dialed.map((d) => d.to)).toEqual(['+12395550101']);
    expect(dialed[0].say).toMatch(/^This is a call from su94r\. Your glucose is low: 63\. Nobody answered the alerts\. Press 1/);
    await run(62, NIGHT + 15 * MIN);
    expect(dialed).toHaveLength(1);                                   // nobody else yet
    await run(61, NIGHT + 20 * MIN);
    expect(dialed.at(-1)).toMatchObject({ to: '+12395550102', lang: 'es' });   // family, 10 minutes after the first call
    expect(dialed.at(-1).say).toMatch(/^Esta es una llamada de su94r\. La glucosa de Ken está baja: 61/);
    await run(60, NIGHT + 26 * MIN);
    expect(dialed.map((d) => d.to)).toEqual(['+12395550101', '+12395550102', '+12395550101']);   // the owner again
    await run(60, NIGHT + 40 * MIN);
    expect(dialed).toHaveLength(3);                                   // and no more
    // Pressing 1 on the family call answers the low.
    const store = { ready: true, async get() { return structuredClone(row); }, async patch(f) { Object.assign(row, structuredClone(f)); } };
    const q = new URLSearchParams({ t: dialed.at(-1).token, lang: 'es', say: dialed.at(-1).say });
    const ans = await callRoute('call/answer', new Request(`https://cgm.test/call/answer?${q}`, { method: 'POST', body: 'Digits=1' }), new URL(`https://cgm.test/call/answer?${q}`), { night: store, base: 'https://cgm.test' });
    expect(await ans.text()).toMatch(/Gracias\. Las alertas de esta baja paran/);
    expect(row.state.p1.ackAt).toBeGreaterThan(0);
    // Off, or not set up: no calls.
    const off = base({ call_enabled: false, call_numbers: numbers });
    const r2 = await nightCheck({ row: off, people: [person(50, NIGHT)], now: NIGHT + 30 * MIN, push: async () => {}, ackUrl: (t) => t, dial });
    expect(r2.sent.some((s) => s.label.startsWith('call'))).toBe(false);
  });

  it('the call itself: Telnyx request, TeXML menu, repeat on 2', async () => {
    expect(telnyxReady({})).toBe(false);
    expect(dialer({})).toBeNull();
    const seen = [];
    const env = { TELNYX_API_KEY: 'k', TELNYX_ACCOUNT_SID: 'acct', TELNYX_TEXML_APP_ID: 'app', TELNYX_FROM: '+12395550100' };
    const d = dialer(env, { base: 'https://cgm.test', fetchImpl: async (u, init) => { seen.push({ u: String(u), init }); return new Response('{}', { status: 200 }); } });
    await d('+12395550101', { token: 'a'.repeat(32), say: 'Hi & <bye>', lang: 'en' });
    expect(seen[0].u).toBe('https://api.telnyx.com/v2/texml/Accounts/acct/Calls');
    const body = JSON.parse(seen[0].init.body);
    expect(body).toMatchObject({ ApplicationSid: 'app', To: '+12395550101', From: '+12395550100' });
    expect(new URL(body.Url).searchParams.get('say')).toBe('Hi & <bye>');
    const x = texml('Hi & <bye>', 'en', 'https://cgm.test/call/answer?t=1&say=a');
    expect(x).toContain('<Say voice="Polly.Joanna" language="en-US" loop="2">Hi &amp; &lt;bye&gt;</Say>');
    expect(x).toContain('action="https://cgm.test/call/answer?t=1&amp;say=a"');
    const q = new URLSearchParams({ t: 'b'.repeat(32), lang: 'en', say: 'Hello' });
    const again = await callRoute('call/answer', new Request(`https://cgm.test/call/answer?${q}&Digits=2`), new URL(`https://cgm.test/call/answer?${q}&Digits=2`), { night: null, base: 'https://cgm.test' });
    expect(await again.text()).toContain('<Gather');
    const bad = await callRoute('call/texml', new Request('https://cgm.test/call/texml?t=x'), new URL('https://cgm.test/call/texml?t=x'), { night: null, base: '' });
    expect(await bad.text()).toContain('no longer active');
  });
});

describe('can I drive?', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('follows the DVLA lines and says where it is heading', () => {
    expect(driveCheck({ latest: null, now }).level).toBe('unknown');
    expect(driveCheck({ latest: { t: now - 20 * MIN, mg: 120 }, now }).level).toBe('unknown');
    const stop = driveCheck({ latest: { t: now - MIN, mg: 70 }, now });
    expect(stop).toMatchObject({ level: 'stop', title: "70 mg/dL: don't drive" });
    expect(stop.lines[0]).toMatch(/wait 45 minutes/);
    expect(driveCheck({ latest: { t: now - MIN, mg: 85 }, now }).level).toBe('snack');
    const watch = driveCheck({ latest: { t: now - MIN, mg: 110 }, rate: -1.2, iob: 2.4, now });
    expect(watch.level).toBe('watch');
    expect(watch.lines).toContain('Active insulin about 2.4 u: it keeps lowering glucose for a few hours.');
    expect(driveCheck({ latest: { t: now - MIN, mg: 130 }, rate: 0, now }).level).toBe('ok');
    expect(driveCheck({ latest: { t: now - MIN, mg: 130 }, soon: 85, now }).level).toBe('watch');
    expect(driveCheck({ latest: { t: now - MIN, mg: 70 }, now, lang: 'es' }).title).toBe('70 mg/dL: no manejes');
  });
});

describe('Alexa: "can I drive?"', () => {
  it('says the numbers without letters for units, in English and Spanish', async () => {
    const { handleCgm, resetCaches } = await import('../workers/cgm-core.js');
    resetCaches();
    const t = Date.now() - 2 * MIN;
    const d = new Date(t);
    let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    const stamp = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${ap}`;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url);
      const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
      const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: { FactoryTimestamp: stamp, ValueInMgPerDl: 82, GlucoseUnits: 1, TrendArrow: 3 } };
      if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
      return res({ status: 0, data: { connection: conn, graphData: [] } });
    }));
    const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', ALEXA_SKILL_ID: 'amzn1.ask.skill.test' };
    const ask = async (locale) => {
      const req = new Request('https://cgm.test/alexa', { method: 'POST', body: JSON.stringify({ version: '1.0', context: { System: { application: { applicationId: 'amzn1.ask.skill.test' } } }, request: { type: 'IntentRequest', locale, timestamp: new Date().toISOString(), intent: { name: 'DriveIntent', slots: {}, confirmationStatus: 'NONE' } } }) });
      const r = await (await handleCgm('alexa', req, ENV, { verifyAlexa: async () => {}, store: { ready: true, async recent() { return []; } }, forecasts: { ready: false } })).json();
      return r.response.outputSpeech.text;
    };
    const en = await ask('en-US');
    expect(en).toMatch(/^82: eat first\. Between 72 and 90: eat fast-acting carbohydrate/);
    expect(en).not.toMatch(/mg\/dL|mmol/);
    expect(en).toMatch(/UK driving guidance/);
    expect(await ask('es-US')).toMatch(/^82: come primero\. Entre 72 y 90/);
    vi.unstubAllGlobals();
  });
});
