// Log by voice in the app (app/parse) and lab results (app/labs, the report, the doctor's link).
// What must hold: spoken numbers become the right amounts and nothing is logged by parsing; lab
// results are checked, only phones that may log add them, and the report shows the latest A1c next
// to the GMI.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { spokenNumbers } from '../workers/app.js';
import { labRow, labsForReport, httpsUrl, portalLinks, portalButtons } from '../workers/labs.js';
import { REPORT_SCRIPT } from '../workers/doctor.js';
import { sha256 } from '../workers/screens.js';

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const DAY = 864e5;

describe('spoken numbers', () => {
  it.each([
    ['four units of rapid', '4 units of rapid'],
    ['I took four and a half units of rapid insulin', 'i took 4.5 units of rapid insulin'],
    ['eighteen units Lantus thirty minutes ago', '18 units lantus 30 minutes ago'],
    ['a hundred and twenty grams', '120 grams'],
    ['I ate forty grams half an hour ago', 'i ate 40 grams 30 minutes ago'],
    ['twenty-five grams', '25 grams'],
  ])('%s', (said, text) => expect(spokenNumbers(said)).toBe(text));
});

describe('lab results', () => {
  const now = Date.UTC(2026, 9, 2);
  it('checks what is typed in', () => {
    expect(labRow('p1', { kind: 'a1c', value: '7,1', takenOn: '2026-09-03' }, now)).toEqual({ pid: 'p1', kind: 'a1c', name: 'A1c', value: 7.1, unit: '%', taken_on: '2026-09-03' });
    expect(labRow('p1', { kind: 'a1c', value: 71, takenOn: '2026-09-03' }, now).error).toMatch(/between 3 and 20/);
    expect(labRow('p1', { kind: 'a1c', value: 7, takenOn: '2027-09-03' }, now).error).toBeTruthy();
    expect(labRow('p1', { kind: 'other', value: 98, takenOn: '2026-09-03' }, now).error).toMatch(/Name the test/);
    expect(labRow('p1', { kind: 'other', name: 'LDL <b>', value: 98, unit: 'mg/dL', takenOn: '2026-09-03' }, now)).toMatchObject({ name: 'LDL b', unit: 'mg/dL' });
  });

  it('the report gets the last year and the latest A1c', () => {
    const r = labsForReport([
      { taken_on: '2026-09-03', kind: 'a1c', name: 'A1c', value: '7.1', unit: '%' },
      { taken_on: '2026-06-01', kind: 'other', name: 'LDL', value: '98', unit: 'mg/dL' },
      { taken_on: '2024-01-01', kind: 'a1c', name: 'A1c', value: '8.0', unit: '%' },
    ], now);
    expect(r.a1c).toEqual({ takenOn: '2026-09-03', value: 7.1 });
    expect(r.labs.map((l) => l.name)).toEqual(['A1c', 'LDL']);
  });

  it('the report page shows them, escaped', () => {
    const run = new Function(`${REPORT_SCRIPT}; return labsHtml;`)();
    const html = run({ gmi: 6.9, a1c: { takenOn: '2026-09-03', value: 7.1 }, labs: [{ takenOn: '2026-09-03', name: 'A1c', value: 7.1, unit: '%' }, { takenOn: '2026-06-01', name: '<script>', value: 1, unit: '' }] });
    expect(html).toContain('Latest A1c <b>7.1%</b>');
    expect(html).toContain('GMI over these 14 days: <b>6.9%</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(run({ labs: [] })).toBe('');
  });
});

describe('where results live online', () => {
  it('keeps only https addresses', () => {
    expect(httpsUrl('mychart.example.org/MyChart/')).toBe('https://mychart.example.org/MyChart/');
    expect(httpsUrl('  https://www.pharmacy.example/rx ')).toBe('https://www.pharmacy.example/rx');
    for (const bad of ['http://mychart.example.org/', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@example.org/', 'https://localhost/', 'not an address', '']) expect(httpsUrl(bad)).toBe('');
    expect(portalLinks({ mychart: 'javascript:alert(1)' }).error).toMatch(/MyChart/);
    expect(portalLinks({ pharmacy: 'http://rx.example.com' }).error).toMatch(/pharmacy/);
    expect(portalLinks({ mychart: '', pharmacy: 'publix' })).toEqual({ links: { pharmacy: { id: 'publix', url: 'https://www.publix.com/pharmacy' } } });
    expect(portalLinks({ mychart: 'mychart.example.org/MyChart/', pharmacy: 'https://www.pharmacy.example/rx' })).toEqual({ links: { mychart: { url: 'https://mychart.example.org/MyChart/' }, pharmacy: { url: 'https://www.pharmacy.example/rx' } } });
    expect(portalLinks({})).toEqual({ links: {} });
  });

  it('the buttons: Quest, Labcorp, LibreView and Fullscript, then the owner\'s own', () => {
    expect(portalButtons(null)).toEqual([
      { id: 'quest', name: 'Quest', url: 'https://myquest.questdiagnostics.com/dashboard' },
      { id: 'labcorp', name: 'Labcorp', url: 'https://patient.labcorp.com/' },
      { id: 'libreview', name: 'LibreView', url: 'https://www.libreview.com/' },
      { id: 'fullscript', name: 'Fullscript', url: 'https://us.fullscript.com/login' },
    ]);
    expect(portalButtons({ mychart: { url: 'https://mychart.example.org/MyChart/' }, pharmacy: { url: 'https://www.pharmacy.example/rx' } }).slice(4)).toEqual([
      { id: 'mychart', name: 'MyChart', url: 'https://mychart.example.org/MyChart/' },
      { id: 'pharmacy', name: 'pharmacy.example', url: 'https://www.pharmacy.example/rx' },
    ]);
    expect(portalButtons({ pharmacy: { id: 'cvs', url: 'https://evil.example/' } })[4]).toEqual({ id: 'pharmacy', name: 'CVS', url: 'https://www.cvs.com/pharmacy' });
    expect(portalButtons({ mychart: { url: 'javascript:alert(1)' }, pharmacy: { url: 'http://x.example' } })).toHaveLength(4);
  });
});

describe('in the app', () => {
  let screens, saved;
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
    const r = new Map();
    for (const [id, c, extra] of [['aaaaaaaa-1', 'a', { role: 'me' }], ['bbbbbbbb-2', 'b', { role: 'family' }]]) r.set(id, { id, kind: 'screen', token_hash: await sha256(c.repeat(64)), revoked: false, ...extra });
    screens = { ready: true, async byToken(h) { return [...r.values()].find((x) => x.token_hash === h) || null; }, async update() { return []; }, async list() { return [...r.values()]; } };
    saved = [];
  });
  const labs = () => ({ ready: true, async list() { return saved.map((x, i) => ({ id: String(i), ...x })); }, async add(row) { saved.push(row); }, async remove(pid, id) { saved.splice(Number(id), 1); } });
  const call = (p, token, body) => handleCgm(p, new Request(`https://x/${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), ENV,
    { screens, labs: labs(), store: { ready: true, async between() { return []; }, async upsert() { throw new Error('parse must not log'); } }, night: { ready: false }, history: { ready: true, async range() { return []; } }, forecasts: { ready: false } });

  it('parsing says what it would log, and logs nothing', async () => {
    expect(await (await call('app/parse', 'b'.repeat(64), { text: 'four units of rapid' })).json()).toEqual({ ok: true, heard: '4 units of rapid', kind: 'rapid', amount: 4, minutesAgo: 0 });
    expect(await (await call('app/parse', 'a'.repeat(64), { text: 'I ate forty grams half an hour ago' })).json()).toMatchObject({ ok: true, kind: 'carbs', amount: 40, minutesAgo: 30 });
    expect((await (await call('app/parse', 'a'.repeat(64), { text: 'hello there' })).json()).ok).toBe(false);
    expect((await call('app/parse', 'c'.repeat(64), { text: '4 units rapid' })).status).toBe(401);
  });

  it('the owner\'s phone adds and removes results; family reads; the report carries them', async () => {
    expect((await call('app/labs/save', 'b'.repeat(64), { kind: 'a1c', value: 7.1, takenOn: '2026-09-03' })).status).toBe(403);
    expect(await (await call('app/labs/save', 'a'.repeat(64), { kind: 'a1c', value: 7.1, takenOn: new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10) })).json()).toEqual({ ok: true });
    const view = await (await call('app/labs', 'b'.repeat(64))).json();
    expect(view).toMatchObject({ canEdit: false, labs: [{ name: 'A1c', value: 7.1, unit: '%' }] });
    const report = await (await call('app/report', 'b'.repeat(64))).json();
    expect(report.a1c.value).toBe(7.1);
    expect(report.labs).toHaveLength(1);
    await call('app/labs/remove', 'a'.repeat(64), { id: '0' });
    expect(saved).toHaveLength(0);
  });

  it('the owner sets their MyChart and pharmacy; every phone gets the buttons', async () => {
    let row = { id: 1, state: {} };
    const night = { ready: true, async get() { return structuredClone(row); }, async patch(p) { row = { ...row, ...structuredClone(p) }; } };
    const go = (p, token, body) => handleCgm(p, new Request(`https://x/${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), ENV,
      { screens, labs: labs(), store: { ready: true, async between() { return []; }, async upsert() { return 0; } }, night, history: { ready: true, async range() { return []; } }, forecasts: { ready: false } });
    const before = await (await go('app/labs', 'a'.repeat(64))).json();
    expect(before.portals.map((p) => p.id)).toEqual(['quest', 'labcorp', 'libreview', 'fullscript']);
    expect(before.links).toEqual({ mychart: '', pharmacy: '' });
    expect(before.pharmacies.map((p) => p.id)).toEqual(['cvs', 'walgreens', 'publix', 'amazon']);
    expect((await go('app/links', 'b'.repeat(64), { mychart: 'https://mychart.example.org/' })).status).toBe(403);
    expect((await go('app/links', 'a'.repeat(64), { mychart: 'http://mychart.example.org/' })).status).toBe(400);
    expect(row.portal_links).toBeUndefined();
    expect(await (await go('app/links', 'a'.repeat(64), { mychart: 'mychart.example.org/MyChart/', pharmacy: 'publix' })).json()).toMatchObject({ ok: true });
    expect(row.portal_links).toEqual({ mychart: { url: 'https://mychart.example.org/MyChart/' }, pharmacy: { id: 'publix', url: 'https://www.publix.com/pharmacy' } });
    const family = await (await go('app/labs', 'b'.repeat(64))).json();
    expect(family.portals.slice(4).map((p) => p.name)).toEqual(['MyChart', 'Publix']);
    expect(family.links).toBeUndefined();
    expect((await (await go('app/labs', 'a'.repeat(64))).json()).links).toEqual({ mychart: 'https://mychart.example.org/MyChart/', pharmacy: 'publix' });
    await go('app/links', 'a'.repeat(64), { mychart: '', pharmacy: '' });
    expect(row.portal_links).toEqual({});
  });
});
