// The health inbox (phone apps post, su94r Mini collects) and the AI connector (MCP).
// What must hold: only the display key makes or removes an inbox or a connector; a phone app
// needs only its address; su94r Mini collects in order and the server forgets what it acked;
// the connector answers MCP with read-only tools and refuses anyone without its token.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';

const NOW = Date.now();
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };

function memInbox() {
  const boxes = new Map(), items = [];
  let next = 1;
  return {
    ready: true, boxes, all: items,
    async create(row) { boxes.set(row.id, { ...row, revoked: false, created_at: new Date().toISOString() }); return [row]; },
    async bySecret(h) { return [...boxes.values()].find((b) => b.secret_hash === h && !b.revoked) || null; },
    async list() { return [...boxes.values()].filter((b) => !b.revoked).map(({ id, name, created_at, last_post_at }) => ({ id, name, created_at, last_post_at })); },
    async revoke(id) { if (boxes.has(id)) boxes.get(id).revoked = true; },
    async touch(id) { boxes.get(id).last_post_at = new Date().toISOString(); },
    async add(inboxId, body) { items.push({ id: next++, inbox_id: inboxId, received_at: new Date().toISOString(), body }); },
    async count(inboxId) { return items.filter((i) => i.inbox_id === inboxId).length; },
    async countSince(inboxId, since) { return items.filter((i) => i.inbox_id === inboxId && Date.parse(i.received_at) > since).length; },
    async items(inboxId, limit) { return items.filter((i) => i.inbox_id === inboxId).slice(0, limit); },
    async dropIds(inboxId, ids) { for (let i = items.length - 1; i >= 0; i--) if (items[i].inbox_id === inboxId && ids.includes(items[i].id)) items.splice(i, 1); },
    async dropAll(inboxId) { for (let i = items.length - 1; i >= 0; i--) if (items[i].inbox_id === inboxId) items.splice(i, 1); },
    async expireAll() {},
  };
}

function memScreens() {
  const rows = new Map();
  return {
    ready: true, rows,
    async insert(row) { rows.set(row.id, { ...row, revoked: false }); return [row]; },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
    async update(id, patch) { Object.assign(rows.get(id), patch); return []; },
    async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
    async bySecret() { return null; }, async byCode() { return null; }, async sweep() {},
  };
}

function memDoses() {
  return {
    ready: true,
    async recent() { return [{ id: 'd1', pid: 'p1', t: NOW - 30 * 60e3, kind: 'short', amount: 4, source: 'alexa' }]; },
    async upsert() { return 0; }, async markDeleted() {},
  };
}

function fakeLibre(url) {
  const u = new URL(url);
  const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
  const meas = { FactoryTimestamp: new Date(NOW).toLocaleString('en-US', { timeZone: 'UTC' }), ValueInMgPerDl: 142, GlucoseUnits: 1, TrendArrow: 4 };
  const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: meas };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  const graphData = [3, 2, 1].map((h) => ({ ...meas, FactoryTimestamp: new Date(NOW - h * 3600e3).toLocaleString('en-US', { timeZone: 'UTC' }), ValueInMgPerDl: 100 + h * 20 }));
  return res({ status: 0, data: { connection: conn, graphData } });
}

