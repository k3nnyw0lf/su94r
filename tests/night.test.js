// Night safety net (workers/night.js). What must hold: a low is pushed to the phone and repeats
// (20 min by day, 10 at night, 5 when severe) until "I'm OK" or recovery; a severe low after
// "I'm OK" still tells once; a low that goes silent, or a server that cannot read LibreLinkUp,
// is pushed; caregivers only when switched on; the cron route runs at most every 4 minutes;
// settings, topics and the test push need the owner's key; "I'm OK" works once.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nightCheck, nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';

const DAY = Date.parse('2026-10-02T16:00:00Z');     // 12:00 in New York
const NIGHT = Date.parse('2026-10-03T07:00:00Z');   // 03:00 in New York
const MIN = 60e3;

const person = (mg, t, extra = {}) => ({ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: mg == null ? null : { t, mg, trend: 3 }, ...extra });
const baseRow = (over = {}) => ({ id: 1, ...NIGHT_DEFAULTS, self_topic: 'su94r-self', care_topic: 'su94r-care', state: {}, ...over });

let pushes;
const push = async (topic, msg) => { pushes.push({ topic, ...msg }); };
const ackUrl = (t) => `https://db.test/functions/v1/su94r-cgm/night/ack?t=${t}`;
const tokenOf = (p) => new URL(p.actions[0].url).searchParams.get('t');

async function run(row, people, now, extra = {}) {
  const r = await nightCheck({ row, people, now, push, ackUrl, ...extra });
  row.state = r.state;
  return r;
}

beforeEach(() => { pushes = []; });

