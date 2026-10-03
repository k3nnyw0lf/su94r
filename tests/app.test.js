// The su94r phone app (workers/app.js routes, su94r-proxy /app/ files and /app/meal). What must
// hold: only a phone linked by a share code gets in (not a TV, a widget, a doctor link or an AI
// connector); a family member's phone reads, and logs only once the owner allows it; logging a second dose asks first;
// a phone can undo only its own dose, and only for 30 minutes; meal photos cost AI only for the
// owner's own phone; the built files match their sources.

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';
import proxy from '../workers/proxy.js';
import { buildAssets } from '../scripts/build-app.mjs';

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const MIN = 60e3, DAY = 864e5;
const tok = (c) => c.repeat(64);

function memScreens() {
  const rows = new Map();
  return {
    ready: true, rows,
    async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, ...row }); return [rows.get(row.id)]; },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
    async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); return []; },
    async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
    async allowLog(id, canLog) { const r = rows.get(id); if (!r || r.kind !== 'screen' || r.role !== 'family' || r.revoked) return false; r.can_log = canLog === true; return true; },
  };
}
function memDoses() {
  const rows = [];
  return {
    ready: true, rows,
    async recent(pid, now = Date.now()) { return rows.filter((d) => !d.deleted && d.t >= now - 2 * DAY && (!pid || d.pid === pid)); },
    async between(pid, from, to) { return rows.filter((d) => !d.deleted && d.pid === pid && d.t >= from && d.t < to); },
    async upsert(list) { const ok = list.filter(valid); for (const d of ok) { const i = rows.findIndex((r) => r.id === d.id); if (i >= 0) rows[i] = { ...rows[i], ...d }; else rows.push({ ...d, deleted: false }); } return ok.length; },
    async markDeleted(ids) { for (const r of rows) if (ids.includes(r.id)) r.deleted = true; },
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

const now = Date.now();
const points = [];
for (let t = now - 30 * DAY; t < now; t += 5 * MIN) points.push({ t, mg: 120 });
const history = { ready: true, async range(pid, from, to) { return pid === 'p1' ? points.filter((p) => p.t >= from && p.t < to) : []; } };
let screens, doses, forecasts;
const call = (p, { token, method = 'GET', body, query = '' } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${query}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'GET' ? undefined : JSON.stringify(body || {}),
}), ENV, { screens, history, store: doses, forecasts });
const add = async (id, c, extra) => screens.insert({ id, token_hash: await sha256(tok(c)), claimed_at: new Date().toISOString(), expires_at: new Date(now + DAY).toISOString(), ...extra });

beforeEach(async () => {
  resetCaches();
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
  screens = memScreens();
  doses = memDoses();
  forecasts = { ready: true, map: {}, async get(pid) { return this.map[pid] || null; } };
  await add('aaaaaaaa-1111', 'a', { kind: 'screen', role: 'me', name: 'Ken phone' });
  await add('bbbbbbbb-2222', 'b', { kind: 'screen', role: 'family', name: 'Mom' });
  await add('cccccccc-3333', 'c', { kind: 'screen', name: 'Kitchen TV' });
  await add('dddddddd-4444', 'd', { kind: 'widget', name: 'Watch' });
  await add('eeeeeeee-5555', 'e', { kind: 'doctor', pid: 'p1', name: 'Dr' });
  await add('ffffffff-6666', 'f', { kind: 'ai', name: 'Claude' });
});

describe('who gets into the app', () => {
  it('a linked phone, owner or family; not a TV, widget, doctor link or AI connector', async () => {
    expect(await (await call('app/me', { token: tok('a') })).json()).toMatchObject({ role: 'me', canLog: true, people: [{ pid: 'p1', name: 'Ken', low: 70, high: 180 }] });
    expect(await (await call('app/me', { token: tok('b') })).json()).toMatchObject({ role: 'family', canLog: false });
    for (const c of ['c', 'd', 'e', 'f', '0']) expect((await call('app/me', { token: tok(c) })).status).toBe(401);
    expect((await call('app/me')).status).toBe(401);
  });
});

