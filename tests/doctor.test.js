// The doctor's live link (workers/doctor.js). What must hold: only the display key (or su94r
// Mini's key) makes a link; the link reads the 14-day report and nothing else (no live glucose,
// no screen feeds); a screen's token cannot read the report; an expired or removed link stops
// at once; the report comes from the server's own history and the logged doses.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { doctorData, doctorPage } from '../workers/doctor.js';
import { sha256 } from '../workers/screens.js';

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const MIN = 60e3, DAY = 864e5;

function memScreens() {
  const rows = new Map();
  return {
    ready: true,
    rows,
    async insert(row) { rows.set(row.id, { created_at: new Date().toISOString(), last_seen: null, revoked: false, ...row }); return [rows.get(row.id)]; },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
    async update(id, patch) { if (rows.has(id)) Object.assign(rows.get(id), patch); return []; },
    async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
  };
}

function fakeLibre(url) {
  const u = new URL(url);
  const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.b.c', expires: 1900000000 } } });
  const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  return res({ status: 0, data: { connection: conn, graphData: [] } });
}

// 10 days of readings every 15 minutes: 10% of them low.
const now = Date.now();
const points = [];
for (let t = now - 10 * DAY, i = 0; t < now; t += 15 * MIN, i++) points.push({ t, mg: i % 10 === 0 ? 60 : 130 });
const history = { ready: true, asked: [], async range(pid, from, to) { this.asked.push(pid); return pid === 'p1' ? points.filter((p) => p.t >= from && p.t < to) : []; } };
const doses = { ready: true, async between(pid) { return pid === 'p1' ? [{ id: 'a', pid, t: now - DAY, kind: 'rapid', amount: 4 }, { id: 'b', pid, t: now - DAY, kind: 'carbs', amount: 40 }] : []; } };

let screens;
const call = (path, { body, key, token, method = 'POST' } = {}) => handleCgm(path, new Request(`https://cgm.test/${path}${key ? `?key=${key}` : ''}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'GET' ? undefined : JSON.stringify(body || {}),
}), ENV, { screens, history, store: doses });

beforeEach(() => {
  resetCaches();
  screens = memScreens();
  history.asked = [];
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
});

describe('making a doctor link', () => {
  it('needs the display key; keeps only a hash; reports on the first person; expires in 30 days', async () => {
    expect((await call('doctor/new', { body: { name: 'Dr. Lee' } })).status).toBe(401);
    expect((await call('doctor/new', { key: 'wrong', body: { name: 'Dr. Lee' } })).status).toBe(401);
    const r = await (await call('doctor/new', { key: 'tv-key-123', body: { name: 'Dr. Lee <b>' } })).json();
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(r.expiresAt) - Date.now()).toBeGreaterThan(29.9 * DAY);
    const row = [...screens.rows.values()][0];
    expect(row).toMatchObject({ kind: 'doctor', pid: 'p1', name: 'Dr. Lee b', token_hash: await sha256(r.token) });
    expect(JSON.stringify(row)).not.toContain(r.token);
  });

  it('at most 90 days', async () => {
    const r = await (await call('doctor/new', { key: 'tv-key-123', body: { days: 400 } })).json();
    expect(Date.parse(r.expiresAt) - Date.now()).toBeLessThan(90.1 * DAY);
  });
});

describe('what the link can read', () => {
  it('the 14-day report from the server history and logged doses', async () => {
    const { token } = await (await call('doctor/new', { key: 'tv-key-123', body: { name: 'Dr. Lee' } })).json();
    const res = await call('doctor/data', { method: 'GET', token });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(history.asked).toEqual(['p1']);
    expect(d).toMatchObject({ person: 'Ken', units: 'mg/dL', low: 70, high: 180, label: 'Dr. Lee' });
    expect(d.ranges.inRange).toBeCloseTo(0.9, 2);
    expect(d.ranges.low + d.ranges.veryLow).toBeCloseTo(0.1, 2);
    expect(d.insulin.rapid).toMatchObject({ doses: 1, units: 4 });
    expect(d.meals.count).toBe(1);
    expect(d.profile).toHaveLength(96);
  });

  it('never the live glucose or the screen feeds; a screen token never reads the report', async () => {
    const { token } = await (await call('doctor/new', { key: 'tv-key-123', body: {} })).json();
    expect((await call('screen/data', { method: 'GET', token })).status).toBe(401);
    expect((await call('screen/glance', { method: 'GET', token })).status).toBe(401);
    expect((await call('share/extras', { method: 'GET', token })).status).toBe(401);
    expect((await call('screens', { method: 'GET', key: token })).status).toBe(401);
    const tv = 'a'.repeat(64);
    await screens.insert({ id: 'tv', token_hash: await sha256(tv), kind: 'screen', claimed_at: new Date().toISOString(), expires_at: new Date().toISOString() });
    expect((await call('doctor/data', { method: 'GET', token: tv })).status).toBe(401);
    expect((await call('doctor/data', { method: 'GET' })).status).toBe(401);
  });

  it('stops at once when removed in su94r Mini, and when it expires', async () => {
    const { token } = await (await call('doctor/new', { key: 'tv-key-123', body: {} })).json();
    const row = [...screens.rows.values()][0];
    await call('screens/remove', { key: 'tv-key-123', body: { id: row.id } });
    expect((await call('doctor/data', { method: 'GET', token })).status).toBe(401);
    const old = { kind: 'doctor', pid: 'p1', expires_at: new Date(now - MIN).toISOString() };
    expect(await doctorData(old, { history, doses, snapshot: async () => ({ people: [] }) })).toBeNull();
  });
});

describe('the page', () => {
  it('holds no data or token, loads the report with the token from its own address', () => {
    const html = doctorPage();
    expect(html).toContain("fetch('/doctor/data'");
    expect(html).toContain("'Bearer '+token");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain('This link has ended');
  });
});
