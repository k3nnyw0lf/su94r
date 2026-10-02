// Connecting su94r Mini to its server with its LibreLinkUp sign-in (no pasted link, no stored
// password). What must hold: the first connection only while the owner's window is open; then
// only the same LibreLinkUp account; the key su94r Mini gets works wherever the display key
// does; a wrong key is refused everywhere; the server reads LibreLinkUp with the handed-over
// session and keeps it fresh.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';

const NOW = Date.now();
const ACCOUNT_A = 'a'.repeat(64), ACCOUNT_B = 'b'.repeat(64);

function memScreens() {
  const rows = new Map();
  return {
    ready: true, rows,
    async insert(row) { rows.set(row.id, { ...row, revoked: false }); return [row]; },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
    async update(id, patch) { Object.assign(rows.get(id), patch); return []; },
    async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked).map(({ id, name, kind, last_seen }) => ({ id, name, kind, last_seen })); },
    async bySecret() { return null; }, async byCode() { return null; }, async sweep() {},
  };
}
function memOwner() {
  let row = null;
  return {
    ready: true,
    get row() { return row; },
    async get() { return row; },
    async claim(account_id, session) { row = { id: 1, account_id, session }; },
    async saveSession(session) { row.session = session; },
  };
}
function memInbox() {
  return { ready: true, async create() {}, async bySecret() { return null; }, async list() { return []; } };
}

// LibreLinkUp: tokens "tok-a…" belong to account A, "tok-b…" to account B; each call hands back a refreshed ticket.
let calls = 0;
function fakeLibre(url, init = {}) {
  const u = new URL(url);
  const h = init.headers || {};
  const token = (h.authorization || h.Authorization || '').replace('Bearer ', '');
  const res = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  const acct = token.startsWith('tok-a') ? ACCOUNT_A : token.startsWith('tok-b') ? ACCOUNT_B : null;
  if (!acct || h['account-id'] !== acct) return res({ status: 2, message: 'unauthorized' }, 401);
  calls++;
  const meas = { FactoryTimestamp: new Date(NOW).toLocaleString('en-US', { timeZone: 'UTC' }), ValueInMgPerDl: 133, GlucoseUnits: 1, TrendArrow: 3 };
  const conn = { patientId: acct === ACCOUNT_A ? 'p1' : 'p9', firstName: acct === ACCOUNT_A ? 'Ken' : 'Other', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: meas };
  const ticket = { token: `${token.slice(0, 5)}-refreshed-${calls}-xxxxxxxxxxxxxxxx`, expires: 1900000000 };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn], ticket });
  return res({ status: 0, data: { connection: conn, graphData: [] }, ticket });
}

const sessionA = { base: 'https://api-us.libreview.io', token: 'tok-a-original-xxxxxxxxxxxxxxxx', accountId: ACCOUNT_A, version: '4.16.0', expires: 1900000000 };
const sessionB = { ...sessionA, token: 'tok-b-original-xxxxxxxxxxxxxxxx', accountId: ACCOUNT_B };

let screens, owner, env;
const deps = () => ({ screens, inbox: memInbox() });
const call = (path, { method = 'GET', body, query = '' } = {}) =>
  handleCgm(path, new Request(`https://cgm.test/${path}${query}`, { method, body: body == null ? undefined : JSON.stringify(body) }), env, deps());

beforeEach(() => {
  resetCaches();
  calls = 0;
  screens = memScreens();
  owner = memOwner();
  // A server with no LibreLinkUp password and no display key: everything comes from connecting.
  env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk', OWNER_STORE: owner, CLAIM_OPEN_UNTIL: String(NOW + 15 * 60e3) };
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
});

