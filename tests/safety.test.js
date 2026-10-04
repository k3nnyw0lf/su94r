// Safety: changing su94r Mini's key (owner.js rotateRoute), the emergency card (emergency.js),
// exercise and sick-day modes (night.js) and the bedside screen's "I'm OK" (app.js app/ack).
// What must hold: a key change never locks su94r Mini out (the old key works until the new one
// turns it off) and only a su94r Mini key can change itself; the card shows only what its owner
// allows, tells the family once per opening (not for a preview), and stops at once when turned
// off; exercise mode warns earlier, sick-day mode checks in every 4 hours while awake (2 when
// high) and both end by themselves; "I'm OK" from a phone needs a phone that may log.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { rotateRoute, isOwnerKey } from '../workers/owner.js';
import { cardFrom, cardView, emergencyData, emergencyPage } from '../workers/emergency.js';
import { nightCheck, reminders, activeMode, modeFields, acknowledgeAll, NIGHT_DEFAULTS } from '../workers/night.js';
import proxy from '../workers/proxy.js';

const MIN = 60e3, DAY = 864e5;
const tok = (c) => c.repeat(64);
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function memScreens() {
  const rows = new Map();
  return {
    ready: true, rows,
    async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, ...row }); return [rows.get(row.id)]; },
    // A copy, as PostgREST gives: the row as it was before this request touched it.
    async byToken(h) { const r = [...rows.values()].find((x) => x.token_hash === h && !x.revoked); return r ? { ...r } : null; },
    async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); return []; },
    async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
    async allowLog() { return false; },
  };
}
function memNight(over = {}) {
  let row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {}, emergency: {}, ...over };
  return { ready: true, get row() { return row; }, async get() { return structuredClone(row); }, async patch(f) { row = { ...row, ...structuredClone(f) }; } };
}

