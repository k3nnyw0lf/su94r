// Medals (medals.js) and supplements (supplements.js). What must hold: a medal is earned on the day
// its run or total is first reached; a short day neither counts nor breaks a time-in-range run; a
// medal once kept is never taken back; weight medals appear only once weight is logged.
// Supplements are checked, join the pill reminders as "Supplement", and show on Now a week before
// they run out; only the owner's phone changes them or may share a medal; every phone reads both.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { medalsFor, MEDALS } from '../workers/medals.js';
import { supplementRow, parseTimes, dueRefills, asPills, FULLSCRIPT_URL } from '../workers/supplements.js';
import { reminders, NIGHT_DEFAULTS } from '../workers/night.js';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';

const DAY = 864e5, MIN = 60e3;
const dayStr = (i) => new Date(Date.UTC(2026, 8, 1) + i * DAY).toISOString().slice(0, 10);   // 2026-09-01 (a Tuesday) + i
const at = (day, h = 12) => Date.parse(`${day}T${String(h + 4).padStart(2, '0')}:00:00Z`);     // h o'clock in New York (EDT)
const full = (i, inRange = 0.8, lows = 0) => ({ day: dayStr(i), readings: 288, mean: 130, inRange, below: 0, above: 0.2, lows });
const ids = (m) => m.earned.map((e) => e.id);
const next = (m, id) => m.next.find((n) => n.id === id);

describe('medals', () => {
  it('time in range and no lows: runs over full days; a short day neither counts nor breaks', () => {
    const days = [0, 1, 2, 3].map((i) => full(i)).concat([{ ...full(4, 0), readings: 50 }], [5, 6, 7].map((i) => full(i)), [full(8, 0.5), full(9)]);
    const m = medalsFor({ days, goal: 70, now: at(dayStr(10)) });
    expect(m.earned.filter((e) => e.family === 'range')).toEqual([{ id: 'range3', family: 'range', on: dayStr(2) }, { id: 'range7', family: 'range', on: dayStr(7) }]);
    expect(next(m, 'range14')).toEqual({ id: 'range14', family: 'range', have: 1, need: 14 });
    expect(m.earned.find((e) => e.id === 'nolow7').on).toBe(dayStr(7));
    expect(next(m, 'nolow30').have).toBe(9);
    expect(m.changed).toBe(true);
  });

  it('exercise: 150 minutes in a Monday-to-Sunday week, and active days in a row', () => {
    const checks = [6, 7, 8, 9, 10].map((i) => ({ kind: 'exercise', t: at(dayStr(i), 18), value: 30 })).concat({ kind: 'exercise', t: at(dayStr(11), 18), value: 5 });
    const m = medalsFor({ checks, now: at(dayStr(12)) });
    expect(m.earned.find((e) => e.id === 'week150')).toEqual({ id: 'week150', family: 'exercise', on: dayStr(10), count: 1 });
    expect(m.earned.find((e) => e.id === 'active3').on).toBe(dayStr(8));
    expect(ids(m)).not.toContain('active7');
    expect(next(m, 'active7').have).toBe(0);                          // 5 minutes on the 12th is not an active day
    expect(next(m, 'week150')).toMatchObject({ have: 155, need: 150 });
    expect(m.next.some((n) => n.family === 'weight')).toBe(false);    // no weigh-ins, no weight medals
  });

  it('weight: below the first weigh-in, and held 4 weeks later', () => {
    const w = (i, kg) => ({ kind: 'weight', t: at(dayStr(i), 7), value: kg, unit: 'kg' });
    const m = medalsFor({ checks: [w(0, 100), w(3, 99), w(5, 97), w(20, 98), w(34, 97.4)], now: at(dayStr(35)) });
    expect(m.earned.filter((e) => e.family === 'weight').map((e) => [e.id, e.on])).toEqual([['down1', dayStr(3)], ['down2', dayStr(5)], ['held', dayStr(34)]]);
    expect(next(m, 'down5')).toEqual({ id: 'down5', family: 'weight', have: 2.6, need: 5 });
    const early = medalsFor({ checks: [w(0, 100), w(5, 97)], now: at(dayStr(10)) });
    expect(next(early, 'held')).toMatchObject({ have: 5, need: 28 });
  });

  it('logging: meals 7 days in a row, a meter check on a sensor\'s first day, 30 days of readings', () => {
    const carbs = [];
    for (let i = 0; i < 7; i++) carbs.push({ kind: 'carbs', t: at(dayStr(i), 8) }, { kind: 'carbs', t: at(dayStr(i), 19) });
    const start = at(dayStr(2), 9);
    const days = Array.from({ length: 30 }, (_, i) => ({ ...full(i), readings: 10 }));
    const m = medalsFor({ carbs, checks: [{ kind: 'meter', t: start + 3 * 3600e3, value: 120 }], sensorStarts: [start], days, now: at(dayStr(30)) });
    expect(m.earned.filter((e) => e.family === 'logging')).toEqual([
      { id: 'meals7', family: 'logging', on: dayStr(6) },
      { id: 'sensorcheck', family: 'logging', on: dayStr(2), count: 1 },
      { id: 'days30', family: 'logging', on: dayStr(29) },
    ]);
  });

  it('a kept medal stays, keeps its first day, and nothing changes when nothing is new', () => {
    const kept = { range30: { on: '2026-06-01' }, range3: { on: '2026-05-01' } };
    const m = medalsFor({ days: [0, 1, 2].map((i) => full(i)), now: at(dayStr(3)), kept });
    expect(m.earned.find((e) => e.id === 'range30').on).toBe('2026-06-01');
    expect(m.earned.find((e) => e.id === 'range3').on).toBe('2026-05-01');
    expect(m.changed).toBe(false);
    expect(next(m, 'range7')).toBeTruthy();                            // range30 is kept, but range7 was never earned
    expect(MEDALS.every((x) => /^[a-z0-9]+$/.test(x.id))).toBe(true);
  });
});