describe('connecting su94r Mini', () => {
  it('status tells what is set up, without secrets', async () => {
    const s = await (await call('connect/status')).json();
    expect(s).toEqual({ owner: false, llu: 'none', alexa: false, open: true });
  });
  it('the first connection needs the owner\'s window to be open', async () => {
    env.CLAIM_OPEN_UNTIL = String(NOW - 1000);
    const r = await call('connect', { method: 'POST', body: { session: sessionA, name: 'Office' } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('closed');
    expect(owner.row).toBeNull();
    expect(calls).toBe(0);   // refused before the sign-in is used at all
  });
  it('binds the server to the account, keeps the session and hands back a key', async () => {
    const r = await (await call('connect', { method: 'POST', body: { session: sessionA, name: 'Office PC' } })).json();
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(r.people).toBe(1);
    expect(owner.row.account_id).toBe(ACCOUNT_A);
    expect(owner.row.session.token).toMatch(/^tok-a-refreshed/);   // LibreLinkUp's refreshed ticket is what is kept
    const [k] = [...screens.rows.values()];
    expect(k).toMatchObject({ kind: 'owner', name: 'Office PC' });
    expect(JSON.stringify(k)).not.toContain(r.key);
  });
  it('after that, only the same LibreLinkUp account connects (even with the window open)', async () => {
    await call('connect', { method: 'POST', body: { session: sessionA } });
    const before = calls;
    const other = await call('connect', { method: 'POST', body: { session: sessionB } });
    expect(other.status).toBe(403);
    expect((await other.json()).error).toBe('other-account');
    expect(calls).toBe(before);   // the other account's sign-in is never sent to LibreLinkUp
    env.CLAIM_OPEN_UNTIL = '0';
    const again = await (await call('connect', { method: 'POST', body: { session: sessionA, name: 'Laptop' } })).json();
    expect(again.key).toMatch(/^[0-9a-f]{64}$/);
    expect(screens.rows.size).toBe(2);
  });
  it('a sign-in LibreLinkUp refuses, or one shaped wrong, is refused', async () => {
    expect((await call('connect', { method: 'POST', body: { session: { ...sessionA, token: 'tok-z-forged-xxxxxxxxxxxxxxxxxx' } } })).status).toBe(401);
    expect((await call('connect', { method: 'POST', body: { session: { ...sessionA, accountId: ACCOUNT_B } } })).status).toBe(401);
    expect((await call('connect', { method: 'POST', body: { session: { ...sessionA, base: 'https://evil.test' } } })).status).toBe(400);
    expect(owner.row).toBeNull();
  });
});

describe('the key su94r Mini gets', () => {
  async function connected() {
    return (await (await call('connect', { method: 'POST', body: { session: sessionA, name: 'Office' } })).json()).key;
  }
  it('opens the big-screen data, read with the handed-over session (no password on the server)', async () => {
    const key = await connected();
    const d = await (await call('display/data', { query: `?key=${key}` })).json();
    expect(d.people[0]).toMatchObject({ name: 'Ken W', latest: { mg: 133 } });
  });
  it('works for screens, voice sync, inbox and connectors; a wrong key is refused on every one', async () => {
    const key = await connected();
    expect((await call('screens', { query: `?key=${key}` })).status).toBe(200);
    const bad = '0'.repeat(64);
    for (const [path, method] of [['screens', 'GET'], ['voice/sync', 'POST'], ['inbox/new', 'POST'], ['mcp/new', 'POST'], ['ns/new', 'POST'], ['pair/claim', 'POST'], ['display/data', 'GET']]) {
      const r = await call(path, { method, body: method === 'POST' ? {} : undefined, query: `?key=${bad}` });
      expect(r.status, `${path} with a wrong key`).toBe(401);
    }
  });
  it('keeps the server\'s LibreLinkUp session fresh', async () => {
    const key = await connected();
    const fresh = { ...sessionA, token: 'tok-a-newer-from-mini-xxxxxxxxxx' };
    expect((await call('connect/session', { method: 'POST', body: { session: fresh }, query: `?key=${key}` })).status).toBe(200);
    expect(owner.row.session.token).toMatch(/^tok-a-refreshed/);
    expect((await call('connect/session', { method: 'POST', body: { session: sessionB }, query: `?key=${key}` })).status).toBe(403);
    expect((await call('connect/session', { method: 'POST', body: { session: fresh }, query: '?key=nope' })).status).toBe(401);
  });
});