describe('changing su94r Mini\'s key', () => {
  let screens;
  const post = (path, key, body) => {
    const url = new URL(`https://cgm.test/${path}?key=${key}`);
    return rotateRoute(path, new Request(url, { method: 'POST', body: JSON.stringify(body || {}) }), url, { screens, json });
  };
  beforeEach(async () => {
    screens = memScreens();
    await screens.insert({ id: 'own-1', token_hash: await sha256(tok('a')), kind: 'owner', name: 'Office PC', claimed_at: 'x', expires_at: 'x' });
    await screens.insert({ id: 'tv-1', token_hash: await sha256(tok('b')), kind: 'screen', name: 'TV', claimed_at: 'x', expires_at: 'x' });
  });

  it('gives a new key while the old one keeps working, then turns the old one off', async () => {
    const r = await (await post('owner/rotate', tok('a'))).json();
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await isOwnerKey(screens, tok('a'))).toBe(true);           // not locked out in between
    expect(await isOwnerKey(screens, r.key)).toBe(true);
    const h = await sha256(r.key);
    expect([...screens.rows.values()].find((x) => x.token_hash === h)?.name).toBe('Office PC');
    const done = await (await post('owner/rotate/done', r.key, { old: await sha256(tok('a')) })).json();
    expect(done).toEqual({ ok: true, revoked: true });
    expect(await isOwnerKey(screens, tok('a'))).toBe(false);
    expect(await isOwnerKey(screens, r.key)).toBe(true);
  });

  it('only a su94r Mini key changes itself; a screen is never turned off this way; the current key is not', async () => {
    expect((await post('owner/rotate', tok('b'))).status).toBe(401);       // a TV's token
    expect((await post('owner/rotate', 'tv-key-123')).status).toBe(401);   // the server's display key
    const bad = await post('owner/rotate/done', tok('a'), { old: await sha256(tok('a')) });
    expect(bad.status).toBe(400);
    const tv = await (await post('owner/rotate/done', tok('a'), { old: await sha256(tok('b')) })).json();
    expect(tv.revoked).toBe(false);
    expect(screens.rows.get('tv-1').revoked).toBe(false);
    expect((await rotateRoute('owner/rotate', new Request('https://cgm.test/owner/rotate'), new URL('https://cgm.test/owner/rotate'), { screens, json })).status).toBe(405);
  });
});
describe('the emergency card', () => {
  it('keeps only real phone numbers, at most three, and the owner\'s choices', () => {
    expect(cardFrom({ contacts: [{ name: 'Mom', phone: 'call me' }] })).toEqual({ error: 'phone', name: 'Mom' });
    const { card } = cardFrom({ note: 'Type 1 diabetes.\nUses insulin.', contacts: [{ name: 'Mom', phone: '(239) 555-0101' }, {}, { name: '', phone: '+1 305 555 0199' }, { name: 'A', phone: '2395550102' }, { name: 'B', phone: '2395550103' }], glucose: false, lang: 'es' });
    expect(card.note).toBe('Type 1 diabetes. Uses insulin.');
    expect(card.contacts).toEqual([{ name: 'Mom', phone: '(239) 555-0101' }, { name: '+1 305 555 0199', phone: '+1 305 555 0199' }]);
    expect(card).toMatchObject({ glucose: false, tell: true, lang: 'es' });
    expect(cardView(null)).toEqual({ note: '', contacts: [], glucose: true, tell: true, lang: 'en' });
  });

  it('shows the glucose only when allowed, the owner\'s low plan, and nothing for any other link', async () => {
    const night = memNight({ treat_grams: 20, treat_minutes: 10, treat_plan: '4 glucose tabs', emergency: { note: 'T1D', contacts: [{ name: 'Mom', phone: '2395550101' }] } });
    const now = Date.parse('2026-10-03T12:00:00Z');
    const snapshot = async () => ({ people: [{ pid: 'p1', name: 'Ken W', firstName: 'Ken', units: 'mg/dL', low: 70, latest: { t: now - 3 * MIN, mg: 62, trend: 2 } }] });
    const d = await emergencyData({ kind: 'emergency', pid: 'p1' }, { night, snapshot, now });
    expect(d).toMatchObject({ name: 'Ken W', note: 'T1D', glucose: { mg: 62, trend: 2, minutes: 3 }, plan: { grams: 20, minutes: 10, text: '4 glucose tabs' }, low: 70 });
    await night.patch({ emergency: { ...night.row.emergency, glucose: false } });
    expect((await emergencyData({ kind: 'emergency', pid: 'p1' }, { night, snapshot, now })).glucose).toBeNull();
    expect(await emergencyData({ kind: 'doctor', pid: 'p1' }, { night, snapshot, now })).toBeNull();
    expect(await emergencyData(null, { night, snapshot, now })).toBeNull();
  });

  describe('through the server', () => {
    let screens, night, sent;
    const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right' };
    const fakeLibre = (url) => {
      const u = new URL(url);
      const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
      if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.b.c', expires: 1900000000 } } });
      const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
      if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
      return res({ status: 0, data: { connection: conn, graphData: [] } });
    };
    const call = (p, { token, key, method = 'GET', body, headers = {} } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${key ? `?key=${key}` : ''}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    }), ENV, { screens, night, push: async (topic, msg) => { sent.push({ topic, title: msg.title }); return true; }, webpush: async () => 0, telegram: { ready: false } });
    beforeEach(async () => {
      resetCaches();
      vi.stubGlobal('fetch', vi.fn(fakeLibre));
      screens = memScreens();
      night = memNight();
      sent = [];
      await screens.insert({ id: 'own-1', token_hash: await sha256(tok('a')), kind: 'owner', name: 'PC', claimed_at: 'x', expires_at: 'x' });
      await screens.insert({ id: 'me-1', token_hash: await sha256(tok('d')), kind: 'screen', role: 'me', name: 'Ken phone', claimed_at: 'x', expires_at: 'x' });
      await screens.insert({ id: 'fam-1', token_hash: await sha256(tok('f')), kind: 'screen', role: 'family', name: 'Mom', claimed_at: 'x', expires_at: 'x' });
    });

    it('su94r Mini makes one card link at a time; opening it tells the owner and the family once', async () => {
      expect((await call('emergency/new', { key: tok('x'), method: 'POST' })).status).toBe(401);
      const saved = await (await call('emergency/save', { key: tok('a'), method: 'POST', body: { note: 'T1D, insulin', contacts: [{ name: 'Mom', phone: '239 555 0101' }] } })).json();
      expect(saved.ok).toBe(true);
      const first = await (await call('emergency/new', { key: tok('a'), method: 'POST', body: { pid: 'p1' } })).json();
      const second = await (await call('emergency/new', { key: tok('a'), method: 'POST', body: { pid: 'p1' } })).json();
      expect((await call('emergency/data', { token: first.token })).status).toBe(401);   // the old card stopped
      const d = await (await call('emergency/data', { token: second.token })).json();
      expect(d).toMatchObject({ name: 'Ken W', note: 'T1D, insulin', contacts: [{ name: 'Mom', phone: '239 555 0101' }] });
      expect(sent.map((x) => x.topic).sort()).toEqual(['c', 's']);
      expect(sent[0].title).toMatch(/Ken's emergency card was opened/);
      await call('emergency/data', { token: second.token });                            // again within 30 minutes
      expect(sent).toHaveLength(2);
      const info = await (await call('emergency', { key: tok('a') })).json();
      expect(info.link).toMatchObject({ id: expect.any(String) });
      expect(info.card.contacts).toHaveLength(1);
      await call('emergency/remove', { key: tok('a'), method: 'POST' });
      expect((await call('emergency/data', { token: second.token })).status).toBe(401);
    });

    it('a preview does not tell anyone; turning telling off is respected', async () => {
      const { token } = await (await call('emergency/new', { key: tok('a'), method: 'POST' })).json();
      await call('emergency/data', { token, headers: { 'x-su94r-preview': '1' } });
      expect(sent).toHaveLength(0);
      await call('emergency/save', { key: tok('a'), method: 'POST', body: { tell: false } });
      [...screens.rows.values()].forEach((r) => { if (r.kind === 'emergency') r.last_seen = null; });
      await call('emergency/data', { token });
      expect(sent).toHaveLength(0);
    });

    it('the owner\'s phone keeps the card; a family phone cannot', async () => {
      expect((await call('app/emergency', { token: tok('f') })).status).toBe(403);
      const r = await (await call('app/emergency/save', { token: tok('d'), method: 'POST', body: { note: 'Diabetes tipo 1', contacts: [{ name: 'Mamá', phone: 'x' }] }, headers: { 'x-su94r-lang': 'es' } })).json();
      expect(r.error).toBe('El teléfono de Mamá no parece correcto.');
      const made = await (await call('app/emergency/new', { token: tok('d'), method: 'POST' })).json();
      expect(made.token).toMatch(/^[0-9a-f]{64}$/);
      expect((await (await call('app/emergency', { token: tok('d') })).json()).link).not.toBeNull();
    });

    it('modes from the app: a phone that may log turns them on; they show in app/recent and end by themselves', async () => {
      expect((await call('app/mode', { token: tok('f'), method: 'POST', body: { mode: 'exercise' } })).status).toBe(403);
      const r = await (await call('app/mode', { token: tok('d'), method: 'POST', body: { mode: 'exercise', hours: 1 } })).json();
      expect(r).toMatchObject({ ok: true, mode: 'exercise' });
      expect(r.text).toMatch(/^Exercise mode until .*from 80 mg\/dL\.$/);
      expect(night.row.mode).toBe('exercise');
      const recent = await (await call('app/recent', { token: tok('d') })).json();
      expect(recent.mode).toMatchObject({ kind: 'exercise' });
      expect((await call('app/mode', { token: tok('d'), method: 'POST', body: { mode: 'party' } })).status).toBe(400);
      await call('app/mode', { token: tok('d'), method: 'POST', body: { mode: 'off' } });
      expect(night.row.mode).toBeNull();
    });

    it('"I\'m OK" from the bedside screen stops every open low; not from a phone that may not log', async () => {
      await night.patch({ state: { p1: { since: Date.now() - 10 * MIN, notified: Date.now() - 5 * MIN, ackHash: 'h', count: 1 }, _soon: {} } });
      expect((await call('app/ack', { token: tok('f'), method: 'POST' })).status).toBe(403);
      const r = await (await call('app/ack', { token: tok('d'), method: 'POST' })).json();
      expect(r).toMatchObject({ ok: true, count: 1 });
      expect(night.row.state.p1.ackAt).toBeGreaterThan(0);
      expect((await (await call('app/ack', { token: tok('d'), method: 'POST' })).json()).count).toBe(0);
    });
  });

  it('the page holds no data, and the proxy draws QR codes only for its own card links', async () => {
    const page = emergencyPage();
    expect(page).toContain("fetch('/emergency/data'");
    expect(page).not.toMatch(/[0-9a-f]{64}/);
    const res = await proxy.fetch(new Request(`https://proxy.test/e/${tok('9')}`), {});
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    const qr = await proxy.fetch(new Request('https://proxy.test/app/qr', { method: 'POST', body: JSON.stringify({ text: `https://proxy.test/e/${tok('9')}` }) }), {});
    expect(qr.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await qr.text()).toMatch(/^<svg/);
    const other = await proxy.fetch(new Request('https://proxy.test/app/qr', { method: 'POST', body: JSON.stringify({ text: 'https://evil.example/e/' + tok('9') }) }), {});
    expect(other.status).toBe(400);
  });
});

