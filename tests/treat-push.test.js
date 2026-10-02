// Treating a low from the app, and low alerts that ring in the app. What must hold: "I treated it"
// logs the carbs, stops the reminders and schedules a recheck; at the recheck a recovered low is
// confirmed and a low that is still there (or has no reading) starts the reminders again with a
// fresh "I'm OK"; caregivers who were told hear it is handled; only phones that may log can treat;
// any linked phone can turn on app alerts, only to a real push service, and its test reaches only
// itself; an alert counts as sent when the app delivered it even if ntfy failed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';
import { nightCheck, startTreatment, alertFanOut, NIGHT_DEFAULTS } from '../workers/night.js';

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const MIN = 60e3;
const tok = (c) => c.repeat(64);
const P256DH = 'B' + 'A'.repeat(86), AUTH = 'A'.repeat(22);

function fakeLibre(url) {
  const u = new URL(url);
  const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.b.c', expires: 1900000000 } } });
  const d = new Date(Date.now() - MIN); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const ts = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 ${ap}`;
  const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: { FactoryTimestamp: ts, ValueInMgPerDl: 62, GlucoseUnits: 1, TrendArrow: 2 } };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  return res({ status: 0, data: { connection: conn, graphData: [] } });
}

let screens, doses, night, push, sentPush, fanned;
const call = (p, { token, method = 'GET', body } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'GET' ? undefined : JSON.stringify(body || {}),
}), ENV, { screens, store: doses, night, pushStore: push, push: async (topic, msg) => { fanned.push({ topic, msg }); }, telegram: { ready: false }, history: { ready: false }, forecasts: { ready: false } });

beforeEach(async () => {
  resetCaches();
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
  const rows = new Map();
  screens = {
    ready: true, rows,
    async insert(row) { rows.set(row.id, { revoked: false, ...row }); },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
    async update(id, p) { Object.assign(rows.get(id) || {}, p); return []; },
    async list() { return [...rows.values()].filter((r) => !r.revoked); },
  };
  for (const [id, c, extra] of [['aaaaaaaa-1', 'a', { role: 'me', name: 'Ken phone' }], ['bbbbbbbb-2', 'b', { role: 'family', name: 'Mom' }], ['cccccccc-3', 'c', { role: 'family', name: 'Sis', can_log: true }], ['dddddddd-4', 'd', {}]]) {
    await screens.insert({ id, kind: 'screen', token_hash: await sha256(tok(c)), claimed_at: new Date().toISOString(), ...extra });
  }
  const dr = [];
  doses = { ready: true, rows: dr, async recent() { return dr.filter((d) => !d.deleted); }, async between() { return []; }, async upsert(l) { const ok = l.filter(valid); dr.push(...ok); return ok.length; }, async markDeleted(ids) { dr.forEach((d) => { if (ids.includes(d.id)) d.deleted = true; }); } };
  let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 'self-t', care_topic: 'care-t', care_enabled: true, treat_plan: '4 glucose tabs', state: { p1: { since: Date.now() - 20 * MIN, notified: Date.now() - 5 * MIN, count: 2, careRung: 2, ackHash: 'x' } } };
  night = { ready: true, async get() { return structuredClone(row); }, async patch(f) { row = { ...row, ...structuredClone(f) }; }, get row() { return row; } };
  const subs = [];
  sentPush = [];
  push = {
    ready: true, subs,
    async publicKey() { return 'PUBKEY'; }, async keys() { return {}; },
    async add(screenId, s) { subs.push({ id: String(subs.length + 1), screen_id: screenId, ...s }); },
    async remove(screenId, endpoint) { const i = subs.findIndex((s) => s.screen_id === screenId && s.endpoint === endpoint); if (i >= 0) subs.splice(i, 1); },
    async forScreen(screenId) { return subs.filter((s) => s.screen_id === screenId); },
    async forRole() { return []; },
    async ok() {}, async gone() {}, async failed() {},
  };
  fanned = [];
});

describe('treating a low from the app', () => {
  it('logs the carbs, stops the reminders, schedules the recheck, tells caregivers who were told', async () => {
    const r = await (await call('app/treat', { token: tok('a'), method: 'POST', body: { grams: 15 } })).json();
    expect(r).toMatchObject({ ok: true });
    expect(r.recheckAt - Date.now()).toBeGreaterThan(14 * MIN);
    expect(doses.rows[0]).toMatchObject({ kind: 'carbs', amount: 15, source: 'phone', pid: 'p1' });
    const st = night.row.state;
    expect(st.p1.ackAt).toBeTruthy();
    expect(st.p1.ackHash).toBeNull();
    expect(st._treat.p1).toMatchObject({ grams: 15, by: 'Ken phone', mg: 62, done: false });
    expect(fanned).toEqual([expect.objectContaining({ topic: 'care-t', msg: expect.objectContaining({ title: 'Ken is treating the low' }) })]);
  });

  it('the plan and the open low reach the app', async () => {
    const r = await (await call('app/recent', { token: tok('b') })).json();
    expect(r.plan).toEqual({ grams: 15, minutes: 15, text: '4 glucose tabs' });
    expect(r.lows.p1).toMatchObject({ acked: false });
  });

  it('only phones that may log can treat', async () => {
    expect((await call('app/treat', { token: tok('b'), method: 'POST', body: { grams: 15 } })).status).toBe(403);
    expect((await call('app/treat', { token: tok('c'), method: 'POST', body: { grams: 15 } })).status).toBe(200);
    expect((await call('app/treat', { token: tok('d'), method: 'POST', body: { grams: 15 } })).status).toBe(401);
    expect((await call('app/treat', { token: tok('a'), method: 'POST', body: { grams: 500 } })).status).toBe(400);
  });
});

describe('the recheck', () => {
  const T0 = Date.UTC(2026, 9, 2, 16, 0);
  const person = (mg, t) => ({ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: mg == null ? null : { t, mg, trend: 4 } });
  const base = () => startTreatment({ ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: { p1: { since: T0 - 10 * MIN, notified: T0 - 5 * MIN, count: 1 } } }, 'p1', { now: T0, grams: 15, mg: 61 }).state;
  const run = async (state, people, now, extra = {}) => {
    const sent = [];
    const r = await nightCheck({ row: { ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state, ...extra }, people, now, push: async (topic, msg) => { sent.push(msg); }, ackUrl: (t) => `https://x/night/ack?t=${t}` });
    return { sent, state: r.state };
  };

  it('nothing before the plan\'s minutes; the low stays quiet because it was treated', async () => {
    const { sent } = await run(base(), [person(64, T0 + 10 * MIN)], T0 + 10 * MIN);
    expect(sent).toEqual([]);
  });

  it('back above the line: "Back up" says it, no second message', async () => {
    const { sent, state } = await run(base(), [person(95, T0 + 16 * MIN)], T0 + 16 * MIN);
    expect(sent.map((m) => m.title)).toEqual(['Back up: 95 mg/dL']);
    expect(state._treat.p1.done).toBe(true);
  });

  it('still low: the reminders start again with a fresh "I\'m OK", using the plan\'s words', async () => {
    const { sent, state } = await run(base(), [person(63, T0 + 16 * MIN)], T0 + 16 * MIN, { treat_plan: '4 glucose tabs' });
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Still low after treating: 63 mg/dL ↗');
    expect(sent[0].message).toMatch(/15 g at .*Your plan: 4 glucose tabs\. Reminders start again until you are above 70/);
    expect(sent[0].actions[0].url).toMatch(/night\/ack\?t=[0-9a-f]{32}$/);
    expect(state.p1.ackAt).toBeNull();
    expect(state.p1.ackHash).toMatch(/^[0-9a-f]{64}$/);
    const next = await run(state, [person(62, T0 + 21 * MIN)], T0 + 21 * MIN);
    expect(next.sent).toEqual([]);                     // the next reminder waits its turn
    const later = await run(next.state, [person(61, T0 + 37 * MIN)], T0 + 37 * MIN);
    expect(later.sent[0].title).toMatch(/^Low: 61/);
  });

  it('no reading at the recheck: says so, and the reminders start again', async () => {
    const { sent } = await run(base(), [person(null)], T0 + 16 * MIN);
    expect(sent[0]).toMatchObject({ title: 'Could not recheck: no reading', priority: 5 });
    expect(sent[0].message).toMatch(/Check with a meter/);
  });

  it('the low alert carries the plan\'s words', async () => {
    const { sent } = await run({}, [person(64, T0)], T0, { treat_plan: '4 glucose tabs' });
    expect(sent[0].message).toMatch(/^Treat it\. Your plan: 4 glucose tabs\. Tap "I'm OK"/);
  });
});

