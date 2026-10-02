// Browser check of the su94r phone app (/app/) against the real server and proxy code, with
// made-up readings: a share code links the phone; Now, History, Log, Report and More render on a
// phone-sized screen without sideways scrolling; a dose logs after the confirm sheet; a second
// dose shows the double-dose warning; Undo works; a meal photo fills in the carbs; a family
// member's phone cannot log.
//   node tests/app-browser.mjs  (needs playwright-core and Microsoft Edge)
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { handleCgm } from '../workers/cgm-core.js';
import { valid } from '../workers/doses.js';
import proxy from '../workers/proxy.js';

const OUT = process.env.OUT || '.';
const PORT = 8793;
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const now = Date.now(), MIN = 60e3, DAY = 864e5;
const fmt = (t) => { const d = new Date(t); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 ${ap}`; };
const curve = (t) => { const h = new Date(t).getHours() + new Date(t).getMinutes() / 60; return Math.round(115 + [8, 13, 19.5].reduce((s, m) => s + 70 * Math.exp(-(((h - m - 1) / 1.1) ** 2)), 0) - 30 * Math.exp(-(((h - 4) / 1.5) ** 2)) + 12 * Math.sin(t / 7e5)); };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (!u.host.includes('libreview')) return realFetch(url, init);
  const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
  const m = (t, mg, trend = 4) => ({ FactoryTimestamp: fmt(t), ValueInMgPerDl: mg, GlucoseUnits: 1, TrendArrow: trend });
  const conn = { patientId: 'p1', firstName: 'Alex', lastName: 'T', targetLow: 70, targetHigh: 180, glucoseMeasurement: m(now - 2 * MIN, curve(now - 2 * MIN)), sensor: { sn: 'X', a: Math.round((now - 6 * DAY) / 1000) } };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  const graphData = [];
  for (let t = now - 12 * 3600e3; t < now - 5 * MIN; t += 15 * MIN) graphData.push(m(t, curve(t)));
  return res({ status: 0, data: { connection: conn, graphData, activeSensors: [{ sensor: conn.sensor }] } });
};

const points = [];
for (let t = now - 14 * DAY; t < now; t += 15 * MIN) points.push({ t, mg: Math.max(48, curve(t) + Math.round((Math.sin(t / 3.3e6) * 25))) });
const history = { ready: true, async range(pid, from, to) { return points.filter((p) => p.t >= from && p.t < to); } };
const doseRows = [{ id: 'ext-a', pid: 'p1', t: now - 3 * 3600e3, kind: 'rapid', amount: 5, source: 'extension', deleted: false }, { id: 'ext-b', pid: 'p1', t: now - 3 * 3600e3, kind: 'carbs', amount: 50, source: 'alexa', deleted: false }];
const doses = {
  ready: true,
  async recent(pid, n = Date.now()) { return doseRows.filter((d) => !d.deleted && d.t >= n - 2 * DAY && (!pid || d.pid === pid)); },
  async between(pid, from, to) { return doseRows.filter((d) => !d.deleted && d.pid === pid && d.t >= from && d.t < to); },
  async upsert(list) { const ok = list.filter(valid); ok.forEach((d) => doseRows.push({ ...d, deleted: false })); return ok.length; },
  async markDeleted(ids) { doseRows.forEach((r) => { if (ids.includes(r.id)) r.deleted = true; }); },
};
const forecasts = { ready: true, async get() { return { p: 'p1', at: Date.now() - 3 * MIN, trusted: true, mg: curve(now), h30: { mg: curve(now) + 12, lo: curve(now) - 8, hi: curve(now) + 32 }, h60: { mg: curve(now) + 20, lo: curve(now) - 15, hi: curve(now) + 55 } }; } };
const rows = new Map();
const screens = {
  ready: true,
  async insert(row) { rows.set(row.id, { revoked: false, last_seen: null, claimed_at: null, token_hash: null, ...row }); return [rows.get(row.id)]; },
  async bySecret(h) { return [...rows.values()].find((r) => r.secret_hash === h && !r.revoked) || null; },
  async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
  async update(id, p) { if (rows.has(id)) Object.assign(rows.get(id), p); return []; },
  async claimIfOpen(id, p) { const r = rows.get(id); if (!r || r.claimed_at || r.revoked) return false; Object.assign(r, p); return true; },
  async list() { return [...rows.values()]; },
  async sweep() {},
};
const deps = { screens, history, store: doses, forecasts, night: { ready: false }, telegram: { ready: false } };
const ai = { async run() { return { response: '{"food":true,"items":[{"name":"rice","carbs_g":45},{"name":"beans","carbs_g":15}],"total_g":60,"low_g":45,"high_g":75,"confidence":"medium"}' }; } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
  const r = url.pathname === '/app' || url.pathname.startsWith('/app/') && (req.method === 'GET' || url.pathname === '/app/meal') && !['/app/me', '/app/history', '/app/report', '/app/recent'].includes(url.pathname)
    ? await proxy.fetch(request, { CGM_URL: `http://localhost:${PORT}`, AI: ai })
    : await handleCgm(url.pathname.slice(1), request, ENV, deps);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => server.listen(PORT, r));

