// Missed-dose reminders (workers/nudges.js), supplies (workers/supplies.js) and su94r Mini's dose
// copy. What must hold: a usual long-acting dose not logged 90 minutes after its time is
// reminded once; never when it was logged (even at another time today); a mealtime reminder only
// when the glucose shows it and never at night; the text never says what to take; supplies count
// down from logged doses and new sensors and remind by day, once; the dose copy needs the key and
// takes only insulin of the last 90 days.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { missedDoseNudges, clusters, localParts } from '../workers/nudges.js';
import { supplyStatus, supplyReminders, supplyRow } from '../workers/supplies.js';
import { nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';

const MIN = 60e3, DAY = 864e5;
const TZ = 'America/New_York';
// New York in October is UTC-4.
const local = (d, h, m = 0) => Date.UTC(2026, 9, d, h + 4, m);

describe('learning the usual times', () => {
  it('groups times of day', () => {
    const items = [{ minute: 1260, date: 'a' }, { minute: 1275, date: 'b' }, { minute: 1250, date: 'c' }, { minute: 480, date: 'a' }];
    expect(clusters(items)).toEqual([{ center: 480, days: 1 }, { center: 1260, days: 3 }]);
    expect(localParts(local(5, 21, 30), TZ)).toEqual({ date: '2026-10-05', minute: 21 * 60 + 30 });
  });
});

describe('long-acting', () => {
  const basal = (days) => days.map((d) => ({ t: local(d, 21, (d % 3) * 10), kind: 'basal', amount: 18 }));
  const history = basal([1, 2, 3, 4, 5, 6, 7, 8]);

  it('90 minutes after the usual time, once, and it never says what to take', () => {
    const r = missedDoseNudges({ person: null, doses: history, now: local(9, 22, 45), tz: TZ });
    expect(r.nudges).toHaveLength(1);
    expect(r.nudges[0].title).toBe('Long-acting not logged yet');
    expect(r.nudges[0].message).toMatch(/usually log it around 9:10 PM/);
    expect(r.nudges[0].message).not.toMatch(/\btake\b \d|units|dose of/i);
    expect(missedDoseNudges({ person: null, doses: history, now: local(9, 22, 0), tz: TZ }).nudges).toHaveLength(0);   // not yet
    const again = missedDoseNudges({ person: null, doses: history, now: local(9, 23, 0), tz: TZ, nudged: { [r.nudges[0].key]: r.date } });
    expect(again.nudges).toHaveLength(0);
  });

  it('not when it was logged, even at another time today; not with too little history', () => {
    expect(missedDoseNudges({ person: null, doses: [...history, { t: local(9, 21, 5), kind: 'basal' }], now: local(9, 22, 45), tz: TZ }).nudges).toHaveLength(0);
    expect(missedDoseNudges({ person: null, doses: [...history, { t: local(9, 8, 0), kind: 'basal' }], now: local(9, 22, 45), tz: TZ }).nudges).toHaveLength(0);
    expect(missedDoseNudges({ person: null, doses: basal([6, 7, 8]), now: local(9, 22, 45), tz: TZ }).nudges).toHaveLength(0);
  });
});

describe('mealtimes', () => {
  const rapid = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => ({ t: local(d, 12, 30), kind: 'rapid', amount: 5 }));
  const person = (mg, earlier) => ({ pid: 'p1', high: 180, latest: { t: local(9, 14, 0) - MIN, mg, trend: 4 }, history: [{ t: local(9, 13, 0), mg: earlier }] });

  it('only when the glucose shows it', () => {
    const r = missedDoseNudges({ person: person(225, 150), doses: rapid, now: local(9, 14, 0), tz: TZ });
    expect(r.nudges.map((n) => n.title)).toEqual(['Nothing logged since lunch time']);
    expect(r.nudges[0].message).toMatch(/usually log around 12:30 PM, and glucose is 225 ↗ now\. If you ate or took insulin, log it\./);
    expect(missedDoseNudges({ person: person(120, 118), doses: rapid, now: local(9, 14, 0), tz: TZ }).nudges).toHaveLength(0);
    expect(missedDoseNudges({ person: person(160, 115), doses: rapid, now: local(9, 14, 0), tz: TZ }).nudges).toHaveLength(1);   // up 45
  });

  it('not when something was logged, and not at night', () => {
    expect(missedDoseNudges({ person: person(225, 150), doses: [...rapid, { t: local(9, 12, 40), kind: 'carbs' }], now: local(9, 14, 0), tz: TZ }).nudges).toHaveLength(0);
    const lateRapid = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => ({ t: local(d, 21, 30), kind: 'rapid', amount: 5 }));
    const p = { pid: 'p1', high: 180, latest: { t: local(9, 23, 0) - MIN, mg: 240, trend: 4 }, history: [] };
    expect(missedDoseNudges({ person: p, doses: lateRapid, now: local(9, 23, 0), tz: TZ }).nudges).toHaveLength(0);
  });
});

