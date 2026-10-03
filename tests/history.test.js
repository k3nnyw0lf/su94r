// The server's own history (workers/history.js) and Echo announcements (night.js). What must
// hold: readings are saved once per person and minute, read back past the 1000-row page,
// trimmed to 90 days; the night check saves what it saw; history needs the owner key;
// "how was my night" describes the right hours; the Echo rings at night or for a severe low,
// with links that are checked and never shown back.

import { describe, it, expect, beforeEach } from 'vitest';
import { historyStore, rowsFromSnapshot, nightSummary, weekLine, historyRoute } from '../workers/history.js';
import { nightCheck, nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';

const MIN = 60e3;

describe('the history store against PostgREST', () => {
  it('saves per minute, ignoring readings already kept, and reads past the 1000-row page', async () => {
    const calls = [];
    const rows = Array.from({ length: 1500 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 1) + i * 5 * MIN).toISOString(), mg: 100 + (i % 50), trend: 3 }));
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST' || init.method === 'DELETE') return new Response(null, { status: 201 });
      const offset = Number(new URL(url).searchParams.get('offset'));
      return new Response(JSON.stringify(rows.slice(offset, offset + 1000)), { status: 200 });
    };
    const store = historyStore({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk' }, { fetchImpl });
    expect(await store.save([{ pid: 'p1', t: Date.UTC(2026, 9, 1, 3, 0, 29), mg: 101.4 }, { pid: 'p1', t: Date.now(), mg: 5 }])).toBe(1);
    const saved = JSON.parse(calls[0].init.body);
    expect(saved).toEqual([{ pid: 'p1', t: '2026-10-01T03:00:00.000Z', mg: 101, trend: null }]);
    expect(calls[0].url).toMatch(/on_conflict=pid,t$/);
    expect(calls[0].init.headers.Prefer).toBe('resolution=ignore-duplicates,return=minimal');
    const got = await store.range('p1', 0);
    expect(got).toHaveLength(1500);
    expect(calls.filter((c) => !c.init.method).length).toBe(2);
    await store.prune(Date.UTC(2026, 9, 2));
    expect(calls.at(-1).url).toMatch(/t=lt\.2026-07-04/);
  });

  it('takes the graph and the latest reading from a snapshot', () => {
    const rows = rowsFromSnapshot([{ pid: 'p1', history: [{ t: 1, mg: 100 }, { t: 2, mg: 110, trend: 4 }], latest: { t: 3, mg: 120, trend: 3 } }]);
    expect(rows).toEqual([{ pid: 'p1', t: 1, mg: 100, trend: null }, { pid: 'p1', t: 2, mg: 110, trend: 4 }, { pid: 'p1', t: 3, mg: 120, trend: 3 }]);
  });
});

describe('plain-language answers', () => {
  const now = Date.parse('2026-10-02T13:00:00Z');                 // 9 AM in New York
  const night = [];
  for (let t = Date.parse('2026-10-02T02:00:00Z'); t < Date.parse('2026-10-02T11:00:00Z'); t += 15 * MIN) night.push({ t, mg: 120 });
  night[12] = { t: night[12].t, mg: 62 };                         // 1 AM local
  const day = [{ t: now - 2 * 3600e3, mg: 250 }];                 // after 7 AM: not part of the night

  it('"how was my night" covers 10 PM to 7 AM local and names the low', () => {
    const text = nightSummary([...night, ...day], { now, tz: 'America/New_York' });
    expect(text).toBe('Last night you were in range 97% of the time. You went low once, lowest 62 at 1:00 AM. The highest was 120 at 10:00 PM.');
    expect(nightSummary([], { now })).toMatch(/not have enough readings/);
  });

  it('asked after 10 PM, last night does not take in tonight; before 7 AM it is tonight so far', () => {
    const tonight = [];
    for (let t = Date.parse('2026-10-03T02:00:00Z'); t <= Date.parse('2026-10-03T02:30:00Z'); t += 5 * MIN) tonight.push({ t, mg: 230 });
    const at2231 = Date.parse('2026-10-03T02:31:00Z');
    expect(nightSummary([...night, ...tonight], { now: at2231, tz: 'America/New_York' })).toBe('Last night you were in range 97% of the time. You went low once, lowest 62 at 1:00 AM. The highest was 120 at 10:00 PM.');
    const early = [];
    for (let t = Date.parse('2026-10-03T02:00:00Z'); t < Date.parse('2026-10-03T08:00:00Z'); t += 15 * MIN) early.push({ t, mg: 140 });
    expect(nightSummary(early, { now: Date.parse('2026-10-03T08:00:00Z'), tz: 'America/New_York' })).toMatch(/^So far tonight you were in range 100%/);
  });

  it('"how was my week" in one line', () => {
    const pts = Array.from({ length: 300 }, (_, i) => ({ t: now - i * 30 * MIN, mg: i % 10 === 0 ? 60 : 130 }));   // 6 days
    expect(weekLine(pts, { now })).toBe('This week: 90% in range, 10% below, 0% above; average 123, GMI 6.3%.');
    expect(weekLine(pts.slice(0, 60), { now })).toMatch(/^I only have 30 hours of readings so far/);
    const late = night.filter((p) => p.t >= Date.parse('2026-10-02T08:41:00Z'));
    expect(nightSummary(late, { now, tz: 'America/New_York' })).toMatch(/^From 4:45 AM, when my readings start, you were in range/);
  });
});