describe('reading', () => {
  it('history from the server, 1 to 90 days, thinned past two weeks', async () => {
    const d1 = await (await call('app/history', { token: tok('b'), query: '?days=1' })).json();
    expect(d1.days).toBe(1);
    expect(d1.points.p1.length).toBeGreaterThan(280);
    const d30 = await (await call('app/history', { token: tok('a'), query: '?days=30' })).json();
    expect(d30.points.p1.length).toBeLessThan(30 * 96 + 2);
    expect((await (await call('app/history', { token: tok('a'), query: '?days=900' })).json()).days).toBe(90);
  });

  it('the 14-day report', async () => {
    const r = await (await call('app/report', { token: tok('b') })).json();
    expect(r).toMatchObject({ person: 'Ken', units: 'mg/dL' });
    expect(r.ranges.inRange).toBe(1);
    expect(r.label).toBeUndefined();
  });

  it('recent doses, and only fresh, trusted estimates', async () => {
    forecasts.map.p1 = { p: 'p1', at: now - 5 * MIN, trusted: true, mg: 120, h30: { mg: 130, lo: 110, hi: 150 } };
    const r = await (await call('app/recent', { token: tok('b') })).json();
    expect(r.estimates.p1).toMatchObject({ mg: 120, h30: { mg: 130 } });
    forecasts.map.p1 = { ...forecasts.map.p1, at: now - 40 * MIN };
    expect((await (await call('app/recent', { token: tok('b') })).json()).estimates).toEqual({});
    forecasts.map.p1 = { p: 'p1', at: now, trusted: false };
    expect((await (await call('app/recent', { token: tok('b') })).json()).estimates).toEqual({});
  });
});

describe('logging', () => {
  it('a family member\'s phone never logs', async () => {
    const r = await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'rapid', amount: 4 } });
    expect(r.status).toBe(403);
    expect(doses.rows).toHaveLength(0);
  });

  it('checks the amount, the kind and the time', async () => {
    for (const body of [{ kind: 'rapid', amount: 0 }, { kind: 'rapid', amount: 150 }, { kind: 'carbs', amount: 400 }, { kind: 'coffee', amount: 1 }, { kind: 'rapid', amount: 2, minutesAgo: 3000 }]) {
      expect((await call('app/log', { token: tok('a'), method: 'POST', body })).status).toBe(400);
    }
    expect(doses.rows).toHaveLength(0);
  });

  it('logs with source "phone"; a second rapid dose asks first, then logs when confirmed', async () => {
    const first = await (await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'rapid', amount: 4.3 } })).json();
    expect(first).toMatchObject({ ok: true, text: 'Logged 4.5 units of rapid insulin.' });
    expect(doses.rows[0]).toMatchObject({ pid: 'p1', kind: 'rapid', amount: 4.5, source: 'phone' });
    expect(doses.rows[0].id).toMatch(/^app-aaaaaaaa-/);
    const again = await (await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'rapid', amount: 4 } })).json();
    expect(again).toMatchObject({ ok: false, confirm: true });
    expect(again.warning).toMatch(/You already logged 4.5 u rapid/);
    expect(doses.rows).toHaveLength(1);
    vi.useFakeTimers({ now: now + 1000, toFake: ['Date'] });
    const yes = await (await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'rapid', amount: 4, confirm: true } })).json();
    vi.useRealTimers();
    expect(yes.ok).toBe(true);
    expect(doses.rows).toHaveLength(2);
    const carbs = await (await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'carbs', amount: 45, minutesAgo: 20 } })).json();
    expect(carbs).toMatchObject({ ok: true, text: 'Logged 45 g of carbs, 20 min ago.' });
  });

  it('undo: only this phone\'s own dose, only for 30 minutes; the list marks which', async () => {
    const r = await (await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'basal', amount: 18 } })).json();
    doses.rows.push({ id: 'ext-1', pid: 'p1', t: now - MIN, kind: 'rapid', amount: 2, source: 'extension', deleted: false });
    const list = await (await call('app/recent', { token: tok('a') })).json();
    expect(list.events.find((e) => e.id === r.id).mine).toBe(true);
    expect(list.events.find((e) => e.id === 'ext-1').mine).toBe(false);
    expect((await call('app/undo', { token: tok('a'), method: 'POST', body: { id: 'ext-1' } })).status).toBe(400);
    const old = `app-aaaaaaaa-${(now - 31 * MIN).toString(36)}`;
    expect((await call('app/undo', { token: tok('a'), method: 'POST', body: { id: old } })).status).toBe(400);
    expect((await call('app/undo', { token: tok('b'), method: 'POST', body: { id: r.id } })).status).toBe(403);
    expect(await (await call('app/undo', { token: tok('a'), method: 'POST', body: { id: r.id } })).json()).toEqual({ ok: true });
    expect(doses.rows.find((d) => d.id === r.id).deleted).toBe(true);
  });

  it('phone doses reach su94r Mini with the other non-computer doses', async () => {
    await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'carbs', amount: 30 } });
    const r = await (await call('voice/sync', { method: 'POST', query: '?key=tv-key-123', body: { markers: [], removed: [] } })).json();
    expect(r.doses).toEqual([expect.objectContaining({ type: 'meal', amount: 30, source: 'phone' })]);
  });
});