describe('supplies', () => {
  const now = local(10, 10, 0);
  const rows = [
    { pid: 'p1', item: 'rapid', on_hand: 900, warn_at: 860, refill_on: null, set_at: new Date(now - 3 * DAY - 3 * 3600e3).toISOString() },
    { pid: 'p1', item: 'sensors', on_hand: 3, warn_at: 1, refill_on: '2026-10-12', set_at: new Date(now - 20 * DAY).toISOString() },
  ];
  const doses = [];
  for (let d = 1; d <= 3; d++) for (const h of [8, 13, 19]) doses.push({ t: now - d * DAY + h * 3600e3 - 10 * 3600e3, kind: 'rapid', amount: 5 });
  doses.push({ t: now - DAY, kind: 'basal', amount: 18 });

  it('counts down from logged doses and new sensors', () => {
    const s = supplyStatus(rows, { doses, sensorStarts: [now - 19 * DAY, now - 5 * DAY, now - 30 * DAY], sensorDays: 14, now, tz: TZ });
    expect(s[0]).toMatchObject({ item: 'rapid', left: 855, perDay: 6.4, daysLeft: 133, low: true, refillDue: false });
    expect(s[1]).toMatchObject({ item: 'sensors', left: 1, low: true, refillDue: true, daysLeft: 14 });
  });

  it('reminds by day, once a day per item', () => {
    const s = supplyStatus(rows, { doses, sensorStarts: [now - 19 * DAY, now - 5 * DAY], now, tz: TZ });
    const r = supplyReminders(s, { now, tz: TZ });
    expect(r.reminders.map((x) => x.title)).toEqual(['Running low: rapid insulin', 'Refill due 2026-10-12: sensors']);
    expect(r.reminders[0].message).toMatch(/^855 units left, about 133 days at your recent use\./);
    expect(supplyReminders(s, { now, tz: TZ, reminded: Object.fromEntries(r.reminders.map((x) => [x.key, r.date])) }).reminders).toEqual([]);
    expect(supplyReminders(s, { now: local(10, 21, 0), tz: TZ }).reminders).toEqual([]);
  });

  it('checks what the app sends', () => {
    expect(supplyRow('p1', { item: 'coffee', onHand: 1 }).error).toBeTruthy();
    expect(supplyRow('p1', { item: 'rapid', onHand: -5 }).error).toBeTruthy();
    expect(supplyRow('p1', { item: 'rapid', onHand: 600, refillOn: 'soon' }).error).toBeTruthy();
    expect(supplyRow('p1', { item: 'basal', onHand: '300', warnAt: '' }, now)).toMatchObject({ item: 'basal', on_hand: 300, warn_at: 0, refill_on: null });
  });
});

