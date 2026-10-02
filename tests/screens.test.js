// Pairing a screen or widget with a short code. What must hold: a code alone gives no
// data; only the display-key holder can claim a code; the screen gets its token once;
// a removed screen loses access at once; codes expire.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { normalCode, randomCode } from '../workers/screens.js';

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };

function memScreens() {
  const rows = new Map();
  const live = (r) => !r.revoked;
  return {
    ready: true,
    rows,
    async insert(row) {
      if ([...rows.values()].some((r) => r.code && r.code === row.code)) throw new Error('duplicate');
      rows.set(row.id, { created_at: new Date().toISOString(), claimed_at: null, last_seen: null, revoked: false, token_hash: null, token_once: null, ...row });
      return [rows.get(row.id)];
    },
    async bySecret(h) { return [...rows.values()].find((r) => r.secret_hash === h && live(r)) || null; },
    async byCode(c) { return [...rows.values()].find((r) => r.code === c && !r.claimed_at && live(r) && Date.parse(r.expires_at) > Date.now()) || null; },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && live(r)) || null; },
    async update(id, patch) { if (rows.has(id)) Object.assign(rows.get(id), patch); return []; },
    async list() { return [...rows.values()].filter((r) => r.claimed_at && live(r)).map(({ id, name, kind, created_at, claimed_at, last_seen }) => ({ id, name, kind, created_at, claimed_at, last_seen })); },
    async sweep() { for (const [id, r] of rows) if (!r.claimed_at && Date.parse(r.expires_at) < Date.now()) rows.delete(id); },
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

let screens;
const call = (path, { body, key, token, method = 'POST' } = {}) => handleCgm(path, new Request(`https://cgm.test/${path}${key ? `?key=${key}` : ''}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'GET' ? undefined : JSON.stringify(body || {}),
}), ENV, { screens });
const json = async (p) => (await p).json();

beforeEach(() => {
  resetCaches();
  screens = memScreens();
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
});

describe('pairing a screen with a code', () => {
  it('start → claim with the display key → the screen collects its token once → shows data', async () => {
    const start = await json(call('pair/start', { body: { name: 'Fridge' } }));
    expect(start.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(await json(call('pair/poll', { body: { secret: start.secret } }))).toEqual({ status: 'waiting', code: start.code });

    const claim = await json(call('pair/claim', { key: 'tv-key-123', body: { code: start.code.toLowerCase().replace('-', ' '), name: 'Kitchen fridge' } }));
    expect(claim).toEqual({ ok: true, name: 'Kitchen fridge' });

    const got = await json(call('pair/poll', { body: { secret: start.secret } }));
    expect(got.status).toBe('paired');
    expect(got.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await json(call('pair/poll', { body: { secret: start.secret } }))).token).toBeUndefined();   // only once

    const data = await call('screen/data', { method: 'GET', token: got.token });
    expect(data.status).toBe(200);
    const d = await data.json();
    expect(d.screen).toEqual({ name: 'Kitchen fridge', kind: 'screen' });
    expect(d.people[0].name).toBe('Ken W');
    expect(JSON.stringify(d)).not.toContain('p1');
  });

  it('a code alone gives nothing: claiming needs the display key', async () => {
    const start = await json(call('pair/start'));
    expect((await call('pair/claim', { key: 'wrong', body: { code: start.code } })).status).toBe(401);
    expect((await call('pair/claim', { body: { code: start.code } })).status).toBe(401);
    expect((await json(call('pair/poll', { body: { secret: start.secret } }))).status).toBe('waiting');
  });

  it('wrong or expired codes are refused with a clear message', async () => {
    expect((await json(call('pair/claim', { key: 'tv-key-123', body: { code: 'ABC-DEF' } }))).error).toMatch(/No screen is waiting/);
    expect((await json(call('pair/claim', { key: 'tv-key-123', body: { code: '12' } }))).error).toMatch(/does not look right/);
    const start = await json(call('pair/start'));
    for (const r of screens.rows.values()) r.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await json(call('pair/poll', { body: { secret: start.secret } }))).status).toBe('expired');
    expect((await json(call('pair/claim', { key: 'tv-key-123', body: { code: start.code } }))).ok).toBe(false);
  });

  it('a removed screen loses access at once, and the list shows only live screens', async () => {
    const start = await json(call('pair/start'));
    await call('pair/claim', { key: 'tv-key-123', body: { code: start.code, name: 'TV' } });
    const { token } = await json(call('pair/poll', { body: { secret: start.secret } }));
    const list = await json(call('screens', { method: 'GET', key: 'tv-key-123' }));
    expect(list.screens.map((s) => s.name)).toEqual(['TV']);
    await call('screens/remove', { key: 'tv-key-123', body: { id: list.screens[0].id } });
    expect((await call('screen/data', { method: 'GET', token })).status).toBe(401);
    expect((await json(call('screens', { method: 'GET', key: 'tv-key-123' }))).screens).toEqual([]);
  });

  it('screen data needs a real token', async () => {
    expect((await call('screen/data', { method: 'GET' })).status).toBe(401);
    expect((await call('screen/data', { method: 'GET', token: 'f'.repeat(64) })).status).toBe(401);
  });

  it('codes are easy to read and type', () => {
    for (let i = 0; i < 50; i++) expect(randomCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{3}-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{3}$/);
    expect(normalCode(' k7q 4md ')).toBe('K7Q-4MD');
    expect(normalCode('K7Q-0MD')).toBeNull();
  });
});
