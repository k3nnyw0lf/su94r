// Logging besides insulin and carbs (checks.js): meter readings against the sensor, ketones against
// Diabetes UK's lines, weight and exercise, pills with their reminders and "Taken", su94r Mini's
// pills via voice/sync, and the CSV export. What must hold: values are checked and kept in one unit;
// a meter reading far from the sensor says so; high ketones reach the owner and the family; a pill
// reminder comes an hour after its time only when nothing was logged, once, and "Taken" logs it; a
// pill deleted in su94r Mini is deleted on the server; the export has every kind, oldest first.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';
import { checkRow, sensorVsMeter, ketoneLevel, pillTimes, sameMed, checksForReport } from '../workers/checks.js';
import { reminders, nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';
import { exportCsv } from '../workers/export.js';

const MIN = 60e3, DAY = 864e5;
const tok = (c) => c.repeat(64);
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function memChecks() {
  const rows = [];
  return {
    ready: true, rows,
    async between(pid, from, to, kinds = null) { return rows.filter((r) => !r.deleted && r.pid === pid && Date.parse(r.t) >= from && Date.parse(r.t) < to && (!kinds || kinds.includes(r.kind))).map((r) => ({ ...r, t: Date.parse(r.t) })).sort((a, b) => a.t - b.t); },
    async get(id) { const r = rows.find((x) => x.id === id && !x.deleted); return r ? { ...r, t: Date.parse(r.t) } : null; },
    async add(list) { for (const r of list) if (!rows.some((x) => x.id === r.id)) rows.push({ ...r, deleted: false }); },
    async remove(ids) { for (const r of rows) if (ids.includes(r.id)) r.deleted = true; },
  };
}

describe('checking what is logged', () => {
  const now = Date.parse('2026-10-04T15:00:00Z');
  it('keeps one unit per kind and refuses what cannot be right', () => {
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'meter', value: '6.2', unit: 'mmol/L' }, now)).toMatchObject({ value: 112, unit: 'mg/dL' });
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'meter', value: 900 }, now).error).toMatch(/between 20 and 600/);
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'ketone', value: '1,8' }, now)).toMatchObject({ value: 1.8, unit: 'mmol/L' });
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'ketone', label: 'moderate' }, now)).toMatchObject({ label: 'moderate', unit: 'urine', value: null });
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'weight', value: 181.7, unit: 'lb' }, now)).toMatchObject({ value: 82.4, unit: 'kg' });
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'exercise', value: 30, label: 'dance' }, now)).toMatchObject({ value: 30, unit: 'min', label: 'other' });
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'med', label: '  ' }, now).error).toBe('Pick the medicine.');
    expect(checkRow({ id: 'a', pid: 'p', t: now - 2 * DAY, kind: 'meter', value: 100 }, now).error).toMatch(/24 hours/);
    expect(checkRow({ id: 'a', pid: 'p', t: now, kind: 'blood' }, now).error).toBe('Pick what to log.');
  });

  it('a meter reading against the sensor; ketones against Diabetes UK\'s lines', () => {
    const pts = [{ t: now - 10 * MIN, mg: 150 }, { t: now - 2 * MIN, mg: 140 }];
    expect(sensorVsMeter(112, now, pts)).toEqual({ cgm: 140, diff: 28, pct: 25, off: true });
    expect(sensorVsMeter(130, now, pts)).toMatchObject({ off: false });
    expect(sensorVsMeter(80, now, [{ t: now, mg: 95 }])).toMatchObject({ off: false });       // under 100: 20 mg/dL
    expect(sensorVsMeter(80, now, [{ t: now - 20 * MIN, mg: 95 }])).toBeNull();
    expect([0.4, 0.6, 1.6, 3].map((value) => ketoneLevel({ value, unit: 'mmol/L' }))).toEqual(['normal', 'raised', 'high', 'urgent']);
    expect(ketoneLevel({ unit: 'urine', label: 'large' })).toBe('urgent');
    const r = checksForReport([{ kind: 'meter', t: now, value: 112 }, { kind: 'meter', t: now - 9 * MIN, value: 148 }, { kind: 'ketone', t: now, value: 1.7, unit: 'mmol/L' }], pts);
    expect(r).toMatchObject({ compared: 2, within: 1, mard: 13 });
    expect(r.ketones[0].level).toBe('high');
  });

  it('pill times: the ones set, or learned from 5 days of logs; names match loosely', () => {
    const logs = [];
    for (let d = 1; d <= 6; d++) logs.push({ id: `l${d}`, kind: 'med', label: 'metformin 500 MG Oral Tablet', t: Date.parse(`2026-10-0${d < 4 ? d : d}T12:${10 + d}:00Z`) - 0 * DAY });
    const meds = [{ name: 'Metformin', isInsulin: false }, { name: 'Atorvastatin', times: ['21:00'] }, { name: 'Lantus', isInsulin: true, times: ['22:00'] }];
    const times = pillTimes(meds, logs, { tz: 'America/New_York', now: Date.parse('2026-10-07T12:00:00Z') });
    expect(times).toEqual([{ name: 'Metformin', minute: 8 * 60 + 14, set: false }, { name: 'Atorvastatin', minute: 21 * 60, set: true }]);
    expect(sameMed('metformin 500 MG Oral Tablet', 'Metformin')).toBe(true);
    expect(sameMed('Metoprolol', 'Metformin')).toBe(false);
  });
});