describe('in the 5-minute night check', () => {
  it('sends a due reminder once and remembers it', async () => {
    let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    const store = { ready: true, async get() { return structuredClone(row); }, async patch(f) { row = { ...row, ...structuredClone(f) }; }, async claimTick() { return true; } };
    const history = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => ({ t: local(d, 21, 0), kind: 'basal', amount: 18 }));
    const doses = { ready: true, async between() { return history; } };
    const supplies = { ready: true, async list() { return [{ pid: 'p1', item: 'rapid', on_hand: 100, warn_at: 300, refill_on: null, set_at: new Date(local(9, 8)).toISOString() }]; } };
    const pushed = [];
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    const t = local(9, 22, 45);
    const snapshot = async () => ({ people: [{ pid: 'p1', firstName: 'Ken', units: 'mg/dL', latest: { t: t - MIN, mg: 130, trend: 3 }, history: [] }] });
    const tick = () => { const u = new URL('https://x/night/tick'); return nightRoute('night/tick', new Request(u, { method: 'POST' }), u, {}, { store, json, keyOk: async () => true, snapshot, push: async (topic, msg) => { pushed.push(msg.title); }, doses, supplies, now: () => t }); };
    await tick();
    expect(pushed).toEqual(['Long-acting not logged yet']);      // supplies wait for daytime
    expect(Object.values(row.state._nudge.p1)).toEqual(['2026-10-09']);
    await tick();
    expect(pushed).toHaveLength(1);
  });
});

describe('su94r Mini\'s dose copy', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  let rows;
  beforeEach(() => { resetCaches(); rows = []; });
  const store = () => ({ ready: true, async upsert(l) { const ok = l.filter(valid); rows.push(...ok); return ok.length; } });
  const send = (key, markers) => handleCgm('doses/import', new Request(`https://x/doses/import${key ? `?key=${key}` : ''}`, { method: 'POST', body: JSON.stringify({ markers }) }), ENV, { store: store() });

  it('needs the key; takes insulin of the last 90 days only', async () => {
    const now = Date.now();
    expect((await send('', [])).status).toBe(401);
    const r = await (await send('tv-key-123', [
      { id: 'a', p: 'p1', t: now - 10 * DAY, type: 'insulin', kind: 'basal', amount: 18 },
      { id: 'b', p: 'p1', t: now - 100 * DAY, type: 'insulin', kind: 'rapid', amount: 4 },
      { id: 'c', p: 'p1', t: now - DAY, type: 'meal', amount: 40 },
      { id: 'd', p: 'p1', t: now - DAY, type: 'insulin', amount: 3, source: 'alexa' },
    ])).json();
    expect(r).toEqual({ ok: true, saved: 2 });
    expect(rows.map((x) => [x.id, x.kind, x.source])).toEqual([['a', 'basal', 'extension'], ['d', 'rapid', 'alexa']]);
  });
});

describe('supplies in the app', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  let screens, saved;
  beforeEach(async () => {
    resetCaches();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url);
      const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.b.c', expires: 1900000000 } } });
      const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
      if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
      return res({ status: 0, data: { connection: conn, graphData: [] } });
    }));
    const r = new Map();
    for (const [id, c, extra] of [['aaaaaaaa-1', 'a', { role: 'me' }], ['bbbbbbbb-2', 'b', { role: 'family' }]]) r.set(id, { id, kind: 'screen', token_hash: await sha256(c.repeat(64)), revoked: false, ...extra });
    screens = { ready: true, async byToken(h) { return [...r.values()].find((x) => x.token_hash === h) || null; }, async update() { return []; }, async list() { return [...r.values()]; } };
    saved = [];
  });
  const supplies = () => ({ ready: true, async list() { return saved; }, async save(row) { saved = [row]; }, async remove() { saved = []; } });
  const call = (p, token, body) => handleCgm(p, new Request(`https://x/${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), ENV,
    { screens, supplies: supplies(), store: { ready: true, async between() { return []; } }, night: { ready: false }, history: { ready: false }, forecasts: { ready: false } });

  it('the owner\'s phone saves; a family phone reads only', async () => {
    expect((await call('app/supplies/save', 'b'.repeat(64), { item: 'rapid', onHand: 600 })).status).toBe(403);
    expect(await (await call('app/supplies/save', 'a'.repeat(64), { item: 'rapid', onHand: 600, warnAt: 300 })).json()).toEqual({ ok: true });
    const view = await (await call('app/supplies', 'b'.repeat(64))).json();
    expect(view).toMatchObject({ canEdit: false, items: [{ item: 'rapid', left: 600, warnAt: 300, low: false }] });
    expect((await call('app/supplies/save', 'a'.repeat(64), { item: 'rapid', onHand: 'lots' })).status).toBe(400);
  });
});