describe('low alerts in the app', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: P256DH, auth: AUTH } };
  it('any linked phone turns them on, only to a real push service; TVs cannot', async () => {
    expect(await (await call('app/push/key', { token: tok('b') })).json()).toEqual({ key: 'PUBKEY' });
    expect((await call('app/push/subscribe', { token: tok('b'), method: 'POST', body: sub })).status).toBe(200);
    expect(push.subs[0]).toMatchObject({ screen_id: 'bbbbbbbb-2', endpoint: sub.endpoint });
    expect((await call('app/push/subscribe', { token: tok('a'), method: 'POST', body: { ...sub, endpoint: 'https://evil.example/x' } })).status).toBe(400);
    expect((await call('app/push/subscribe', { token: tok('d'), method: 'POST', body: sub })).status).toBe(401);
    await call('app/push/unsubscribe', { token: tok('b'), method: 'POST', body: { endpoint: sub.endpoint } });
    expect(push.subs).toHaveLength(0);
  });

  it('a test reaches only this phone', async () => {
    await call('app/push/subscribe', { token: tok('a'), method: 'POST', body: sub });
    await call('app/push/subscribe', { token: tok('b'), method: 'POST', body: { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/mom' } });
    const posted = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => { posted.push(String(url)); return new Response(null, { status: 201 }); }));
    push.keys = async () => { const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']); return { publicKey: 'PUBKEY', privateKey: k.privateKey }; };
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const realKey = Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey)).toString('base64url');
    push.subs.forEach((s) => { s.p256dh = realKey; });
    expect(await (await call('app/push/test', { token: tok('b'), method: 'POST' })).json()).toEqual({ ok: true });
    expect(posted).toEqual(['https://fcm.googleapis.com/fcm/send/mom']);
  });

  it('an alert counts as sent when the app delivered it, even if ntfy failed', async () => {
    const row = { self_topic: 's', care_topic: 'c' };
    const send = alertFanOut({}, row, { push: async () => { throw new Error('ntfy down'); }, webpush: async () => 1 });
    await expect(send('me', { title: 'Low' })).resolves.toBe(true);
    const none = alertFanOut({}, row, { push: async () => { throw new Error('ntfy down'); }, webpush: async () => 0 });
    await expect(none('me', { title: 'Low' })).rejects.toThrow(/ntfy down/);
  });
});
