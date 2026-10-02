// Real end-to-end check of app alerts: Microsoft Edge subscribes through its real push service,
// the server code (app/push/test → webpush.js) encrypts and sends through that service, and the
// app's service worker shows the notification. Proves the encryption and VAPID work with a real
// browser, not only against the RFC's example.
//   node tests/push-browser.mjs  (needs playwright-core and Microsoft Edge, and internet)
import http from 'node:http';
import { chromium } from 'playwright-core';
import { handleCgm } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { makeVapidKeys } from '../workers/webpush.js';
import proxy from '../workers/proxy.js';

const PORT = 8794;
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const TOKEN = 'e'.repeat(64);
const rows = new Map([['eeeeeeee-1', { id: 'eeeeeeee-1', kind: 'screen', role: 'me', name: 'Test phone', token_hash: await sha256(TOKEN), claimed_at: new Date().toISOString(), revoked: false }]]);
const screens = { ready: true, async byToken(h) { return [...rows.values()].find((r) => r.token_hash === h) || null; }, async update() { return []; }, async list() { return [...rows.values()]; } };
const vk = await makeVapidKeys();
const keys = { publicKey: vk.publicKey, privateKey: await crypto.subtle.importKey('jwk', vk.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
const subs = [];
const results = [];
const push = {
  ready: true,
  async publicKey() { return vk.publicKey; }, async keys() { return keys; },
  async add(screenId, s) { subs.splice(0, subs.length, { id: '1', screen_id: screenId, ...s }); },
  async remove() {}, async forScreen() { return subs; }, async forRole() { return subs; },
  async ok(id) { results.push(['ok', id]); }, async gone(id) { results.push(['gone', id]); }, async failed(id, n) { results.push(['failed', id, n]); },
};
const deps = { screens, pushStore: push, store: { ready: false }, history: { ready: false }, forecasts: { ready: false }, night: { ready: false }, telegram: { ready: false } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
  const appFile = req.method === 'GET' && ['/app/', '/app/app.js', '/app/sw.js', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-192.png'].includes(url.pathname);
  const r = appFile ? await proxy.fetch(request, {}) : await handleCgm(url.pathname.slice(1), request, ENV, deps);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => server.listen(PORT, r));

const out = { subscribed: false, endpointHost: null, pushServiceAnswer: null, notification: null, errors: [] };
const headless = process.env.HEADED ? false : true;
const ctx = await chromium.launchPersistentContext('', { channel: 'msedge', headless, args: ['--enable-features=PushMessaging'] });
try {
  await ctx.grantPermissions(['notifications'], { origin: `http://localhost:${PORT}` });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/app/`);
  await page.evaluate((t) => localStorage.setItem('su94rScreenToken', t), TOKEN);
  await page.goto(`http://localhost:${PORT}/app/`);
  const sub = await page.evaluate(async (key) => {
    const reg = await navigator.serviceWorker.ready;
    const b = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(b, (c) => c.charCodeAt(0)) });
    const j = s.toJSON();
    const r = await fetch('/app/push/subscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('su94rScreenToken'), 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
    return { status: r.status, endpoint: j.endpoint };
  }, vk.publicKey).catch((e) => ({ error: e.message }));
  if (sub.error) throw new Error('subscribe failed: ' + sub.error);
  out.subscribed = sub.status === 200;
  out.endpointHost = new URL(sub.endpoint).hostname;
  const t = await handleCgm('app/push/test', new Request(`http://localhost:${PORT}/app/push/test`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }), ENV, deps);
  out.pushServiceAnswer = { status: t.status, store: results.slice() };
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  for (let i = 0; i < 30 && !out.notification; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const n = await sw.evaluate(() => self.registration.getNotifications().then((l) => l.map((x) => ({ title: x.title, body: x.body, tag: x.tag }))));
    if (n.length) out.notification = n[0];
  }
} catch (e) {
  out.errors.push(e.message);
} finally {
  await ctx.close();
  server.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.notification ? 0 : 1);