describe('night alerts', () => {
  it('stays quiet in range', async () => {
    const row = baseRow();
    await run(row, [person(110, DAY)], DAY);
    expect(pushes).toEqual([]);
    expect(row.state).toEqual({});
  });

  it('a daytime low is pushed with an "I\'m OK" button and repeats every 20 minutes', async () => {
    const row = baseRow();
    await run(row, [person(64, DAY)], DAY);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ topic: 'su94r-self', priority: 4, title: 'Low: 64 mg/dL →' });
    expect(pushes[0].actions[0]).toMatchObject({ action: 'http', label: "I'm OK", method: 'POST' });
    expect(tokenOf(pushes[0])).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row.state)).not.toContain(tokenOf(pushes[0]));    // only its hash is kept
    await run(row, [person(63, DAY + 15 * MIN)], DAY + 15 * MIN);
    expect(pushes).toHaveLength(1);
    await run(row, [person(62, DAY + 20 * MIN)], DAY + 20 * MIN);
    expect(pushes).toHaveLength(2);
    expect(pushes[1].message).toContain('Reminder 2');
  });

  it('at night it is urgent and repeats every 10 minutes; severe every 5', async () => {
    const row = baseRow();
    await run(row, [person(66, NIGHT)], NIGHT);
    expect(pushes[0].priority).toBe(5);
    await run(row, [person(66, NIGHT + 10 * MIN)], NIGHT + 10 * MIN);
    expect(pushes).toHaveLength(2);
    await run(row, [person(50, NIGHT + 15 * MIN)], NIGHT + 15 * MIN);
    expect(pushes).toHaveLength(3);
    expect(pushes[2]).toMatchObject({ priority: 5, title: 'Severe low: 50 mg/dL →', tags: ['rotating_light'] });
  });

  it('"I\'m OK" stops the reminders; a severe low afterwards still tells once', async () => {
    const { acknowledge } = await import('../workers/night.js');
    const row = baseRow();
    await run(row, [person(64, DAY)], DAY);
    const state = await acknowledge(row, tokenOf(pushes[0]), DAY + MIN);
    expect(state.p1.ackAt).toBe(DAY + MIN);
    row.state = state;
    expect(await acknowledge(row, tokenOf(pushes[0]))).toBeNull();     // works once
    await run(row, [person(63, DAY + 40 * MIN)], DAY + 40 * MIN);
    expect(pushes).toHaveLength(1);
    await run(row, [person(52, DAY + 45 * MIN)], DAY + 45 * MIN);
    expect(pushes).toHaveLength(2);
    await run(row, [person(51, DAY + 60 * MIN)], DAY + 60 * MIN);
    expect(pushes).toHaveLength(2);
  });

  it('recovery says so (only if it had alerted) and ends the episode', async () => {
    const row = baseRow();
    await run(row, [person(64, DAY)], DAY);
    await run(row, [person(85, DAY + 5 * MIN)], DAY + 5 * MIN);
    expect(pushes[1]).toMatchObject({ title: 'Back up: 85 mg/dL', priority: 3 });
    expect(row.state).toEqual({});
  });

  it('a low that goes silent is pushed', async () => {
    const row = baseRow();
    await run(row, [person(60, NIGHT)], NIGHT);
    await run(row, [person(60, NIGHT, { latest: { t: NIGHT, mg: 60, trend: 3 } })], NIGHT + 25 * MIN);   // last reading 25 min old
    expect(pushes.at(-1)).toMatchObject({ title: 'Low, and the sensor stopped reporting', priority: 5 });
  });

  it('a server that cannot read LibreLinkUp: open lows count as silent, and the owner is told (every 12 hours)', async () => {
    const row = baseRow();
    await run(row, [person(60, NIGHT)], NIGHT);
    const err = { code: 'auth', message: 'ended' };
    await run(row, [], NIGHT + 15 * MIN, { error: err });
    const titles = pushes.map((p) => p.title);
    expect(titles).toContain('su94r cannot read your glucose');
    expect(titles).toContain('Low, and the sensor stopped reporting');
    const n = pushes.filter((p) => p.title === 'su94r cannot read your glucose').length;
    await run(row, [], NIGHT + 30 * MIN, { error: err });
    expect(pushes.filter((p) => p.title === 'su94r cannot read your glucose').length).toBe(n);
  });

  it('names the person when several are followed', async () => {
    const row = baseRow();
    await run(row, [person(64, DAY), { ...person(120, DAY), pid: 'p2', firstName: 'Ana' }], DAY);
    expect(pushes[0].title).toBe('Ken: Low: 64 mg/dL →');
  });

  it('switched off: nothing', async () => {
    const row = baseRow({ enabled: false });
    await run(row, [person(45, NIGHT)], NIGHT);
    expect(pushes).toEqual([]);
  });

  it('caregivers only when switched on, by the escalation ladder', async () => {
    const off = baseRow();
    await run(off, [person(50, NIGHT)], NIGHT);
    await run(off, [person(50, NIGHT + 5 * MIN)], NIGHT + 5 * MIN);
    expect(pushes.some((p) => p.topic === 'su94r-care')).toBe(false);
    pushes = [];
    const on = baseRow({ care_enabled: true });
    await run(on, [person(50, NIGHT)], NIGHT);
    expect(pushes.some((p) => p.topic === 'su94r-care')).toBe(false);      // the person first
    await run(on, [person(50, NIGHT + 5 * MIN)], NIGHT + 5 * MIN);
    expect(pushes.find((p) => p.topic === 'su94r-care')).toMatchObject({ title: 'Ken needs help now', priority: 5 });
  });
});

function memNight() {
  let row = null;
  return {
    ready: true,
    get row() { return row; },
    async get() { if (!row) row = baseRow({ self_topic: 'su94r-aaaa', care_topic: 'su94r-bbbb' }); return structuredClone(row); },
    async patch(f) { Object.assign(row, structuredClone(f)); },
    async claimTick(now) {
      if (row.last_tick_at && now - Date.parse(row.last_tick_at) < 4 * MIN) return false;
      row.last_tick_at = new Date(now).toISOString();
      return true;
    },
  };
}