describe('supplements', () => {
  const now = Date.parse('2026-10-05T16:00:00Z');
  it('checks what is typed in', () => {
    expect(parseTimes('20:30, 8:00')).toEqual(['8:00', '20:30']);
    expect(parseTimes('08:00 8:00')).toEqual(['8:00']);
    expect(parseTimes('25:00')).toBeNull();
    expect(parseTimes('')).toEqual([]);
    const r = supplementRow({ name: 'Vitamin D3 <b>', dose: '1 capsule', times: '8:00', runsOut: '2026-10-20' }, { now });
    expect(r.row).toMatchObject({ name: 'Vitamin D3 b', dose: '1 capsule', times: ['8:00'], runsOut: '2026-10-20', fullscript: true });
    expect(r.row.id).toMatch(/^sup-[a-z0-9]+$/);
    expect(supplementRow({ name: 'Zinc', fullscript: false }, { now, id: 'sup-abc123' }).row).toMatchObject({ id: 'sup-abc123', fullscript: false, times: [] });
    expect(supplementRow({ name: '' }, { now }).error).toMatch(/Name the supplement/);
    expect(supplementRow({ name: 'Zinc', times: '8am' }, { now }).error).toMatch(/Times look like/);
    expect(supplementRow({ name: 'Zinc', runsOut: '2031-01-01' }, { now }).error).toMatch(/run-out date/);
  });

  it('refills show a week ahead (and up to 30 days after), soonest first; pills get the supplements', () => {
    const list = [{ id: 'a', name: 'Fish oil', runsOut: '2026-10-10' }, { id: 'b', name: 'Zinc', runsOut: '2026-10-20' }, { id: 'c', name: 'B12', runsOut: '2026-10-02', fullscript: false }, { id: 'd', name: 'Iron', runsOut: '' }];
    expect(dueRefills(list, { now })).toEqual([
      { id: 'c', name: 'B12', runsOut: '2026-10-02', days: -3, fullscript: false },
      { id: 'a', name: 'Fish oil', runsOut: '2026-10-10', days: 5, fullscript: true },
    ]);
    expect(asPills([{ name: 'Zinc', times: ['8:00'] }, null])).toEqual([{ name: 'Zinc', times: ['8:00'], supplement: true }]);
    expect(FULLSCRIPT_URL).toBe('https://us.fullscript.com/login');
  });

  it('a supplement reminder says "Supplement"; a pill still says "Pill"', async () => {
    const checks = { ready: true, rows: [], async between() { return []; }, async add(rows) { this.rows.push(...rows); return rows.length; } };
    const row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', meds: [{ name: 'Atorvastatin', times: ['13:00'] }], supplements: [{ id: 'sup-1', name: 'Magnesium', times: ['13:00'] }] };
    const msgs = [];
    await reminders(row, [{ pid: 'p1', firstName: 'Ken', name: 'Ken W', latest: null }], {}, async (topic, m) => { msgs.push(m); }, { checks, ackUrl: (t) => `https://x/night/ack?t=${t}`, now: Date.parse('2026-10-04T18:05:00Z') });
    expect(msgs.map((m) => m.title).sort()).toEqual(['Pill: Atorvastatin', 'Supplement: Magnesium']);
    expect(msgs.find((m) => m.title === 'Supplement: Magnesium').es.title).toBe('Suplemento: Magnesium');
  });
});

