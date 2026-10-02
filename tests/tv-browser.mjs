// Browser check of the /tv pairing page against the real server code (LibreLinkUp faked):
// the page shows a code, the code is claimed as su94r Mini would, the page shows glucose.
//   node tests/tv-browser.mjs  (needs playwright-core and Microsoft Edge)
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { handleCgm } from '../workers/cgm-core.js';
import { displayPage } from '../workers/display.js';

const OUT = process.env.OUT || '.';
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const now = Date.now();
const fmt = (t) => { const d = new Date(t); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 ${ap}`; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (!u.host.includes('libreview')) return realFetch(url, init);
  const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
  const m = (t, mg, trend = 4) => ({ FactoryTimestamp: fmt(t), ValueInMgPerDl: mg, GlucoseUnits: 1, TrendArrow: trend });
  const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: m(now - 60e3, 142) };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  const graphData = [];
  for (let t = now - 12 * 3600e3; t < now - 5 * 60e3; t += 15 * 60e3) graphData.push(m(t, Math.round(130 + 45 * Math.sin((t - now) / 5e6))));
  return res({ status: 0, data: { connection: conn, graphData } });
};

// In-memory screens store (same interface as workers/screens.js).
const rows = new Map();
const screens = {
  ready: true,
  async insert(r) { rows.set(r.id, { claimed_at: null, revoked: false, token_hash: null, token_once: null, last_seen: null, ...r }); },
  async bySecret(h) { return [...rows.values()].find((r) => r.secret_hash === h && !r.revoked) || null; },
  async byCode(c) { return [...rows.values()].find((r) => r.code === c && !r.claimed_at && !r.revoked) || null; },
  async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h && !r.revoked) || null; },
  async update(id, patch) { Object.assign(rows.get(id), patch); },
  async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
  async sweep() {},
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/tv') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(displayPage('', { pair: true }));
  }
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await handleCgm(url.pathname.slice(1), request, ENV, { screens });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
});
await new Promise((r) => server.listen(8791, r));

let failed = 0;
const check = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) failed++; };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:8791/tv');
await page.waitForSelector('.code');
const code = (await page.textContent('.code')).trim();
check(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code), `the screen shows a code (${code})`);
await page.screenshot({ path: path.join(OUT, 'tv-1-code.png') });

// su94r Mini claims it.
const claim = await handleCgm('pair/claim', new Request('http://localhost/pair/claim?key=tv-key-123', { method: 'POST', body: JSON.stringify({ code, name: 'Kitchen fridge' }) }), ENV, { screens });
check((await claim.json()).ok, 'su94r Mini claimed the code');
await page.waitForSelector('.val', { timeout: 10000 });
await page.waitForTimeout(500);
check((await page.textContent('.val')).trim() === '142', `the screen shows the glucose (${(await page.textContent('.val')).trim()})`);
check(await page.$('#graph path') !== null, 'with its graph');
await page.screenshot({ path: path.join(OUT, 'tv-2-glucose.png') });
check(await page.evaluate(() => Boolean(localStorage.getItem('su94rScreenToken'))), 'the screen kept its token');

await page.setViewportSize({ width: 320, height: 300 });
await page.waitForTimeout(300);
await page.evaluate(() => render());
check(await page.evaluate(() => document.documentElement.classList.contains('small')), 'widget-sized screens get the compact layout');
await page.screenshot({ path: path.join(OUT, 'tv-3-widget.png') });

// Removing the screen in su94r Mini sends it back to a new code.
const id = [...rows.values()].find((r) => r.claimed_at).id;
await screens.update(id, { revoked: true });
await page.evaluate(() => load());
await page.waitForSelector('.code', { timeout: 10000 });
check((await page.textContent('.code')).trim() !== code, 'a removed screen shows a new code');

await browser.close();
server.close();
console.log(failed ? `${failed} CHECKS FAILED` : 'ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
