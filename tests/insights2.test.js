// The low review and meal timing (insights.js), the big screen's extra lines, and the time-zone
// switch. What must hold: lows are counted once each with how long they lasted and whether a high
// above 250 followed; meal rises are grouped by when the insulin was logged and need 3 meals per
// group; the big screen gets active insulin and the last meal; only the owner's phone moves the
// night hours to another (real) time zone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lowReview, mealTiming } from '../workers/insights.js';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { NIGHT_DEFAULTS } from '../workers/night.js';

const MIN = 60e3, DAY = 864e5;
const tok = (c) => c.repeat(64);

describe('lows and their treatment', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  it('counts each low, how long, rebounds above 250, and the carbs in the first half hour', () => {
    const pts = [];
    for (let t = now - 14 * DAY; t <= now; t += 5 * MIN) pts.push({ t, mg: 130 });
    const lowAt = (start, minutes, rebound) => {
      for (const p of pts) {
        if (p.t >= start && p.t < start + minutes * MIN) p.mg = 60;
        if (rebound && p.t >= start + (minutes + 60) * MIN && p.t < start + (minutes + 90) * MIN) p.mg = 280;
      }
    };
    lowAt(now - 10 * DAY, 30, true);
    lowAt(now - 6 * DAY, 15, true);
    lowAt(now - 2 * DAY, 45, false);
    const events = [{ type: 'meal', t: now - 10 * DAY + 5 * MIN, amount: 40 }, { type: 'meal', t: now - 6 * DAY + 2 * MIN, amount: 30 }, { type: 'meal', t: now - 2 * DAY + 10 * MIN, amount: 15 }];
    const r = lowReview(pts, events, { now });
    expect(r).toMatchObject({ count: 3, medianMin: 30, longestMin: 45, rebounds: 2, medianGrams: 30 });
    expect(r.lines[0]).toBe('3 lows in 14 days; they lasted about 30 min (the middle one), the longest 45 min.');
    expect(r.lines[1]).toMatch(/^2 of 3 were followed by more than 250 within 3 hours/);
    expect(lowReview(pts, events, { now, lang: 'es' }).lines[0]).toBe('3 bajas en 14 días; duraron unos 30 min (la mediana), la más larga 45 min.');
    expect(lowReview([{ t: now - DAY, mg: 120 }], [], { now }).lines).toEqual(['No lows in the last 14 days.']);
  });
});

describe('meal timing', () => {
  const now = Date.parse('2026-10-14T23:00:00Z');
  it('groups meal rises by when the insulin was logged, 3 meals per group', () => {
    const pts = [];
    for (let t = now - 15 * DAY; t <= now; t += 5 * MIN) pts.push({ t, mg: 110 });
    const events = [];
    const meal = (day, gapMin, rise) => {
      const t = now - day * DAY - 6 * 3600e3;
      events.push({ type: 'meal', t, amount: 50 }, { type: 'insulin', kind: 'rapid', t: t - gapMin * MIN, amount: 5 });
      for (const p of pts) if (p.t > t + 30 * MIN && p.t <= t + 120 * MIN) p.mg = 110 + rise;
    };
    meal(2, 15, 40); meal(3, 12, 50); meal(4, 18, 45);                 // 10 to 19 min before
    meal(5, 0, 90); meal(6, 2, 80); meal(7, -1, 85);                   // at the meal
    meal(8, -20, 120);                                                 // after (only one)
    const r = mealTiming(pts, events, { now });
    expect(r.groups).toEqual([{ key: 'at', n: 3, rise: 85 }, { key: '10-19', n: 3, rise: 45 }]);
    expect(r.lines[0]).toBe('Insulin at the meal (up to 9 min before): rose about 85 (3 meals).');
    expect(r.lines.at(-1)).toMatch(/talk with your doctor/);
    expect(mealTiming(pts, [], { now }).lines[0]).toMatch(/^Not enough meals/);
  });
});

describe('through the server', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  let screens, night;
  const doses = { ready: true, async recent() { return [{ id: 'd', pid: 'p1', t: Date.now() - 30 * MIN, kind: 'rapid', amount: 4, source: 'phone' }, { id: 'm', pid: 'p1', t: Date.now() - 35 * MIN, kind: 'carbs', amount: 50, source: 'phone' }]; }, async between() { return []; } };
  const call = (p, { token, method = 'GET', body, query = '' } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${query}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }), ENV, { screens, night, store: doses, history: { ready: true, async range() { return []; } }, forecasts: { ready: false } });
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
    let nrow = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    night = { ready: true, get row() { return nrow; }, async get() { return structuredClone(nrow); }, async patch(f) { nrow = { ...nrow, ...structuredClone(f) }; } };
    const rows = new Map();
    screens = {
      ready: true,
      async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, ...row }); },
      async byToken(h) { const r = [...rows.values()].find((x) => x.token_hash === h && !x.revoked); return r ? { ...r } : null; },
      async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); },
      async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
    };
    const add = async (id, c, extra) => screens.insert({ id, token_hash: await sha256(tok(c)), claimed_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(), ...extra });
    await add('aaaaaaaa-1111', 'a', { kind: 'screen', role: 'me', name: 'Ken phone' });
    await add('bbbbbbbb-2222', 'b', { kind: 'screen', role: 'family', name: 'Mom', can_log: true });
  });

  it('the big screen gets active insulin and the last meal and dose', async () => {
    const d = await (await call('display/data', { query: '?key=tv-key-123' })).json();
    expect(d.people[0].extra).toMatchObject({ meal: { g: 50 }, dose: { u: 4, kind: 'rapid' }, soon: null });
    expect(d.people[0].extra.iob).toBeGreaterThan(2);
  });

  it('only the owner\'s phone moves the night hours to a real time zone', async () => {
    expect((await call('app/timezone', { token: tok('b'), method: 'POST', body: { tz: 'Europe/Madrid' } })).status).toBe(403);
    expect((await call('app/timezone', { token: tok('a'), method: 'POST', body: { tz: 'Mars/Olympus' } })).status).toBe(400);
    const r = await (await call('app/timezone', { token: tok('a'), method: 'POST', body: { tz: 'Europe/Madrid' } })).json();
    expect(r.text).toBe('Night hours, reminders and days now follow Europe/Madrid time.');
    expect(night.row.time_zone).toBe('Europe/Madrid');
    expect((await (await call('app/recent', { token: tok('b') })).json()).tz).toBe('Europe/Madrid');
    const ins = await (await call('app/insights', { token: tok('b') })).json();
    expect(ins.lows.lines).toEqual(['No lows in the last 14 days.']);
  });
});