describe('exercise and sick-day modes', () => {
  const NOON = Date.parse('2026-10-03T16:00:00Z');          // noon in New York
  const MIDNIGHT = Date.parse('2026-10-04T04:00:00Z');
  const person = (mg, t, trend = 3, history = []) => ({ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: { t, mg, trend }, history });

  it('a mode is in force until it ends; hours are bounded', () => {
    const f = modeFields('exercise', 100, NOON);
    expect(Date.parse(f.mode_until) - NOON).toBe(12 * 60 * MIN);
    expect(Date.parse(modeFields('sick', undefined, NOON).mode_until) - NOON).toBe(24 * 60 * MIN);
    expect(activeMode({ ...f }, NOON + MIN)).toBe('exercise');
    expect(activeMode({ ...f }, NOON + 13 * 60 * MIN)).toBeNull();
    expect(modeFields('off')).toEqual({ mode: null, mode_until: null });
    expect(() => modeFields('party')).toThrow();
  });

  it('exercise mode warns earlier: 88 and drifting down warns only in exercise mode', async () => {
    const hist = [{ t: NOON - 10 * MIN, mg: 98 }];             // −1 mg/dL a minute
    const run = async (row) => (await nightCheck({ row, people: [person(88, NOON, 3, hist)], now: NOON, push: async () => true, ackUrl: (t) => t })).sent.map((s) => s.label);
    const base = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} };
    expect(await run(base)).toEqual([]);
    expect(await run({ ...base, ...modeFields('exercise', 2, NOON - MIN) })).toEqual(['soon']);
    expect(await run({ ...base, soon_enabled: false, ...modeFields('exercise', 2, NOON - MIN) })).toEqual(['soon']);
    expect(await run({ ...base, mode: 'exercise', mode_until: new Date(NOON - MIN).toISOString() })).toEqual([]);   // ended
  });

  it('sick-day mode checks in every 4 hours while awake, every 2 when above 250, never at night', async () => {
    const row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', ...modeFields('sick', 48, NOON - MIN) };
    const state = {};
    const msgs = [];
    const send = async (topic, msg) => { msgs.push(msg); };
    await reminders(row, [person(180, NOON)], state, send, { now: NOON });
    expect(msgs.map((m) => m.title)).toEqual(['Sick day check: 180 mg/dL']);
    expect(msgs[0].es.title).toBe('Revisión de día de enfermedad: 180 mg/dL');
    await reminders(row, [person(180, NOON + 3 * 60 * MIN)], state, send, { now: NOON + 3 * 60 * MIN });
    expect(msgs).toHaveLength(1);
    await reminders(row, [person(270, NOON + 2 * 60 * MIN + MIN)], state, send, { now: NOON + 2 * 60 * MIN + MIN });
    expect(msgs.at(-1).title).toBe('Sick day: 270 mg/dL, check ketones');
    const nightState = {};
    await reminders(row, [person(300, MIDNIGHT)], nightState, send, { now: MIDNIGHT });
    expect(msgs).toHaveLength(2);
    const off = { _sick: { p1: NOON } };
    await reminders({ ...row, mode: null }, [person(180, NOON)], off, send, { now: NOON });
    expect(off._sick).toBeUndefined();
  });

  it('"I\'m OK" for everything open, and a mode set from su94r Mini', async () => {
    const { state, count } = acknowledgeAll({ state: { p1: { since: 1 }, p2: { since: 1, ackAt: 5 }, _soon: { p3: { at: 1 } } } }, 100);
    expect(count).toBe(2);
    expect(state.p1.ackAt).toBe(100);
    expect(state.p2.ackAt).toBe(5);
    expect(state._soon.p3.ackAt).toBe(100);
  });
});