describe('pill reminders', () => {
  const at = (iso) => Date.parse(iso);
  const person = { pid: 'p1', firstName: 'Ken', name: 'Ken W', latest: null };
  it('an hour after the time when nothing is logged, once; "Taken" logs it; not when taken', async () => {
    const checks = memChecks();
    const row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', meds: [{ name: 'Atorvastatin', times: ['09:00'] }] };
    const state = {};
    const msgs = [];
    const send = async (topic, m) => { msgs.push(m); };
    const ackUrl = (t) => `https://x/night/ack?t=${t}`;
    await reminders(row, [person], state, send, { checks, ackUrl, now: at('2026-10-04T13:30:00Z') });   // 9:30: too early
    expect(msgs).toHaveLength(0);
    await reminders(row, [person], state, send, { checks, ackUrl, now: at('2026-10-04T14:05:00Z') });   // 10:05
    expect(msgs.map((m) => m.title)).toEqual(['Pill: Atorvastatin']);
    expect(msgs[0].message).toBe('Your 9:00 AM Atorvastatin is not logged yet. Tap "Taken" if you took it.');
    expect(msgs[0].actions[0].label).toBe('Taken');
    await reminders(row, [person], state, send, { checks, ackUrl, now: at('2026-10-04T14:30:00Z') });
    expect(msgs).toHaveLength(1);                                     // once
    // "Taken" through night/ack logs the pill.
    let nrow = { ...row, state };
    const store = { ready: true, async get() { return structuredClone(nrow); }, async patch(f) { nrow = { ...nrow, ...structuredClone(f) }; } };
    const token = new URL(msgs[0].actions[0].url).searchParams.get('t');
    const url = new URL(`https://cgm.test/night/ack?t=${token}`);
    const r = await (await nightRoute('night/ack', new Request(url, { method: 'POST' }), url, {}, { store, json, keyOk: async () => false, snapshot: async () => ({ people: [] }), checks })).json();
    expect(r).toMatchObject({ ok: true, pill: 'Atorvastatin' });
    expect(checks.rows[0]).toMatchObject({ kind: 'med', label: 'Atorvastatin', source: 'reminder' });
    // Taken already that morning: no reminder the next day either.
    const state2 = {};
    await checks.add([{ id: 'x', pid: 'p1', t: new Date(at('2026-10-05T12:50:00Z')).toISOString(), kind: 'med', label: 'atorvastatin 20 MG', source: 'phone' }]);
    await reminders(row, [person], state2, send, { checks, ackUrl, now: at('2026-10-05T14:05:00Z') });
    expect(msgs).toHaveLength(1);
  });
});