// Two share codes, as su94r Mini makes them.
const share = async (role, name) => (await (await handleCgm('share/new', new Request(`http://localhost:${PORT}/share/new?key=tv-key-123`, { method: 'POST', body: JSON.stringify({ role, name }) }), ENV, deps)).json()).invite;
const checks = {};
const errors = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/service worker|sw\.js|favicon/i.test(m.text())) errors.push(m.text()); });
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shot = (n) => page.screenshot({ path: path.join(OUT, `app-${n}.png`), fullPage: true });
const tab = async (t) => { await page.click(`#tabs button[data-tab="${t}"]`); await page.waitForTimeout(300); };

await page.goto(`http://localhost:${PORT}/app/#join=${await share('me', 'Alex phone')}`);
await page.waitForSelector('text=This phone is linked');
checks.linked = (await page.evaluate(() => localStorage.getItem('su94rScreenToken')))?.length === 64;
checks.hashCleared = !(await page.evaluate(() => location.hash));
await shot('1-linked-more');
await tab('now');
await page.waitForSelector('.big .v');
checks.nowValue = /^\d+$/.test(await page.textContent('.big .v'));
checks.estimate = (await page.textContent('#main')).includes('Where it may head');
checks.nowFits = await noSideScroll();
await shot('2-now');
await tab('history');
await page.waitForSelector('.days');
checks.historyDays = (await page.$$('.days li')).length >= 14;
checks.historyFits = await noSideScroll();
await shot('3-history');
await page.click('.days li:nth-child(2) button');
await page.waitForSelector('text=‹ Back');
await shot('4-history-day');
await tab('log');
await page.click('button[data-amount="4"]');
checks.logButton = (await page.textContent('#logBtn')).includes('Log 4 units of rapid insulin');
await page.click('#logBtn');
await page.waitForSelector('#sheet');
await shot('5-confirm');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('#toast');
checks.logged = doseRows.some((d) => d.source === 'phone' && d.amount === 4);
await shot('6-logged');
await page.click('button[data-amount="4"]');
await page.click('#logBtn');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('.warnbox');
checks.doubleDoseWarning = (await page.textContent('.warnbox')).includes('You already logged 4 u rapid');
await shot('7-warning');
await page.click('#sheet button[data-b="1"]');
checks.notLoggedTwice = doseRows.filter((d) => d.source === 'phone' && !d.deleted).length === 1;
await page.click('button[data-undo]');
await page.waitForTimeout(400);
checks.undone = doseRows.filter((d) => d.source === 'phone' && !d.deleted).length === 0;
await page.click('button[data-kind="carbs"]');
await page.setInputFiles('#photo', path.join(import.meta.dirname, '..', 'workers', 'app', 'icon-512.png'));
await page.waitForSelector('.meal >> text=About');
checks.mealFilled = (await page.textContent('#amt')).startsWith('60');
checks.logFits = await noSideScroll();
await shot('8-meal');
await tab('report');
await page.waitForSelector('.report svg.agp');
checks.reportFits = await noSideScroll();
await shot('9-report');
await tab('more');
await page.waitForSelector('#unlink');
await shot('10-more');

// A family member's phone: reads, cannot log.
const fam = await ctx.newPage();
fam.on('pageerror', (e) => errors.push(e.message));
await fam.evaluate(() => 0).catch(() => {});
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => errors.push(e.message));
await p2.goto(`http://localhost:${PORT}/app/#join=${await share('family', 'Mom')}`);
await p2.waitForSelector('#unlink');
await p2.click('#tabs button[data-tab="log"]');
await p2.waitForSelector('text=This phone shows the glucose and the history');
checks.familyCannotLog = !(await p2.$('#logBtn'));
await p2.screenshot({ path: path.join(OUT, 'app-11-family-log.png'), fullPage: true });

// Dark mode
await page.emulateMedia({ colorScheme: 'dark' });
await tab('now');
await page.waitForSelector('.big .v');
await shot('12-now-dark');

await browser.close();
server.close();
console.log(JSON.stringify({ checks, errors }, null, 1));
process.exit(Object.values(checks).every(Boolean) && !errors.length ? 0 : 1);
