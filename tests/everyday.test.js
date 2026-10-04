// Everyday: barcode carbs (food.js), favorite meals, notes with tags (notes.js, patterns.js),
// changing and removing logged entries, logging that survives lost signal, and deletions on the
// server reaching su94r Mini (voice/sync). What must hold: only a barcode reaches Open Food Facts
// and only its carbs come back; a resend with the same phone-made id saves once (and does not warn
// about itself); a phone changes only its own entries (the owner's phone also Alexa / Telegram /
// phone ones, never su94r Mini's); notes need words or a known tag; a tag that keeps being
// followed by lows becomes a pattern.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';
import { foodByBarcode } from '../workers/food.js';
import { noteRow, notesForReport } from '../workers/notes.js';
import { findPatterns, NOTE_TAGS } from '../extension/patterns.js';

const MIN = 60e3, DAY = 864e5;
const tok = (c) => c.repeat(64);

describe('carbs from a barcode', () => {
  it('asks Open Food Facts for that barcode only and keeps the carbs', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ status: 1, product: { product_name: 'Rolled oats', brands: 'Acme, Other', serving_size: '40 g', serving_quantity: 40, nutriments: { carbohydrates_100g: 60, sugars_100g: 1 }, ingredients: 'not wanted' } }), { status: 200 });
    };
    const r = await foodByBarcode('0 12345 67890 5', { fetchImpl });
    expect(seen).toEqual(['https://world.openfoodfacts.org/api/v2/product/012345678905.json?fields=product_name,product_name_es,brands,serving_size,serving_quantity,nutriments']);
    expect(r).toEqual({ found: true, code: '012345678905', name: 'Acme · Rolled oats', per100: 60, perServing: 24, servingSize: '40 g', servingGrams: 40 });
    expect(await foodByBarcode('123', { fetchImpl })).toEqual({ error: 'barcode' });
    expect(await foodByBarcode('40000000', { fetchImpl: async () => new Response('{}', { status: 404 }) })).toEqual({ found: false, code: '40000000' });
    expect(await foodByBarcode('40000000', { fetchImpl: async () => new Response('{"status":0}', { status: 200 }) })).toEqual({ found: false, code: '40000000' });
    await expect(foodByBarcode('40000000', { fetchImpl: async () => new Response('', { status: 503 }) })).rejects.toThrow(/503/);
  });
});

describe('notes and their tags', () => {
  it('a note needs words or a known tag, within the last day', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(noteRow({ id: 'n1', pid: 'p1', t: now, text: '  ', tags: ['party'] }, now)).toEqual({ error: 'Write a note or pick a tag.' });
    expect(noteRow({ id: 'n1', pid: 'p1', t: now - 2 * DAY, text: 'x' }, now).error).toMatch(/24 hours/);
    expect(noteRow({ id: 'n1', pid: 'p1', t: now, text: ' ran\n30 min ', tags: ['exercise', 'exercise', 'party'] }, now)).toMatchObject({ text: 'ran 30 min', tags: ['exercise'] });
    expect(NOTE_TAGS).toContain('eating-out');
    expect(notesForReport([{ t: 1, text: 'a', tags: ['stress'] }, { t: 2, text: 'b', tags: ['stress', 'sick'] }])).toEqual({ count: 2, tags: { stress: 2, sick: 1 }, recent: [{ t: 2, text: 'b', tags: ['stress', 'sick'] }, { t: 1, text: 'a', tags: ['stress'] }] });
  });

  it('a tag that keeps being followed by lows becomes a pattern, in English and Spanish', () => {
    const now = Date.parse('2026-10-14T23:00:00Z');
    const points = [];
    for (let t = now - 14 * DAY; t <= now; t += 15 * MIN) points.push({ t, mg: 130 });
    const notes = [];
    for (const d of [2, 5, 8, 11]) {
      const at = now - d * DAY;
      notes.push({ t: at, text: 'run', tags: ['exercise'] });
      if (d !== 11) for (const p of points) if (p.t > at + 2 * 3600e3 && p.t < at + 3 * 3600e3) p.mg = 60;
    }
    const en = findPatterns(points, [], { now, tz: 'UTC', notes });
    expect(en.patterns.map((p) => p.text)).toContain('After “exercise” notes, a low followed within 6 hours 3 of 4 times.');
    const es = findPatterns(points, [], { now, tz: 'UTC', notes, lang: 'es' });
    expect(es.patterns.map((p) => p.text)).toContain('Después de las notas de “ejercicio”, hubo una baja en las 6 horas siguientes 3 de 4 veces.');
    expect(findPatterns(points, [], { now, tz: 'UTC', notes: notes.slice(0, 2) }).patterns.some((p) => p.kind === 'tag-low')).toBe(false);
  });
});