describe('history routes and the night check', () => {
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  let mem;
  beforeEach(() => {
    const rows = [];
    mem = { ready: true, rows, async save(r) { rows.push(...r); return r.length; }, async range(pid, from, to) { return rows.filter((x) => x.pid === pid && x.t >= from && x.t < to); }, pruned: 0, async prune() { this.pruned++; } };
  });
  const keyOk = async (k) => k === 'owner';
  const snapshot = async () => ({ people: [{ pid: 'p1', name: 'Ken W', firstName: 'Ken', units: 'mg/dL', low: 70, high: 180, history: [{ t: Date.now() - 30 * MIN, mg: 110 }], latest: { t: Date.now() - MIN, mg: 115, trend: 3 } }] });
  const call = (path, { method = 'GET', query = '', body } = {}) => {
    const url = new URL(`https://cgm.test/${path}${query}`);
    return historyRoute(path, new Request(url, { method, body: body ? JSON.stringify(body) : undefined }), url, {}, { store: mem, json, keyOk, snapshot });
  };

  it('needs the owner key; su94r Mini can copy its history in; reading back gives each person\'s points', async () => {
    expect((await call('history', { query: '?key=wrong' })).status).toBe(401);
    const t0 = Date.now() - 3 * 24 * 3600e3;
    const r = await (await call('history/import', { method: 'POST', query: '?key=owner', body: { pid: 'p1', points: [[t0, 101], [t0 + 5 * MIN, 104], ['x', 1], [Date.now() - 200 * 24 * 3600e3, 99]] } })).json();
    expect(r).toEqual({ ok: true, saved: 2 });
    const h = await (await call('history', { query: '?key=owner&days=14' })).json();
    expect(h.people[0]).toMatchObject({ pid: 'p1', firstName: 'Ken', low: 70 });
    expect(h.points.p1).toEqual([[t0, 101], [t0 + 5 * MIN, 104]]);
  });

  it('the 5-minute night check saves what it saw and trims once a day', async () => {
    let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 'su94r-self', care_topic: 'su94r-care', state: {} };
    const night = { ready: true, async get() { return structuredClone(row); }, async patch(f) { Object.assign(row, structuredClone(f)); }, async claimTick() { return true; } };
    const url = new URL('https://cgm.test/night/tick');
    await nightRoute('night/tick', new Request(url, { method: 'POST' }), url, {}, { store: night, json, keyOk, snapshot, push: async () => true, history: mem });
    expect(mem.rows.map((r) => r.mg)).toEqual([110, 115]);
    expect(mem.pruned).toBe(1);
    await nightRoute('night/tick', new Request(url, { method: 'POST' }), url, {}, { store: night, json, keyOk, snapshot, push: async () => true, history: mem });
    expect(mem.pruned).toBe(1);                                     // not again the same day
  });
});

describe('Echo announcements', () => {
  const NIGHT = Date.parse('2026-10-03T07:00:00Z'), DAY = Date.parse('2026-10-02T16:00:00Z');
  const LOW_URL = 'https://www.virtualsmarthome.xyz/url_routine_trigger/activate.php?trigger=abc123&token=xyz789&response=json';
  const person = (mg, t, trend = 3) => ({ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: { t, mg, trend } });
  const run = async (row, people, now) => { const rings = []; const r = await nightCheck({ row, people, now, push: async () => true, ackUrl: (t) => `https://x/night/ack?t=${t}`, ring: async (u) => { rings.push(u); } }); row.state = r.state; return rings; };
  const baseRow = (over = {}) => ({ id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {}, echo_low_url: LOW_URL, ...over });

  it('rings for a low at night, again with each reminder, not by day unless severe or chosen', async () => {
    const row = baseRow();
    expect(await run(row, [person(64, NIGHT)], NIGHT)).toEqual([LOW_URL]);
    expect(await run(row, [person(63, NIGHT + 10 * 60e3)], NIGHT + 10 * 60e3)).toEqual([LOW_URL]);
    expect(await run(baseRow(), [person(64, DAY)], DAY)).toEqual([]);
    expect(await run(baseRow(), [person(50, DAY)], DAY)).toEqual([LOW_URL]);
    expect(await run(baseRow({ echo_always: true }), [person(64, DAY)], DAY)).toEqual([LOW_URL]);
  });

  it('"Low soon" rings its own trigger only', async () => {
    expect(await run(baseRow(), [person(90, NIGHT, 1)], NIGHT)).toEqual([]);
    const soon = 'https://www.virtualsmarthome.xyz/url_routine_trigger/activate.php?trigger=soon1&token=t2&response=json';
    expect(await run(baseRow({ echo_soon_url: soon }), [person(90, NIGHT, 1)], NIGHT)).toEqual([soon]);
  });

  it('only Virtual Smart Home trigger links are accepted, and they are never shown back', async () => {
    let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    const store = { ready: true, async get() { return structuredClone(row); }, async patch(f) { Object.assign(row, structuredClone(f)); } };
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    const setup = (body) => { const url = new URL('https://cgm.test/night/setup?key=owner'); return nightRoute('night/setup', new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, {}, { store, json, keyOk: async () => true, snapshot: async () => ({ people: [] }) }); };
    expect((await setup({ echoLowUrl: 'https://evil.example/hook' })).status).toBe(400);
    const v = await (await setup({ echoLowUrl: LOW_URL })).json();
    expect(v).toMatchObject({ echoLow: true, echoSoon: false });
    expect(JSON.stringify(v)).not.toContain('xyz789');
    expect(row.echo_low_url).toBe(LOW_URL);
    await setup({ echoLowUrl: '' });
    expect(row.echo_low_url).toBeNull();
  });
});