describe('family members who live with the owner', () => {
  it('a family phone logs once allowed, and undoes its own dose; the list says which phone logged', async () => {
    expect((await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'carbs', amount: 30 } })).status).toBe(403);
    screens.rows.get('bbbbbbbb-2222').can_log = true;
    expect(await (await call('app/me', { token: tok('b') })).json()).toMatchObject({ role: 'family', canLog: true });
    const r = await (await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'carbs', amount: 30 } })).json();
    expect(r.ok).toBe(true);
    expect(r.id).toMatch(/^app-bbbbbbbb-/);
    const list = await (await call('app/recent', { token: tok('a') })).json();
    expect(list.events[0]).toMatchObject({ source: 'phone', by: 'Mom', mine: false });
    expect((await call('app/undo', { token: tok('a'), method: 'POST', body: { id: r.id } })).status).toBe(400);
    expect(await (await call('app/undo', { token: tok('b'), method: 'POST', body: { id: r.id } })).json()).toEqual({ ok: true });
  });

  it('a family member\'s dose gets the same double-dose check', async () => {
    screens.rows.get('bbbbbbbb-2222').can_log = true;
    await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'rapid', amount: 4 } });
    const second = await (await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'rapid', amount: 4 } })).json();
    expect(second).toMatchObject({ ok: false, confirm: true });
  });

  it('the owner\'s phone lists family phones and allows or stops them; nobody else can', async () => {
    const list = await (await call('app/phones', { token: tok('a') })).json();
    expect(list.phones).toEqual([{ id: 'bbbbbbbb-2222', name: 'Mom', canLog: false, lastSeen: null }]);
    expect((await call('app/phones', { token: tok('b') })).status).toBe(403);
    expect((await call('app/phones/allow', { token: tok('b'), method: 'POST', body: { id: 'bbbbbbbb-2222', canLog: true } })).status).toBe(403);
    expect(await (await call('app/phones/allow', { token: tok('a'), method: 'POST', body: { id: 'bbbbbbbb-2222', canLog: true } })).json()).toEqual({ ok: true, canLog: true });
    expect(screens.rows.get('bbbbbbbb-2222').can_log).toBe(true);
    for (const id of ['cccccccc-3333', 'dddddddd-4444', 'eeeeeeee-5555', 'aaaaaaaa-1111']) {
      expect((await call('app/phones/allow', { token: tok('a'), method: 'POST', body: { id, canLog: true } })).status).toBe(404);
    }
    await call('app/phones/allow', { token: tok('a'), method: 'POST', body: { id: 'bbbbbbbb-2222', canLog: false } });
    expect((await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'carbs', amount: 10 } })).status).toBe(403);
  });

  it('su94r Mini allows it with its key, and can tick it when making a family code', async () => {
    expect((await call('screens/allow', { method: 'POST', body: { id: 'bbbbbbbb-2222', canLog: true } })).status).toBe(401);
    expect(await (await call('screens/allow', { method: 'POST', query: '?key=tv-key-123', body: { id: 'bbbbbbbb-2222', canLog: true } })).json()).toEqual({ ok: true, canLog: true });
    expect((await call('screens/allow', { method: 'POST', query: '?key=tv-key-123', body: { id: 'cccccccc-3333', canLog: true } })).status).toBe(404);
    screens.sweep = async () => {};
    const fam = await (await call('share/new', { method: 'POST', query: '?key=tv-key-123', body: { role: 'family', canLog: true } })).json();
    expect(fam.canLog).toBe(true);
    expect([...screens.rows.values()].at(-1)).toMatchObject({ role: 'family', can_log: true });
    const mine = await (await call('share/new', { method: 'POST', query: '?key=tv-key-123', body: { role: 'me', canLog: true } })).json();
    expect(mine.canLog).toBe(false);
  });
});