describe('through the server', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  let screens, checks, night, pushed, history;
  const call = (p, { token, method = 'GET', body, query = '' } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${query}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }), ENV, { screens, checks, night, history, store: { ready: true, async recent() { return []; }, async between() { return []; }, async upsert(l) { return l.filter(valid).length; }, async markDeleted() {} }, push: async (topic, m) => { pushed.push({ topic, title: m.title }); return true; }, webpush: async () => 0, telegram: { ready: false } });
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
    pushed = [];
    checks = memChecks();
    let nrow = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    night = { ready: true, get row() { return nrow; }, async get() { return structuredClone(nrow); }, async patch(f) { nrow = { ...nrow, ...structuredClone(f) }; } };
    history = { ready: true, async range(pid, from, to) { return [{ t: Date.now() - 3 * MIN, mg: 160 }].filter((p) => p.t >= from && p.t < to); }, async save() {} };
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
    await add('cccccccc-3333', 'c', { kind: 'screen', role: 'family', name: 'Aunt' });
  });

  it('a meter reading says how far the sensor was; high ketones reach the owner and the family', async () => {
    const r = await (await call('app/check', { token: tok('b'), method: 'POST', body: { kind: 'meter', value: 120, pid: 'p1' } })).json();
    expect(r.sensor).toMatchObject({ cgm: 160, off: true });
    expect(r.text).toMatch(/^Logged 120 mg\/dL\. The sensor read 160 mg\/dL then, 33% higher/);
    expect((await call('app/check', { token: tok('c'), method: 'POST', body: { kind: 'meter', value: 120 } })).status).toBe(403);
    const k = await (await call('app/check', { token: tok('a'), method: 'POST', body: { kind: 'ketone', value: 2.1 } })).json();
    expect(k).toMatchObject({ level: 'high' });
    expect(k.text).toMatch(/^Logged 2\.1 mmol\/L\. High \(1\.6 to 2\.9\)/);
    expect(pushed.map((p) => p.topic).sort()).toEqual(['c', 's']);
    expect(pushed[0].title).toBe('Ken: Ketones high: 2.1 mmol/L');
    const recent = await (await call('app/recent', { token: tok('a') })).json();
    expect(recent.checks.map((c) => c.kind).sort()).toEqual(['ketone', 'meter']);
    expect((await call('app/checks/remove', { token: tok('b'), method: 'POST', body: { id: k.id } })).status).toBe(403);   // not Mom's
    expect((await (await call('app/checks/remove', { token: tok('b'), method: 'POST', body: { id: r.id } })).json()).ok).toBe(true);
  });

  it('su94r Mini\'s medicine list and pills arrive; a pill deleted there goes here too; the export has everything', async () => {
    const sync = (body) => handleCgm('voice/sync', new Request('https://cgm.test/voice/sync?key=tv-key-123', { method: 'POST', body: JSON.stringify({ markers: [], ...body }) }), ENV, { screens, checks, night, store: { ready: true, async recent() { return []; }, async upsert() { return 0; }, async markDeleted() {} } });
    const t = Date.now() - 2 * 3600e3;
    await sync({ medList: [{ name: 'Metformin 500 mg', times: ['08:00', 'bad'] }, { name: 'Lantus', isInsulin: true }], medsPid: 'p1', medsTaken: [{ id: 'm1', p: 'p1', t, name: 'Metformin 500 mg' }, { id: 'm2', p: 'p1', t: t + 60e3, name: 'Metformin 500 mg' }] });
    expect(night.row.meds).toEqual([{ name: 'Metformin 500 mg', isInsulin: false, times: ['08:00'] }, { name: 'Lantus', isInsulin: true, times: [] }]);
    expect(checks.rows.map((r) => r.id)).toEqual(['mini-m1', 'mini-m2']);
    await sync({ medsPid: 'p1', medsTaken: [{ id: 'm1', p: 'p1', t, name: 'Metformin 500 mg' }] });
    expect(checks.rows.find((r) => r.id === 'mini-m2').deleted).toBe(true);
    expect((await (await call('app/meds', { token: tok('c') })).json()).meds).toEqual([{ name: 'Metformin 500 mg', times: ['08:00'] }]);
    await call('app/check', { token: tok('a'), method: 'POST', body: { kind: 'weight', value: 82.4 } });
    const csv = await (await call('app/export', { token: tok('c'), query: '?days=7' })).text();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('local time,iso time,type,value,unit,detail,source');
    expect(lines.slice(1).map((l) => l.split(',')[2])).toEqual(['pill', 'reading', 'weight']);
    expect((await call('export', { query: '?key=nope' })).status).toBe(401);
    expect((await call('export', { query: '?key=tv-key-123' })).headers.get('Content-Type')).toMatch(/text\/csv/);
  });

  it('the CSV quotes what needs quoting', async () => {
    const csv = await exportCsv('p1', { from: 0, to: Date.now() + 1, notes: { ready: true, async between() { return [{ t: 1000, text: 'pizza, then "dessert"', tags: ['eating-out'], by: 'Mom' }]; } }, tz: 'UTC' });
    expect(csv.split('\r\n')[1]).toBe('1970-01-01 00:00:01,1970-01-01T00:00:01.000Z,note,,,"pizza, then ""dessert"" · eating-out",Mom');
  });
});
