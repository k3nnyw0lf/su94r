// Insights: daily summaries kept past the 90 days of readings (daily.js), GMI by month, goals and
// streaks, active insulin in the app, and the calendar feed (calendar.js). What must hold: a day is
// summarised once, in its own time zone; a day with too few readings neither counts nor breaks a
// streak; active insulin follows su94r Mini's curve for the rapid insulin it is set to; the feed is
// valid iCalendar (escaped, folded, CRLF), needs its own token, and the proxy hands the token on as
// a header.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';
import { summarize, months, streaks, updateDaily, dayIn } from '../workers/daily.js';
import { feedEvents, icsFeed, appointmentRow } from '../workers/calendar.js';
import { nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';
import proxy from '../workers/proxy.js';

const MIN = 60e3, DAY = 864e5;
const tok = (c) => c.repeat(64);
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const day = (d, over = {}) => ({ day: d, readings: 280, mean: 140, inRange: 0.8, below: 0, above: 0.2, lows: 0, ...over });

describe('daily summaries, months and streaks', () => {
  it('summarises a day: share in each range and the lows, counted once each', () => {
    const pts = [{ mg: 60 }, { mg: 65 }, { mg: 100 }, { mg: 62 }, { mg: 200 }].map((p, i) => ({ t: i, ...p }));
    expect(summarize('p1', '2026-10-01', pts)).toEqual({ pid: 'p1', day: '2026-10-01', readings: 5, mean: 97.4, in_range: 0.2, below: 0.6, above: 0.2, lows: 2 });
    expect(summarize('p1', '2026-10-01', [])).toBeNull();
  });

  it('months weigh each day by its readings and leave out thin days', () => {
    const m = months([day('2026-08-30', { mean: 150 }), day('2026-08-31', { mean: 130, readings: 30 }), day('2026-09-01', { mean: 154, inRange: 0.7 }), day('2026-09-02', { mean: 154, inRange: 0.9 })]);
    expect(m).toEqual([{ month: '2026-08', days: 1, gmi: 6.9, inRange: 0.8 }, { month: '2026-09', days: 2, gmi: 7, inRange: 0.8 }]);
  });

  it('streaks: days in a row at the goal, with no lows, the best run and the last 7 days', () => {
    const days = [day('09-01'), day('09-02', { inRange: 0.6 }), day('09-03'), day('09-04', { readings: 20, inRange: 0.1 }), day('09-05', { lows: 1 }), day('09-06')];
    const s = streaks(days, 70, { readings: 100, in_range: 0.75, lows: 0 });
    expect(s).toMatchObject({ goal: 70, streak: 3, best: 3, noLowStreak: 1, week: { met: 4, of: 5 }, today: { onTrack: true, inRange: 0.75 } });
    expect(streaks(days, 85).streak).toBe(0);
    expect(streaks([], 70, null)).toMatchObject({ streak: 0, best: 0, today: null });
  });

  it('writes the days that are over, in the person\'s time zone, once', async () => {
    const now = Date.parse('2026-10-04T15:00:00Z');                   // 11 AM in New York
    const pts = [];
    for (let t = now - 3 * DAY; t < now; t += 5 * MIN) pts.push({ t, mg: 120 });
    const history = { ready: true, async range(pid, from, to) { return pts.filter((p) => p.t >= from && p.t < to); } };
    const rows = [];
    const daily = { ready: true, async save(r) { rows.push(...r); }, async last() { return rows.length ? rows.map((r) => r.day).sort().at(-1) : null; } };
    const n = await updateDaily({ daily, history, people: [{ pid: 'p1', low: 70, high: 180 }], tz: 'America/New_York', now });
    expect(rows.map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(n).toBe(3);
    expect(rows[1].readings).toBe(288);                              // a whole local day of 5-minute readings
    expect(await updateDaily({ daily, history, people: [{ pid: 'p1' }], tz: 'America/New_York', now })).toBe(0);
    expect(dayIn(Date.parse('2026-10-04T03:00:00Z'), 'America/New_York')).toBe('2026-10-03');
  });

  it('the night check writes them once a day', async () => {
    let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    const store = { ready: true, async get() { return structuredClone(row); }, async patch(f) { Object.assign(row, structuredClone(f)); }, async claimTick() { return true; } };
    let calls = 0;
    const daily = { ready: true, async save() {}, async last() { calls += 1; return null; } };
    const history = { ready: true, async save() {}, async range() { return []; }, async prune() {} };
    const tick = () => { const url = new URL('https://cgm.test/night/tick'); return nightRoute('night/tick', new Request(url, { method: 'POST' }), url, {}, { store, json, keyOk: async () => false, snapshot: async () => ({ people: [{ pid: 'p1', latest: null }] }), push: async () => true, history, daily }); };
    await tick();
    await tick();
    expect(calls).toBe(1);
    expect(row.state._meta.dailyFor).toBe(dayIn(Date.now(), row.time_zone));
  });
});

describe('the calendar feed', () => {
  const now = Date.parse('2026-10-04T15:00:00Z');
  it('sensor changes, refills, run-outs and visits; valid iCalendar', () => {
    const ev = feedEvents({
      people: [{ pid: 'p1', firstName: 'Ken', sensorStart: now - 10 * DAY }], sensorDays: 14, now,
      supplies: { p1: [{ item: 'rapid', daysLeft: 9, refillOn: '2026-10-10' }, { item: 'sensors', daysLeft: null, refillOn: null }] },
      visits: { p1: [{ id: 'v1', at: now + 5 * DAY, title: 'Dr. Lee; endocrinology, checkup', place: '100 Main St, Naples' }] },
    });
    expect(ev.map((e) => e.uid)).toEqual([`sensor-p1-${now - 10 * DAY}`, `sensor-p1-${now - 10 * DAY}-next`, 'refill-p1-rapid-2026-10-10', 'runout-p1-rapid', 'visit-v1']);
    expect(ev.find((e) => e.uid === 'runout-p1-rapid')).toMatchObject({ title: 'Insulin runs out (about)', day: '2026-10-13' });
    const ics = icsFeed(ev, { now });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Dr. Lee\\; endocrinology\\, checkup');
    expect(ics).toContain('LOCATION:100 Main St\\, Naples');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261011');
    expect(ics).toContain(`DTSTART:${new Date(now + 4 * DAY - 30 * MIN).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const long = icsFeed([{ uid: 'x', title: 'Á'.repeat(60), start: now, end: now + 1 }], { now });
    expect(long).toMatch(/SUMMARY:Á+\r\n Á+/);
    const es = feedEvents({ people: [{ pid: 'p1', sensorStart: now - DAY }], now, lang: 'es' });
    expect(es[0].title).toBe('Cambiar el sensor');
  });

  it('a visit needs a date and who it is with', () => {
    expect(appointmentRow('p1', { at: 'soon', title: 'x' }, now).error).toMatch(/date and time/);
    expect(appointmentRow('p1', { at: '2030-01-01T10:00', title: 'x' }, now).error).toMatch(/does not look right/);
    expect(appointmentRow('p1', { at: '2026-10-09T14:30:00Z', title: '  ' }, now).error).toMatch(/who the visit/);
    expect(appointmentRow('p1', { at: '2026-10-09T14:30:00Z', title: 'Dr. Lee', place: 'Naples' }, now)).toEqual({ pid: 'p1', at: '2026-10-09T14:30:00.000Z', title: 'Dr. Lee', place: 'Naples' });
  });

  it('the proxy hands the address\'s token on as a header', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (req, init) => { const r = req instanceof Request ? req : new Request(req, init); seen.push({ url: r.url, auth: r.headers.get('authorization') }); return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } }); }));
    const res = await proxy.fetch(new Request(`https://proxy.test/cal/${tok('7')}.ics`), { CGM_URL: 'https://cgm.test/functions/v1/su94r-cgm' });
    expect(res.headers.get('Content-Type')).toMatch(/text\/calendar/);
    expect(seen[0].url).toBe('https://cgm.test/functions/v1/su94r-cgm/calendar/feed');
    expect(seen[0].auth).toBe(`Bearer ${tok('7')}`);
    vi.unstubAllGlobals();
  });
});

describe('through the phone app and the server', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  let screens, doses, night, daily, labs, appointments, supplies, history;
  function fakeLibre(url) {
    const u = new URL(url);
    const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
    if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.b.c', expires: 1900000000 } } });
    const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
    if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
    return res({ status: 0, data: { connection: conn, graphData: [] } });
  }
  const deps = () => ({ screens, store: doses, night, daily, labs, appointments, supplies, history });
  const call = (p, { token, method = 'GET', body, query = '' } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${query}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }), ENV, deps());
  beforeEach(async () => {
    resetCaches();
    vi.stubGlobal('fetch', vi.fn(fakeLibre));
    const rows = new Map();
    screens = {
      ready: true, rows,
      async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, ...row }); },
      async byToken(h) { const r = [...rows.values()].find((x) => x.token_hash === h && !x.revoked); return r ? { ...r } : null; },
      async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); },
      async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
    };
    const drows = [];
    doses = {
      ready: true, rows: drows,
      async recent(pid, now = Date.now()) { return drows.filter((d) => !d.deleted && d.t >= now - 2 * DAY && (!pid || d.pid === pid)); },
      async between(pid, from, to) { return drows.filter((d) => !d.deleted && d.pid === pid && d.t >= from && d.t < to); },
      async upsert(list) { for (const d of list.filter(valid)) drows.push({ ...d, deleted: false }); },
      async markDeleted() {},
    };
    let nrow = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    night = { ready: true, get row() { return nrow; }, async get() { return structuredClone(nrow); }, async patch(f) { nrow = { ...nrow, ...structuredClone(f) }; } };
    const dayRows = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((d, i) => day(d, { inRange: i === 0 ? 0.5 : 0.8 }));
    daily = { ready: true, async since() { return dayRows; } };
    labs = { ready: true, async list() { return [{ id: 'l1', kind: 'a1c', taken_on: '2026-08-12', value: 7.1 }, { id: 'l2', kind: 'other', taken_on: '2026-08-12', value: 90 }]; } };
    const vrows = [];
    appointments = {
      ready: true, rows: vrows,
      async from(pid, t) { return vrows.filter((v) => v.pid === pid && Date.parse(v.at) >= t).map((v) => ({ ...v, at: Date.parse(v.at) })); },
      async add(r) { vrows.push({ id: `v${vrows.length}`, ...r }); },
      async remove(pid, id) { const i = vrows.findIndex((v) => v.id === id); if (i >= 0) vrows.splice(i, 1); },
    };
    supplies = { ready: true, async list() { return []; } };
    history = { ready: true, async range() { return []; } };
    const add = async (id, c, extra) => screens.insert({ id, token_hash: await sha256(tok(c)), claimed_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(), ...extra });
    await add('aaaaaaaa-1111', 'a', { kind: 'screen', role: 'me', name: 'Ken phone' });
    await add('bbbbbbbb-2222', 'b', { kind: 'screen', role: 'family', name: 'Mom', can_log: true });
    await add('cccccccc-3333', 'c', { kind: 'screen', role: 'family', name: 'Aunt' });
  });

  it('active insulin follows the rapid insulin su94r Mini is set to', async () => {
    await doses.upsert([{ id: 'd1', pid: 'p1', t: Date.now() - 60 * MIN, kind: 'rapid', amount: 4, source: 'extension' }, { id: 'd2', pid: 'p1', t: Date.now() - 30 * MIN, kind: 'basal', amount: 20, source: 'phone' }]);
    const before = (await (await call('app/recent', { token: tok('c') })).json()).iob.p1;
    expect(before.last).toMatchObject({ amount: 4, kind: 'rapid' });
    expect(before.units).toBeGreaterThan(2.5);
    expect(before.units).toBeLessThan(4);
    await handleCgm('voice/sync', new Request('https://cgm.test/voice/sync?key=tv-key-123', { method: 'POST', body: JSON.stringify({ markers: [], rapidInsulin: 'lyumjev' }) }), ENV, deps());
    expect(night.row.rapid_insulin).toBe('lyumjev');
    const after = (await (await call('app/recent', { token: tok('c') })).json()).iob.p1;
    expect(after.units).toBeLessThan(before.units);                  // a faster insulin is more used up after an hour
    await handleCgm('voice/sync', new Request('https://cgm.test/voice/sync?key=tv-key-123', { method: 'POST', body: JSON.stringify({ markers: [], rapidInsulin: 'bogus' }) }), ENV, deps());
    expect(night.row.rapid_insulin).toBe('lyumjev');
  });

  it('months, A1c results and streaks for any phone; only the owner\'s phone sets the goal', async () => {
    const r = await (await call('app/trend', { token: tok('c') })).json();
    expect(r.months).toEqual([{ month: '2026-09', days: 2, gmi: 6.7, inRange: 0.65 }, { month: '2026-10', days: 2, gmi: 6.7, inRange: 0.8 }]);
    expect(r.a1c).toEqual([{ takenOn: '2026-08-12', value: 7.1 }]);
    expect(r.goals).toMatchObject({ goal: 70, streak: 3, week: { met: 3, of: 4 } });
    expect(r.canSet).toBe(false);
    expect((await call('app/goal', { token: tok('b'), method: 'POST', body: { tir: 80 } })).status).toBe(403);
    expect((await call('app/goal', { token: tok('a'), method: 'POST', body: { tir: 99 } })).status).toBe(400);
    await call('app/goal', { token: tok('a'), method: 'POST', body: { tir: 85 } });
    expect((await (await call('app/trend', { token: tok('a') })).json()).goals).toMatchObject({ goal: 85, streak: 0 });
  });

  it('visits and the calendar link: the feed shows the visit, with its own token only', async () => {
    const at = new Date(Date.now() + 3 * DAY).toISOString();
    expect((await call('app/appointments/save', { token: tok('c'), method: 'POST', body: { at, title: 'Dr. Lee' } })).status).toBe(403);
    expect((await (await call('app/appointments/save', { token: tok('b'), method: 'POST', body: { at, title: 'Dr. Lee', place: 'Naples' } })).json()).ok).toBe(true);
    const list = await (await call('app/appointments', { token: tok('c') })).json();
    expect(list.visits).toHaveLength(1);
    expect(list.canEdit).toBe(false);
    expect((await call('app/calendar/new', { token: tok('b'), method: 'POST' })).status).toBe(403);
    const { token } = await (await call('app/calendar/new', { token: tok('a'), method: 'POST' })).json();
    const feed = await call('calendar/feed', { token });
    expect(feed.headers.get('Content-Type')).toMatch(/text\/calendar/);
    expect(await feed.text()).toContain('SUMMARY:Dr. Lee');
    expect((await call('calendar/feed', { token: tok('a') })).status).toBe(401);       // a phone's token is not a feed
    expect((await (await call('app/calendar', { token: tok('a') })).json()).link).not.toBeNull();
    await call('app/calendar/remove', { token: tok('a'), method: 'POST' });
    expect((await call('calendar/feed', { token })).status).toBe(401);
  });
});