let inbox, screens;
const deps = () => ({ inbox, screens, store: memDoses() });
const call = (path, { method = 'GET', body, headers = {}, query = '' } = {}) =>
  handleCgm(path, new Request(`https://cgm.test/${path}${query}`, { method, headers, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), ENV, deps());

beforeEach(() => {
  resetCaches();
  inbox = memInbox();
  screens = memScreens();
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
});

describe('health inbox', () => {
  it('only the display key makes an inbox; both keys are returned once and only their hashes kept', async () => {
    expect((await call('inbox/new', { method: 'POST', body: { name: 'Pixel' }, query: '?key=wrong' })).status).toBe(401);
    const r = await (await call('inbox/new', { method: 'POST', body: { name: 'Pixel <b>' }, query: '?key=tv-key-123' })).json();
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(r.key).not.toBe(r.secret);
    expect(r.name).toBe('Pixel b');
    const [box] = [...inbox.boxes.values()];
    expect(JSON.stringify(box)).not.toContain(r.secret);
    expect(JSON.stringify(box)).not.toContain(r.key);
  });
  it('the phone posts with the send key; only the collector key reads and acks exact items', async () => {
    const { secret, key } = await (await call('inbox/new', { method: 'POST', body: {}, query: '?key=tv-key-123' })).json();
    expect((await call(`inbox/${secret}`, { method: 'POST', body: { steps: [{ count: 900 }] } })).status).toBe(200);
    expect((await call('inbox', { method: 'POST', body: { weight: [{ kilograms: 83 }] }, headers: { 'X-Api-Key': secret } })).status).toBe(200);
    expect((await call(`inbox/${secret}`, { method: 'POST', body: 'not json' })).status).toBe(400);
    // The address alone cannot read or delete anything.
    expect((await call(`inbox/${secret}/items`)).status).toBe(401);
    expect((await call('inbox/items', { headers: { 'X-Api-Key': secret, 'X-Collector-Key': 'f'.repeat(64) } })).status).toBe(401);
    expect((await call(`inbox/${secret}/ack`, { method: 'POST', body: { ids: [1] } })).status).toBe(401);
    const got = await (await call('inbox/items', { headers: { 'X-Api-Key': secret, 'X-Collector-Key': key } })).json();
    expect(got.items.map((i) => Object.keys(i.body)[0])).toEqual(['steps', 'weight']);
    await call('inbox/ack', { method: 'POST', body: { ids: [got.items[1].id] }, headers: { 'X-Api-Key': secret, 'X-Collector-Key': key } });
    const left = await (await call('inbox/items', { headers: { 'X-Api-Key': secret, 'X-Collector-Key': key } })).json();
    expect(left.items.map((i) => Object.keys(i.body)[0])).toEqual(['steps']);
  });
  it('limits: post size, posts per hour', async () => {
    const { secret } = await (await call('inbox/new', { method: 'POST', body: {}, query: '?key=tv-key-123' })).json();
    expect((await call(`inbox/${secret}`, { method: 'POST', body: JSON.stringify({ x: 'é'.repeat(600 * 1024) }) })).status).toBe(413);
    for (let i = 0; i < 120; i++) await call(`inbox/${secret}`, { method: 'POST', body: { i } });
    expect((await call(`inbox/${secret}`, { method: 'POST', body: { i: 'one more' } })).status).toBe(429);
  });
  it('a wrong or removed address gets nothing, and a removed inbox loses its items at once', async () => {
    const { id, secret, key } = await (await call('inbox/new', { method: 'POST', body: {}, query: '?key=tv-key-123' })).json();
    await call(`inbox/${secret}`, { method: 'POST', body: { a: 1 } });
    expect((await call(`inbox/${'0'.repeat(64)}`, { method: 'POST', body: {} })).status).toBe(401);
    await call('inboxes/remove', { method: 'POST', body: { id }, query: '?key=tv-key-123' });
    expect(inbox.all.length).toBe(0);
    expect((await call(`inbox/${secret}`, { method: 'POST', body: {} })).status).toBe(401);
    expect((await call('inbox/items', { headers: { 'X-Api-Key': secret, 'X-Collector-Key': key } })).status).toBe(401);
  });
  it('lists inboxes without their secrets', async () => {
    await call('inbox/new', { method: 'POST', body: { name: 'Pixel' }, query: '?key=tv-key-123' });
    const r = await (await call('inboxes', { query: '?key=tv-key-123' })).json();
    expect(r.inboxes).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
  });
});

describe('AI connector (MCP)', () => {
  const rpc = (token, msg) => call(`mcp/${token}`, { method: 'POST', body: msg, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
  async function newToken() {
    return (await (await call('mcp/new', { method: 'POST', body: { name: 'Claude' }, query: '?key=tv-key-123' })).json()).token;
  }
  it('only the display key makes a connector, and it is listed with the screens', async () => {
    expect((await call('mcp/new', { method: 'POST', body: {}, query: '?key=nope' })).status).toBe(401);
    const token = await newToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const list = await (await call('screens', { query: '?key=tv-key-123' })).json();
    expect(list.screens.map((s) => [s.name, s.kind])).toEqual([['Claude', 'ai']]);
  });
  it('speaks MCP: initialize, tools/list, notifications', async () => {
    const token = await newToken();
    const init = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude' } } })).json();
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeTruthy();
    expect(init.result.instructions).toMatch(/do not give insulin dosing instructions/);
    expect((await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const tools = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(tools.result.tools.map((t) => t.name)).toEqual(['glucose_now', 'glucose_history', 'insulin_doses']);
    expect(tools.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
  it('answers the tools from live data', async () => {
    const token = await newToken();
    const now = await (await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'glucose_now', arguments: {} } })).json();
    expect(now.result.structuredContent.result[0]).toMatchObject({ person: 'Ken', glucose_mg_dl: 142, trend: 'rising', target_range_mg_dl: [70, 180] });
    const hist = await (await rpc(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'glucose_history', arguments: { hours: 4 } } })).json();
    expect(hist.result.structuredContent.result[0].readings.length).toBe(4);
    const doses = await (await rpc(token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'insulin_doses', arguments: {} } })).json();
    expect(doses.result.structuredContent.result[0]).toMatchObject({ person: 'Ken', units: 4, insulin: 'regular', logged_by: 'Alexa' });
  });
  it('an AI token cannot read the screen feeds', async () => {
    const token = await newToken();
    expect((await call('screen/data', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await call('screen/glance', { query: `?token=${token}` })).status).toBe(401);
  });
  it('refuses without the token, or with a screen token', async () => {
    expect((await rpc('f'.repeat(64), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    screens.rows.set('s1', { id: 's1', kind: 'screen', token_hash: 'x', claimed_at: 'now' });
    expect((await call('mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { Authorization: 'Bearer abc' } })).status).toBe(401);
  });
  it('unknown methods and tools are JSON-RPC errors', async () => {
    const token = await newToken();
    expect((await (await rpc(token, { jsonrpc: '2.0', id: 9, method: 'nope' })).json()).error.code).toBe(-32601);
    expect((await (await rpc(token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'dose_me' } })).json()).error.code).toBe(-32602);
  });
});

describe('proxy keeps link secrets out of request logs', () => {
  it('moves inbox, connector and widget secrets from the link into headers', async () => {
    const { moveSecrets } = await import('../workers/proxy.js');
    const s = 'ab'.repeat(32);
    let h = new Headers();
    expect(moveSecrets(new URL(`https://p.test/inbox/${s}`), h)).toBe('/inbox');
    expect(h.get('x-api-key')).toBe(s);
    h = new Headers();
    expect(moveSecrets(new URL(`https://p.test/inbox/${s}/items`), h)).toBe('/inbox/items');
    h = new Headers();
    expect(moveSecrets(new URL(`https://p.test/mcp/${s}`), h)).toBe('/mcp');
    expect(h.get('authorization')).toBe(`Bearer ${s}`);
    h = new Headers();
    expect(moveSecrets(new URL(`https://p.test/ns/api/v1/entries/sgv.json?count=5&token=${s}`), h)).toBe('/ns/api/v1/entries/sgv.json?count=5');
    expect(h.get('x-ns-token')).toBe(s);
    h = new Headers();
    expect(moveSecrets(new URL(`https://p.test/screen/glance?token=${s}&n=1`), h)).toBe('/screen/glance?n=1');
    expect(h.get('authorization')).toBe(`Bearer ${s}`);
    // su94r Mini's key and display keys too (they were showing up in the server's request logs).
    h = new Headers();
    expect(moveSecrets(new URL('https://p.test/display/data?key=abc&x=1'), h)).toBe('/display/data?x=1');
    expect(h.get('x-su94r-key')).toBe('abc');
  });
});