describe('night routes', () => {
  let store, clock, people, keyOk;
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const call = (path, { method = 'POST', query = '', body } = {}) => {
    const url = new URL(`https://cgm.test/${path}${query}`);
    return nightRoute(path, new Request(url, { method, body: body == null ? undefined : JSON.stringify(body) }), url,
      { SUPABASE_URL: 'https://db.test' }, { store, json, keyOk, snapshot: async () => ({ people }), push, now: () => clock });
  };
  beforeEach(() => {
    store = memNight();
    clock = NIGHT;
    people = [person(62, NIGHT)];
    keyOk = async (k) => k === 'owner-key';
  });

  it('the cron runs at most every 4 minutes and keeps state', async () => {
    const a = await (await call('night/tick')).json();
    expect(a).toMatchObject({ ok: true, people: 1, sent: 1 });
    expect(pushes[0].actions[0].url).toMatch(/^https:\/\/db\.test\/functions\/v1\/su94r-cgm\/night\/ack\?t=[0-9a-f]{32}$/);
    clock += 2 * MIN;
    expect(await (await call('night/tick')).json()).toMatchObject({ skipped: 'too soon' });
    clock += 3 * MIN;
    expect((await call('night/tick')).status).toBe(200);
    expect(store.row.last_result).toMatchObject({ people: 1, error: null });
  });

  it('"I\'m OK" from the notification works once, POST only', async () => {
    await call('night/tick');
    const t = tokenOf(pushes[0]);
    expect((await call('night/ack', { method: 'GET', query: `?t=${t}` })).status).toBe(405);
    expect((await call('night/ack', { query: `?t=${t}` })).status).toBe(200);
    expect(store.row.state.p1.ackAt).toBe(NIGHT);
    expect((await call('night/ack', { query: `?t=${t}` })).status).toBe(404);
    expect((await call('night/ack', { query: '?t=nope' })).status).toBe(404);
  });

  it('settings, topics and the test push need the owner key', async () => {
    for (const [path, method] of [['night/setup', 'GET'], ['night/setup', 'POST'], ['night/test', 'POST']]) {
      expect((await call(path, { method, query: '?key=wrong' })).status).toBe(401);
    }
    const v = await (await call('night/setup', { method: 'GET', query: '?key=owner-key' })).json();
    expect(v).toMatchObject({ enabled: true, lowMgdl: 70, severeMgdl: 55, selfUrl: 'https://ntfy.sh/su94r-aaaa', careEnabled: false });
    expect((await call('night/test', { query: '?key=owner-key' })).status).toBe(200);
    expect(pushes.at(-1)).toMatchObject({ topic: 'su94r-aaaa', title: 'su94r test alert' });
  });

  it('settings are checked', async () => {
    const bad = await call('night/setup', { query: '?key=owner-key', body: { lowMgdl: 60, severeMgdl: 65 } });
    expect(bad.status).toBe(400);
    const ok = await (await call('night/setup', { query: '?key=owner-key', body: { lowMgdl: 75, enabled: false, timeZone: 'Not/AZone', selfTopic: 'mine' } })).json();
    expect(ok).toMatchObject({ lowMgdl: 75, enabled: false, timeZone: 'America/New_York', selfTopic: 'su94r-aaaa' });
  });
});

describe('wired into the server', () => {
  beforeEach(() => { resetCaches(); vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 }))); });
  it('night routes answer through handleCgm, and a wrong key is refused', async () => {
    const store = memNight();
    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk' };
    const r = await handleCgm('night/setup', new Request('https://cgm.test/night/setup?key=wrong'), env, { night: store, push, screens: { ready: true, async byToken() { return null; } } });
    expect(r.status).toBe(401);
    const t = await handleCgm('night/tick', new Request('https://cgm.test/night/tick', { method: 'POST' }), env, { night: store, push });
    expect(t.status).toBe(200);
    expect(store.row.last_result.error).toBeTruthy();      // no LibreLinkUp sign-in here: recorded, not thrown
  });
});
