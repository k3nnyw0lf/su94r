// The Nightscout-compatible feed (watch faces, GlucoDataHandler, xDrip+) and the Echo Show line.
import { describe, it, expect } from 'vitest';
import { nightscoutRoute } from '../workers/nightscout.js';
import { sparkGraphic } from '../workers/alexa.js';

const NOW = Date.now();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function memScreens() {
  const rows = new Map();
  return {
    ready: true, rows,
    async insert(row) { rows.set(row.id, { ...row, revoked: false }); return [row]; },
    async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
    async bySecret(h) { return [...rows.values()].find((r) => r.secret_hash === h && !r.revoked) || null; },
    async update(id, patch) { Object.assign(rows.get(id), patch); },
  };
}

const person = {
  pid: 'p1', name: 'Ken W', firstName: 'Ken', units: 'mg/dL', low: 70, high: 180,
  latest: { t: NOW - 60e3, mg: 142, trend: 4 },
  history: [
    { t: NOW - 45 * 60e3, mg: 118 }, { t: NOW - 30 * 60e3, mg: 125 }, { t: NOW - 15 * 60e3, mg: 136 }, { t: NOW - 60e3, mg: 142, trend: 4 },
  ],
};
const snapshot = async () => ({ people: [person] });
const ENV = { DISPLAY_KEY: 'k' };
const keyOk = (k) => k === 'k';

async function setup() {
  const screens = memScreens();
  const route = (path, { method = 'GET', query = '', headers = {}, body } = {}) => {
    const url = new URL(`https://s.test/${path}${query}`);
    return nightscoutRoute(path, new Request(url, { method, headers, body: body && JSON.stringify(body) }), url, ENV, { screens, json, keyOk, snapshot });
  };
  const made = await (await route('ns/new', { method: 'POST', query: '?key=k', body: { name: 'Pixel Watch' } })).json();
  return { screens, route, token: made.token, made };
}

async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Nightscout-compatible feed', () => {
  it('only the display key makes a link; it is kept as a widget', async () => {
    const { route, made, screens } = await setup();
    expect((await route('ns/new', { method: 'POST', query: '?key=nope', body: {} })).status).toBe(401);
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
    expect([...screens.rows.values()][0]).toMatchObject({ kind: 'widget', name: 'Pixel Watch' });
  });
  it('current entry and history in Nightscout shape, with directions', async () => {
    const { route, token } = await setup();
    const [cur] = await (await route('ns/api/v1/entries/current.json', { query: `?token=${token}` })).json();
    expect(cur).toMatchObject({ type: 'sgv', sgv: 142, direction: 'FortyFiveUp', trend: 3, device: 'su94r' });
    const list = await (await route('ns/api/v1/entries/sgv.json', { query: `?token=${token}&count=3` })).json();
    expect(list.map((e) => e.sgv)).toEqual([142, 136, 125]);
    const since = await (await route('ns/api/v1/entries/sgv.json', { query: `?token=${token}&count=10&find[date][$gt]=${NOW - 20 * 60e3}` })).json();
    expect(since.map((e) => e.sgv)).toEqual([142, 136]);
  });
  it('pebble endpoint (GlucoDataHandler tries it first)', async () => {
    const { route, token } = await setup();
    const p = await (await route('ns/pebble', { query: `?token=${token}` })).json();
    expect(p.bgs[0]).toMatchObject({ sgv: '142', direction: 'FortyFiveUp', bgdelta: '+6' });
  });
  it('accepts the token as an api-secret header (its SHA-1), and refuses anything else', async () => {
    const { route, token } = await setup();
    expect((await route('ns/api/v1/entries/current.json', { headers: { 'api-secret': await sha1(token) } })).status).toBe(200);
    expect((await route('ns/api/v1/entries/current.json', { headers: { 'api-secret': await sha1('wrong') } })).status).toBe(401);
    expect((await route('ns/api/v1/entries/current.json', { query: `?token=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await route('ns/pebble')).status).toBe(401);
  });
  it('an AI connector token cannot read the feed', async () => {
    const { route, screens } = await setup();
    const { sha256 } = await import('../workers/screens.js');
    const t = 'ab'.repeat(32);
    screens.rows.set('ai', { id: 'ai', kind: 'ai', token_hash: await sha256(t), revoked: false });
    expect((await route('ns/pebble', { query: `?token=${t}` })).status).toBe(401);
  });
  it('status answers for apps that check it', async () => {
    const { route, token } = await setup();
    expect((await (await route('ns/api/v1/status.json', { query: `?token=${token}` })).json()).status).toBe('ok');
  });
});

describe('Echo Show line', () => {
  it('draws the last 3 hours and the target band', () => {
    const g = sparkGraphic(person, NOW);
    expect(g.type).toBe('AVG');
    expect(g.items).toHaveLength(2);
    expect(g.items[1].pathData.split('L')).toHaveLength(4);
  });
  it('nothing to draw with fewer than two readings', () => {
    expect(sparkGraphic({ ...person, history: [person.latest] }, NOW)).toBeNull();
  });
});