describe('through the server', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  const tok = (c) => c.repeat(64);
  let screens, night, nrow;
  const dailyRows = Array.from({ length: 8 }, (_, i) => ({ day: new Date(Date.now() - (8 - i) * DAY).toISOString().slice(0, 10), readings: 288, mean: 120, inRange: 0.9, below: 0, above: 0.1, lows: 0 }));
  const call = (p, { token, method = 'GET', body, query = '' } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${query}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }), ENV, {
    screens, night, store: { ready: true, async recent() { return []; }, async between() { return []; } }, history: { ready: true, async range() { return []; } }, forecasts: { ready: false },
    daily: { ready: true, async since() { return dailyRows; } }, checks: { ready: true, async between() { return []; } },
  });
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
    nrow = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    night = { ready: true, async get() { return structuredClone(nrow); }, async patch(f) { nrow = { ...nrow, ...structuredClone(f) }; } };
    const rows = new Map();
    for (const [id, c, extra] of [['aaaaaaaa-1', 'a', { role: 'me' }], ['bbbbbbbb-2', 'b', { role: 'family' }]]) rows.set(id, { id, kind: 'screen', token_hash: await sha256(tok(c)), revoked: false, ...extra });
    screens = { ready: true, async byToken(h) { return [...rows.values()].find((x) => x.token_hash === h) || null; }, async update() { return []; }, async list() { return [...rows.values()]; } };
  });

  it('every phone reads the medals, they are kept once earned, only the owner\'s phone may share', async () => {
    const mine = await (await call('app/medals', { token: tok('a') })).json();
    expect(mine.canShare).toBe(true);
    expect(mine.earned.map((e) => e.id)).toEqual(['range3', 'range7', 'nolow7']);
    expect(Object.keys(nrow.medals.p1)).toEqual(['range3', 'range7', 'nolow7']);
    const family = await (await call('app/medals', { token: tok('b') })).json();
    expect(family).toMatchObject({ canShare: false, earned: mine.earned });
  });

  it('only the owner\'s phone changes supplements; they reach the pill list and the refills on Now', async () => {
    const soon = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    expect((await call('app/supplements/save', { token: tok('b'), method: 'POST', body: { name: 'Zinc' } })).status).toBe(403);
    expect((await call('app/supplements/save', { token: tok('a'), method: 'POST', body: { name: 'Zinc', times: 'noon' } })).status).toBe(400);
    const saved = await (await call('app/supplements/save', { token: tok('a'), method: 'POST', body: { name: 'Fish oil', dose: '2 softgels', times: '8:00', runsOut: soon } })).json();
    expect(saved.items).toHaveLength(1);
    const id = saved.items[0].id;
    await call('app/supplements/save', { token: tok('a'), method: 'POST', body: { id, name: 'Fish oil', dose: '1 softgel', times: '8:00, 20:00', runsOut: soon } });
    expect(nrow.supplements).toEqual([{ id, name: 'Fish oil', dose: '1 softgel', times: ['8:00', '20:00'], runsOut: soon, fullscript: true }]);
    const view = await (await call('app/supplements', { token: tok('b') })).json();
    expect(view).toMatchObject({ canEdit: false, fullscript: FULLSCRIPT_URL, refills: [{ name: 'Fish oil', days: 3 }] });
    expect((await (await call('app/meds', { token: tok('b') })).json()).meds).toEqual([{ name: 'Fish oil', times: ['8:00', '20:00'], supplement: true }]);
    expect((await (await call('app/recent', { token: tok('b') })).json()).refills.map((r) => r.name)).toEqual(['Fish oil']);
    await call('app/supplements/remove', { token: tok('a'), method: 'POST', body: { id } });
    expect(nrow.supplements).toEqual([]);
  });
});
