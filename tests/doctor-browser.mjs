// Browser check of the doctor's page (/r/<token>) against the real server code, with 14 days of
// made-up readings: the page loads its report, draws the AGP and the ranges, and a removed link
// shows "This link has ended".
//   node tests/doctor-browser.mjs  (needs playwright-core and Microsoft Edge)
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { handleCgm } from '../workers/cgm-core.js';
import { doctorPage } from '../workers/doctor.js';

const OUT = process.env.OUT || '.';
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const now = Date.now(), MIN = 60e3, DAY = 864e5;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (!u.host.includes('libreview')) return realFetch(url, init);
  const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
  const conn = { patientId: 'p1', firstName: 'Alex', lastName: 'T', targetLow: 70, targetHigh: 180, glucoseMeasurement: null };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  return res({ status: 0, data: { connection: conn, graphData: [] } });
};

// 14 days: a daily curve (higher after meals, a dip before dawn), some noise, a few lows.
const points = [];
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (let t = now - 14 * DAY; t < now; t += 15 * MIN) {
  const h = (new Date(t).getHours() + new Date(t).getMinutes() / 60);
  const meal = [8, 13, 19.5].reduce((s, m) => s + 70 * Math.exp(-(((h - m - 1) / 1.1) ** 2)), 0);
  const dawn = -30 * Math.exp(-(((h - 4) / 1.5) ** 2));
  points.push({ t, mg: Math.max(45, Math.round(115 + meal + dawn + (rnd() - 0.5) * 50)) });
}
const history = { ready: true, async range(pid, from, to) { return points.filter((p) => p.t >= from && p.t < to); } };
const doses = { ready: true, async between(pid, from) {
  const out = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(now - d * DAY); day.setHours(8, 0, 0, 0);
    out.push({ id: `b${d}`, pid, t: day.getTime(), kind: 'rapid', amount: 5 }, { id: `l${d}`, pid, t: day.getTime() + 14 * 3600e3, kind: 'long', amount: 18 });
  }
  return out.filter((x) => x.t >= from);
} };
const rows = new Map();
const screens = {
  ready: true,
  async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, ...row }); return [rows.get(row.id)]; },
  async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
  async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); return []; },
  async list() { return [...rows.values()]; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8792');
  if (/^\/r\/[0-9a-f]{64}$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(doctorPage()); return; }
  const r = await handleCgm(url.pathname.slice(1), new Request(url, { method: req.method, headers: req.headers }), ENV, { screens, history, store: doses });
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(await r.text());
});
await new Promise((r) => server.listen(8792, r));
const made = await (await handleCgm('doctor/new', new Request('http://localhost:8792/doctor/new?key=tv-key-123', { method: 'POST', body: JSON.stringify({ name: 'Dr. Rivera' }) }), ENV, { screens })).json();

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:8792/r/${made.token}`);
await page.waitForSelector('svg.agp');
const text = await page.textContent('#r');
const checks = {
  person: text.includes('Alex'),
  label: text.includes('For Dr. Rivera'),
  ranges: /In range \(70–180\)\d+%/.test(text.replace(/\s+/g, '')) || text.includes('In range (70–180)'),
  agpBands: (await page.$$('svg.agp polygon')).length === 2,
  insulin: text.includes('rapid') && text.includes('long'),
};
await page.screenshot({ path: path.join(OUT, 'doctor-1-report.png'), fullPage: true });
const mobile = await browser.newPage({ viewport: { width: 375, height: 812 } });
await mobile.goto(`http://localhost:8792/r/${made.token}`);
await mobile.waitForSelector('svg.agp');
checks.noSideScroll = await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
await mobile.screenshot({ path: path.join(OUT, 'doctor-2-phone.png'), fullPage: true });
for (const r of rows.values()) r.revoked = true;
await page.reload();
await page.waitForSelector('.err');
checks.endedAfterRemove = (await page.textContent('.err')).includes('This link has ended');
await page.screenshot({ path: path.join(OUT, 'doctor-3-ended.png') });
await browser.close();
server.close();
console.log(JSON.stringify({ checks, errors }, null, 1));
process.exit(Object.values(checks).every(Boolean) && !errors.length ? 0 : 1);
