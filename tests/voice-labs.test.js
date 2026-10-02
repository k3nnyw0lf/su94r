// Log by voice in the app (app/parse) and lab results (app/labs, the report, the doctor's link).
// What must hold: spoken numbers become the right amounts and nothing is logged by parsing; lab
// results are checked, only phones that may log add them, and the report shows the latest A1c next
// to the GMI.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { spokenNumbers } from '../workers/app.js';
import { labRow, labsForReport } from '../workers/labs.js';
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
});