describe('su94r-proxy: the app files and meal photos', () => {
  const env = { CGM_URL: 'https://cgm.test/functions/v1/su94r-cgm' };
  it('serves the page with a strict policy, the script with the shared report code, icons and manifest', async () => {
    const red = await proxy.fetch(new Request('https://p.test/app?x=1'), env);
    expect(red.status).toBe(301);
    expect(red.headers.get('location')).toBe('https://p.test/app/?x=1');
    const page = await proxy.fetch(new Request('https://p.test/app/'), env);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self';/);
    expect(await page.text()).toContain('<script src="/app/app.js"></script>');
    const js = await (await proxy.fetch(new Request('https://p.test/app/app.js'), env)).text();
    expect(js).toContain('function reportHtml(d,lang)');
    expect(js).toContain("api('app/log'");
    const png = await proxy.fetch(new Request('https://p.test/app/icon-192.png'), env);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await png.arrayBuffer()).slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    const m = await (await proxy.fetch(new Request('https://p.test/app/manifest.webmanifest'), env)).json();
    expect(m).toMatchObject({ start_url: '/app/', display: 'standalone' });
    expect(await (await proxy.fetch(new Request('https://p.test/app/nope'), env)).text()).toBe('su94r CGM proxy alive');
  });

  it('forwards the app data routes with the phone\'s token', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { seen.push({ url, init }); return new Response('{}', { status: 200 }); }));
    await proxy.fetch(new Request('https://p.test/app/history?days=7', { headers: { Authorization: `Bearer ${tok('a')}` } }), env);
    expect(seen[0].url).toBe('https://cgm.test/functions/v1/su94r-cgm/app/history?days=7');
    expect(seen[0].init.headers.get('authorization')).toBe(`Bearer ${tok('a')}`);
  });

  it('meal photos: the owner\'s phone only; the answer is checked', async () => {
    const ai = { calls: 0, async run() { this.calls++; return { response: '{"food":true,"items":[{"name":"rice","carbs_g":45}],"total_g":45,"low_g":35,"high_g":60,"confidence":"medium"}' }; } };
    const who = { [`Bearer ${tok('a')}`]: { canLog: true }, [`Bearer ${tok('b')}`]: { canLog: false } };
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { const w = who[init.headers.authorization]; return w ? new Response(JSON.stringify(w), { status: 200 }) : new Response('{}', { status: 401 }); }));
    const send = (t) => proxy.fetch(new Request('https://p.test/app/meal', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' }) }), { ...env, AI: ai });
    expect((await send()).status).toBe(401);
    expect((await send(tok('9'))).status).toBe(401);
    expect((await send(tok('b'))).status).toBe(403);
    expect(ai.calls).toBe(0);
    const r = await (await send(tok('a'))).json();
    expect(r.meal).toMatchObject({ food: true, total: 45, low: 35, high: 60, items: [{ name: 'rice', carbs: 45 }] });
  });
});

describe('the built app', () => {
  it('workers/app-assets.js matches workers/app/* (run node scripts/build-app.mjs)', () => {
    const built = fs.readFileSync(path.join(import.meta.dirname, '..', 'workers', 'app-assets.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(built).toBe(buildAssets());
  });
});