describe('through the phone app', () => {
  const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
  let screens, doses, meals, notes, offCalls;
  function fakeLibre(url) {
    const u = new URL(url);
    const res = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
    if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.b.c', expires: 1900000000 } } });
    const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
    if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
    return res({ status: 0, data: { connection: conn, graphData: [] } });
  }
  const call = (p, { token, method = 'GET', body, query = '' } = {}) => handleCgm(p, new Request(`https://cgm.test/${p}${query}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }), ENV, { screens, store: doses, meals, notes, fetchImpl: async (url) => { offCalls.push(String(url)); return new Response(JSON.stringify({ status: 1, product: { product_name: 'Juice', nutriments: { carbohydrates_100g: 10, carbohydrates_serving: 24 }, serving_size: '240 ml', serving_quantity: 240 } })); } });
  beforeEach(async () => {
    resetCaches();
    vi.stubGlobal('fetch', vi.fn(fakeLibre));
    offCalls = [];
    const rows = new Map();
    screens = {
      ready: true,
      async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, ...row }); },
      async byToken(h) { const r = [...rows.values()].find((x) => x.token_hash === h && !x.revoked); return r ? { ...r } : null; },
      async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); },
      async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
    };
    const drows = [];
    doses = {
      ready: true, rows: drows,
      async recent(pid, now = Date.now()) { return drows.filter((d) => !d.deleted && d.t >= now - 2 * DAY && (!pid || d.pid === pid)); },
      async between(pid, from, to) { return drows.filter((d) => !d.deleted && d.pid === pid && d.t >= from && d.t < to); },
      async upsert(list) { for (const d of list.filter(valid)) { const i = drows.findIndex((r) => r.id === d.id); if (i >= 0) drows[i] = { ...drows[i], ...d }; else drows.push({ ...d, deleted: false }); } },
      async markDeleted(ids) { for (const r of drows) if (ids.includes(r.id)) r.deleted = true; },
      async deletedRecent() { return drows.filter((d) => d.deleted && d.source !== 'extension').map((d) => d.id); },
    };
    const mrows = [];
    meals = {
      ready: true, rows: mrows,
      async list() { return mrows.slice().sort((a, b) => b.uses - a.uses); },
      async use(pid, name, carbs) { const m = mrows.find((x) => x.name.toLowerCase() === name.toLowerCase()); if (m) { m.carbs = carbs; m.uses += 1; } else mrows.push({ id: `m${mrows.length}`, pid, name, carbs, uses: 1 }); return name; },
      async remove(pid, id) { const i = mrows.findIndex((x) => x.id === id); if (i >= 0) mrows.splice(i, 1); },
    };
    const nrows = [];
    notes = {
      ready: true, rows: nrows,
      async between(pid, from, to) { return nrows.filter((n) => !n.deleted && n.pid === pid && Date.parse(n.t) >= from && Date.parse(n.t) < to).map((n) => ({ ...n, t: Date.parse(n.t) })); },
      async get(id) { const n = nrows.find((x) => x.id === id && !x.deleted); return n ? { ...n, t: Date.parse(n.t) } : null; },
      async add(row) { if (!nrows.some((x) => x.id === row.id)) nrows.push({ ...row }); },
      async remove(id) { const n = nrows.find((x) => x.id === id); if (n) n.deleted = true; },
    };
    const add = async (id, c, extra) => screens.insert({ id, token_hash: await sha256(tok(c)), claimed_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(), ...extra });
    await add('aaaaaaaa-1111', 'a', { kind: 'screen', role: 'me', name: 'Ken phone' });
    await add('bbbbbbbb-2222', 'b', { kind: 'screen', role: 'family', name: 'Mom', can_log: true });
    await add('cccccccc-3333', 'c', { kind: 'screen', role: 'family', name: 'Aunt' });
  });

  it('a barcode looks up carbs for any linked phone; a bad one is refused before asking', async () => {
    const r = await (await call('app/food', { token: tok('c'), query: '?barcode=012345678905' })).json();
    expect(r).toMatchObject({ found: true, name: 'Juice', perServing: 24, per100: 10 });
    expect((await call('app/food', { token: tok('c'), query: '?barcode=12' })).status).toBe(400);
    expect(offCalls).toHaveLength(1);
  });

  it('a resend after lost signal saves once, at the time it happened, and does not warn about itself', async () => {
    const madeAt = Date.now() - 20 * MIN;
    const cid = madeAt.toString(36);
    const body = { kind: 'rapid', amount: 4, pid: 'p1', cid, at: madeAt };
    const first = await (await call('app/log', { token: tok('a'), method: 'POST', body })).json();
    expect(first).toMatchObject({ ok: true, id: `app-aaaaaaaa-${cid}` });
    expect(doses.rows[0].t).toBe(madeAt);
    const again = await (await call('app/log', { token: tok('a'), method: 'POST', body })).json();
    expect(again).toMatchObject({ ok: true, again: true });
    expect(doses.rows).toHaveLength(1);
    const old = (Date.now() - 2 * DAY).toString(36);
    expect((await call('app/log', { token: tok('a'), method: 'POST', body: { ...body, cid: old } })).status).toBe(400);
    // A different dose a minute later still gets the double-dose question.
    const second = await (await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'rapid', amount: 4, pid: 'p1' } })).json();
    expect(second.confirm).toBe(true);
  });

  it('a meal logged with a name becomes a favorite with its usual carbs', async () => {
    await call('app/log', { token: tok('a'), method: 'POST', body: { kind: 'carbs', amount: 45, pid: 'p1', meal: 'Oatmeal' } });
    await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'carbs', amount: 50, pid: 'p1', meal: 'oatmeal' } });
    const list = await (await call('app/meals', { token: tok('c'), query: '?pid=p1' })).json();
    expect(list.meals).toEqual([{ id: 'm0', name: 'Oatmeal', carbs: 50, uses: 2 }]);
    expect((await call('app/meals/remove', { token: tok('c'), method: 'POST', body: { id: 'm0' } })).status).toBe(403);
    await call('app/meals/remove', { token: tok('a'), method: 'POST', body: { id: 'm0', pid: 'p1' } });
    expect(meals.rows).toHaveLength(0);
  });

  it('a phone changes its own entries; the owner\'s phone also Alexa\'s; nobody changes su94r Mini\'s here', async () => {
    const t0 = Date.now() - 60 * MIN;
    await doses.upsert([{ id: 'alexa-1', pid: 'p1', t: t0, kind: 'rapid', amount: 3, source: 'alexa' }, { id: 'ext-1', pid: 'p1', t: t0, kind: 'basal', amount: 20, source: 'extension' }]);
    const mom = await (await call('app/log', { token: tok('b'), method: 'POST', body: { kind: 'carbs', amount: 30, pid: 'p1' } })).json();
    expect((await call('app/edit', { token: tok('b'), method: 'POST', body: { id: 'alexa-1', amount: 4 } })).status).toBe(403);
    const changed = await (await call('app/edit', { token: tok('b'), method: 'POST', body: { id: mom.id, amount: 35, minutesAgo: 10 } })).json();
    expect(changed.text).toBe('Changed to 35 g of carbs.');
    expect(doses.rows.find((d) => d.id === mom.id).deleted).toBe(true);
    expect(doses.rows.find((d) => d.id === changed.id)).toMatchObject({ kind: 'carbs', amount: 35, source: 'phone' });
    const ext = await call('app/edit', { token: tok('a'), method: 'POST', body: { id: 'ext-1', amount: 18 } });
    expect(ext.status).toBe(403);
    expect((await ext.json()).error).toMatch(/su94r Mini/);
    const owner = await (await call('app/edit', { token: tok('a'), method: 'POST', body: { id: 'alexa-1', amount: 3.5, kind: 'short' } })).json();
    expect(owner.text).toBe('Changed to 3.5 units of regular insulin.');
    expect((await call('app/remove', { token: tok('c'), method: 'POST', body: { id: owner.id } })).status).toBe(403);   // may not log at all
    await call('app/remove', { token: tok('a'), method: 'POST', body: { id: owner.id } });
    const recent = await (await call('app/recent', { token: tok('a') })).json();
    expect(recent.events.find((e) => e.id === 'ext-1').edit).toBe(false);
    expect(recent.events.find((e) => e.id === changed.id).edit).toBe(true);
    // su94r Mini hears about every one deleted here.
    const sync = await (await handleCgm('voice/sync', new Request('https://cgm.test/voice/sync?key=tv-key-123', { method: 'POST', body: JSON.stringify({ markers: [] }) }), ENV, { screens, store: doses })).json();
    expect(sync.deleted.sort()).toEqual(['alexa-1', mom.id, owner.id].sort());
    expect(sync.doses.map((d) => d.id)).toEqual([changed.id]);
  });

  it('notes: phones that may log write them; they show in app/recent, the History and the report', async () => {
    expect((await call('app/note', { token: tok('c'), method: 'POST', body: { text: 'x' } })).status).toBe(403);
    const r = await (await call('app/note', { token: tok('b'), method: 'POST', body: { pid: 'p1', text: 'Walked the dog', tags: ['exercise'], minutesAgo: 30 } })).json();
    expect(r).toMatchObject({ ok: true, text: 'Note saved.' });
    const bad = await (await call('app/note', { token: tok('b'), method: 'POST', body: { pid: 'p1', text: '', tags: [] }, query: '' })).json();
    expect(bad.error).toBe('Write a note or pick a tag.');
    const recent = await (await call('app/recent', { token: tok('a') })).json();
    expect(recent.notes).toHaveLength(1);
    expect(recent.notes[0]).toMatchObject({ text: 'Walked the dog', tags: ['exercise'], by: 'Mom', mine: true });
    const hist = await (await call('app/notes', { token: tok('c'), query: '?days=14' })).json();
    expect(hist.notes[0].mine).toBe(false);
    expect((await call('app/notes/remove', { token: tok('c'), method: 'POST', body: { id: r.id } })).status).toBe(403);
    await call('app/notes/remove', { token: tok('a'), method: 'POST', body: { id: r.id } });
    expect((await (await call('app/recent', { token: tok('a') })).json()).notes).toHaveLength(0);
  });
});
