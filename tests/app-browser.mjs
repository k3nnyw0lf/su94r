// Browser check of the su94r phone app (/app/) against the real server and proxy code, with
// made-up readings: a share code links the phone; Now, History, Log, Report and More render on a
// phone-sized screen without sideways scrolling; a dose logs after the confirm sheet; a second
// dose shows the double-dose warning; Undo works; a meal photo fills in the carbs; a family
// member's phone cannot log; exercise mode turns on and off; the bedside screen turns red for a
// low and "I'm OK" stops it; the owner's emergency card saves, gets a QR picture and its page shows;
// a typed barcode fills in the carbs and the meal becomes a favorite; a note shows on the graph; an
// entry is changed; a dose logged with no signal waits on the phone and goes out when it is back;
// Now shows active insulin; History shows the goal, streaks and the months; a doctor visit reaches
// the calendar feed; with no phone to ring the owner's Now says so, a drill goes out, last night's
// unanswered lows show, and "Can I drive?" answers; a meter reading far from the sensor, high ketones,
// a pill, weight and exercise log, and the spreadsheet downloads; the big screen's family and car
// layouts show active insulin and the last meal, and a low turns the car layout red with its line;
// History reviews lows and meal timing; a phone in another time zone offers to switch.
//   node tests/app-browser.mjs  (needs playwright-core and Microsoft Edge)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { NIGHT_DEFAULTS } from '../workers/night.js';
import { valid } from '../workers/doses.js';
import proxy from '../workers/proxy.js';

const OUT = process.env.OUT || '.';
const PORT = 8793;
const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123' };
const now = Date.now(), MIN = 60e3, DAY = 864e5;
const fmt = (t) => { const d = new Date(t); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 ${ap}`; };
const curve = (t) => { const h = new Date(t).getHours() + new Date(t).getMinutes() / 60; return Math.round(115 + [8, 13, 19.5].reduce((s, m) => s + 70 * Math.exp(-(((h - m - 1) / 1.1) ** 2)), 0) - 30 * Math.exp(-(((h - 4) / 1.5) ** 2)) + 12 * Math.sin(t / 7e5)); };

let forceLow = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.host.includes('openfoodfacts')) return new Response(JSON.stringify({ status: 1, product: { product_name: 'Orange juice', brands: 'Grove', serving_size: '240 ml', serving_quantity: 240, nutriments: { carbohydrates_100g: 10, carbohydrates_serving: 24 } } }), { headers: { 'Content-Type': 'application/json' } });
  if (!u.host.includes('libreview')) return realFetch(url, init);
  const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
  const m = (t, mg, trend = 4) => ({ FactoryTimestamp: fmt(t), ValueInMgPerDl: mg, GlucoseUnits: 1, TrendArrow: trend });
  const conn = { patientId: 'p1', firstName: 'Alex', lastName: 'T', targetLow: 70, targetHigh: 180, glucoseMeasurement: forceLow ? m(Date.now() - MIN, 62, 2) : m(now - 2 * MIN, curve(now - 2 * MIN)), sensor: { sn: 'X', a: Math.round((now - 6 * DAY) / 1000) } };
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
  async list() { return [...rows.values()].filter((r) => r.claimed_at && !r.revoked); },
  async allowLog(id, canLog) { const r = rows.get(id); if (!r || r.kind !== 'screen' || r.role !== 'family') return false; r.can_log = canLog === true; return true; },
  async sweep() {},
};
let nightRow = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's-topic', care_topic: 'c-topic', treat_plan: '4 glucose tabs, then recheck', state: {} };
const night = { ready: true, async get() { return structuredClone(nightRow); }, async patch(p) { nightRow = { ...nightRow, ...structuredClone(p) }; }, async claimTick() { return false; } };
let supplyRows = [];
const supplies = { ready: true, async list() { return supplyRows; }, async save(r) { supplyRows = supplyRows.filter((x) => x.item !== r.item).concat([r]); }, async remove(pid, item) { supplyRows = supplyRows.filter((x) => x.item !== item); } };
let labRows = [];
const labs = { ready: true, async list() { return labRows.map((r, i) => ({ id: String(i), ...r })); }, async add(r) { labRows.push(r); }, async remove(pid, id) { labRows.splice(Number(id), 1); } };
let mealRows = [];
const meals = { ready: true, async list() { return mealRows.slice().sort((a, b) => b.uses - a.uses); }, async use(pid, name, carbs) { const m = mealRows.find((x) => x.name.toLowerCase() === name.toLowerCase()); if (m) { m.carbs = carbs; m.uses += 1; } else mealRows.push({ id: 'm' + mealRows.length, pid, name, carbs, uses: 1 }); return name; }, async remove(pid, id) { mealRows = mealRows.filter((x) => x.id !== id); } };
let noteRows = [];
const notes = { ready: true, async between(pid, from, to) { return noteRows.filter((n) => !n.deleted && n.pid === pid && Date.parse(n.t) >= from && Date.parse(n.t) < to).map((n) => ({ ...n, t: Date.parse(n.t) })); }, async get(id) { const n = noteRows.find((x) => x.id === id && !x.deleted); return n ? { ...n, t: Date.parse(n.t) } : null; }, async add(row) { if (!noteRows.some((x) => x.id === row.id)) noteRows.push({ ...row }); }, async remove(id) { const n = noteRows.find((x) => x.id === id); if (n) n.deleted = true; } };
const dailyRows = [];
for (let i = 75; i >= 1; i--) { const d = new Date(now - i * DAY).toISOString().slice(0, 10); dailyRows.push({ day: d, readings: 280, mean: 150 - i * 0.3, inRange: i <= 4 ? 0.82 : i === 5 ? 0.6 : 0.74, below: 0.02, above: 0.2, lows: i <= 2 ? 0 : 1 }); }
const daily = { ready: true, async since() { return dailyRows; } };
let visitRows = [];
const appointments = { ready: true, async from(pid, t) { return visitRows.filter((v) => Date.parse(v.at) >= t).map((v) => ({ ...v, at: Date.parse(v.at) })); }, async add(r) { visitRows.push({ id: 'v' + visitRows.length, ...r }); }, async remove(pid, id) { visitRows = visitRows.filter((v) => v.id !== id); } };
const drillSent = [];
let checkRows = [];
const checkStoreFake = { ready: true, async between(pid, from, to, kinds = null) { return checkRows.filter((r) => !r.deleted && Date.parse(r.t) >= from && Date.parse(r.t) < to && (!kinds || kinds.includes(r.kind))).map((r) => ({ ...r, t: Date.parse(r.t) })); }, async get(id) { const r = checkRows.find((x) => x.id === id && !x.deleted); return r ? { ...r, t: Date.parse(r.t) } : null; }, async add(list) { for (const r of list) if (!checkRows.some((x) => x.id === r.id)) checkRows.push({ ...r }); }, async remove(ids) { for (const r of checkRows) if (ids.includes(r.id)) r.deleted = true; } };
const deps = { checks: checkStoreFake, daily, appointments, meals, notes, screens, history, store: doses, forecasts, night, supplies, labs, telegram: { ready: false }, push: async (topic, msg) => { if (/drill/.test(msg.title || '')) drillSent.push(topic); }, pushStore: { ready: false } };
const ai = { async run() { return { response: '{"food":true,"items":[{"name":"rice","carbs_g":45},{"name":"beans","carbs_g":15}],"total_g":60,"low_g":45,"high_g":75,"confidence":"medium"}' }; } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
  // The proxy serves the app's own files and the meal photo; everything else is su94r-cgm.
  const proxied = url.pathname.startsWith('/d/') || url.pathname === '/app/qr' || /^\/e\/[0-9a-f]{64}$/.test(url.pathname) || /^\/cal\/[0-9a-f]{64}\.ics$/.test(url.pathname);
  const appFile = req.method === 'GET' && ['/app', '/app/', '/app/app.js', '/app/sw.js', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-192.png', '/app/icon-512.png', '/app/apple-touch-icon.png'].includes(url.pathname);
  const r = appFile || proxied || url.pathname === '/app/meal'
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
let page = await ctx.newPage();
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
checks.sensorEnds = /Sensor ends in \d+ days/.test(await page.textContent('#main'));
checks.estimate = (await page.textContent('#main')).includes('Where it may head');
checks.nowFits = await noSideScroll();
await shot('2-now');
await tab('history');
await page.waitForSelector('.days');
await page.waitForSelector('h2:has-text("Patterns")');
checks.patternsCard = true;
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
// Removing it from the list: Edit, then Remove.
await page.click('button[data-edit]');
await page.click('#sheet button[data-b="1"]');
await page.waitForSelector('#toast >> text=Removed.');
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
await page.waitForSelector('#labAdd');
await page.click('#labAdd');
await page.waitForSelector('#labValue');
await page.fill('#labValue', '7.1');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('text=Latest A1c');
checks.labInReport = labRows.length === 1 && (await page.textContent('.report')).includes('Latest A1c 7.1%');
await shot('9b-report-labs');
// Results online: Quest and the others open in a new tab; the owner adds MyChart and a pharmacy.
await page.waitForSelector('#portals a[data-portal="quest"]');
checks.portalsShown = (await page.getAttribute('#portals a[data-portal="quest"]', 'href')) === 'https://myquest.questdiagnostics.com/dashboard' &&
  (await page.getAttribute('#portals a[data-portal="quest"]', 'target')) === '_blank' && (await page.$$('#portals a')).length === 4;
await page.click('#linksEdit');
await page.waitForSelector('#lkMy');
await page.fill('#lkMy', 'mychart.example.org/MyChart/');
await page.selectOption('#lkPh', 'publix');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('#portals a[data-portal="pharmacy"]');
checks.portalsSaved = nightRow.portal_links?.pharmacy?.id === 'publix' && (await page.textContent('#portals')).includes('MyChart') && (await page.textContent('#portals')).includes('Publix');
checks.portalsFit = await noSideScroll();
await shot('9c-report-online');
await tab('more');
await page.waitForSelector('#unlink');
await shot('10-more');
// Supplies: add rapid insulin.
await page.click('button[data-supply=""]');
await page.waitForSelector('#supHave');
await page.selectOption('#supItem', 'rapid');
await page.fill('#supHave', '600');
await page.fill('#supWarn', '300');
await shot('10b-supply-sheet');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('button[data-supply="rapid"]');
checks.supplySaved = supplyRows.length === 1 && supplyRows[0].on_hand === 600;
checks.supplyShown = (await page.textContent('#main')).includes('Rapid insulin');
await shot('10c-supplies');

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
// The owner allows it from their own phone; the family phone can log.
await tab('more');
await page.waitForSelector('button[data-allow]');
await page.click('button[data-allow]');
await page.waitForSelector('text=That phone can log now.');
await page.waitForSelector('button[data-allow][data-on="0"]');
await shot('13-owner-allows');
await p2.click('#tabs button[data-tab="now"]');
await p2.click('#tabs button[data-tab="log"]');
await p2.waitForSelector('#logBtn');
await p2.click('button[data-kind="carbs"]');
await p2.click('button[data-amount="30"]');
await p2.click('#logBtn');
await p2.click('#sheet button[data-b="0"]');
await p2.waitForSelector('#toast');
checks.familyLogsWhenAllowed = doseRows.some((d) => d.source === 'phone' && d.kind === 'carbs' && d.amount === 30 && !d.deleted);
await p2.waitForSelector('.list .src >> text=phone · Mom');
checks.listSaysWho = true;
await p2.screenshot({ path: path.join(OUT, 'app-14-family-logs.png'), fullPage: true });

// A low: an alert's "I'm OK" carried in from a notification, then "I treated it".
forceLow = true;
resetCaches();
const ackToken = 'f'.repeat(32);
nightRow.state = { p1: { since: Date.now() - 10 * MIN, notified: Date.now() - 2 * MIN, count: 1, ackHash: await sha256(ackToken) } };
await page.goto(`http://localhost:${PORT}/app/?ack=${ackToken}`);
await page.waitForSelector('#ackBtn');
checks.ackQueryCleared = !(await page.evaluate(() => location.search));
await shot('15-alert-waiting');
await page.click('#ackBtn');
await page.waitForSelector('text=Got it. Reminders for this low stop.');
checks.ackFromNotification = Boolean(nightRow.state.p1.ackAt);
await page.waitForSelector('#treatBtn');
checks.planShown = (await page.textContent('#main')).includes('Your plan: 4 glucose tabs, then recheck');
await shot('16-treat-card');
await page.click('#treatBtn');
await page.waitForSelector('#sheet');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('text=Treating: 15 g');
checks.treated = Boolean(nightRow.state._treat && nightRow.state._treat.p1) && doseRows.some((d) => d.kind === 'carbs' && d.amount === 15 && !d.deleted);
checks.treatFits = await noSideScroll();
await shot('17-treating');
forceLow = false;
resetCaches();

// Spanish: the language switch under More; tabs, Now, Log and History in Spanish.
await tab('more');
await page.waitForSelector('button[data-lang="es"]');
await page.click('button[data-lang="es"]');
await page.waitForSelector('#tabs button[data-tab="now"] span >> text=Ahora');
checks.esTabs = (await page.textContent('#tabs')).includes('Historial') && (await page.textContent('#tabs')).includes('Más');
checks.esLang = (await page.evaluate(() => document.documentElement.lang)) === 'es';
await page.waitForSelector('text=Alertas de baja en esta app');
await shot('18-mas-es');
await tab('now');
await page.waitForSelector('.big .v');
checks.esNow = /en rango|Tratar la baja|actualizado|Actualizado/.test(await page.textContent('body'));
await shot('19-ahora-es');
await tab('log');
await page.waitForSelector('#logBtn');
checks.esLog = (await page.textContent('#main')).includes('Insulina rápida');
await page.click('button[data-amount="2"]');
await page.click('#logBtn');
await page.waitForSelector('#sheet');
checks.esConfirm = (await page.textContent('#sheet')).includes('¿Registrar 2 unidades de insulina rápida');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('#toast');
checks.esServerText = (await page.textContent('#toast')).startsWith('Registrado:');
await shot('20-registrar-es');
await tab('history');
await page.waitForSelector('.days');
checks.esHistory = (await page.textContent('#main')).includes('Día por día');
await page.click('#tabs button[data-tab="more"]');
await page.click('button[data-lang="en"]');
await page.waitForSelector('#tabs button[data-tab="now"] span >> text=Now');

// Exercise mode from Now, then off again.
await tab('now');
await page.waitForSelector('button[data-mode-ask="exercise"]');
await page.click('button[data-mode-ask="exercise"]');
await page.click('#sheet button[data-b="1"]');
await page.waitForSelector('text=🏃 Exercise mode');
checks.exerciseOn = nightRow.mode === 'exercise' && Date.parse(nightRow.mode_until) - Date.now() > 110 * MIN;
checks.modeFits = await noSideScroll();
await shot('21-exercise-mode');
await page.click('button[data-mode="off"]');
await page.waitForSelector('button[data-mode-ask="sick"]');
checks.modeOff = nightRow.mode === null;

// The bedside screen: dim when fine, red for a low nobody answered, "I'm OK" stops it.
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // the reading after the low scene
await page.waitForTimeout(1500);
await page.click('#bedBtn');
await page.waitForSelector('#bed .bed-clock');
checks.bedDim = !(await page.evaluate(() => document.getElementById('bed').classList.contains('alarm')));
await shot('22-bedside');
nightRow.state = { p1: { since: Date.now() - 10 * MIN, notified: Date.now() - 2 * MIN, count: 1, ackHash: 'x' } };
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForSelector('#bed.alarm', { timeout: 70000 });
checks.bedAlarm = true;
await shot('23-bedside-alarm');
await page.click('#bed button[data-bed="ok"]');
await page.waitForFunction(() => !document.getElementById('bed').classList.contains('alarm'), null, { timeout: 15000 });
checks.bedAck = Boolean(nightRow.state.p1.ackAt);
await page.click('#bed button[data-bed="close"]');
checks.bedClosed = !(await page.$('#bed'));
nightRow.state = {};

// The emergency card: edit, make the link, see the QR picture, open the page.
await tab('more');
await page.waitForSelector('#emEdit');
await page.click('#emEdit');
await page.fill('#emNote', 'Type 1 diabetes, uses insulin.');
await page.fill('#emN0', 'Mom');
await page.fill('#emP0', '239 555 0101');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('#main >> text=Type 1 diabetes, uses insulin.');
checks.cardSaved = nightRow.emergency && nightRow.emergency.contacts[0].phone === '239 555 0101';
await page.click('#emNew');
await page.waitForSelector('#emQr[src^="data:image/png"]');
checks.cardQr = true;
checks.cardFits = await noSideScroll();
await shot('24-emergency-card');
const cardLink = await page.evaluate(() => localStorage.getItem('su94rAppCard'));
const cardPage = await ctx.newPage();
cardPage.on('pageerror', (e) => errors.push(e.message));
await cardPage.goto(cardLink + '#preview');
await cardPage.waitForSelector('.name');
const cardText = await cardPage.textContent('main');
checks.cardPage = cardText.includes('Alex T') && cardText.includes('Type 1 diabetes, uses insulin.') && cardText.includes('Call Mom') && cardText.includes('4 glucose tabs');
checks.cardPageFits = await cardPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
await cardPage.screenshot({ path: path.join(OUT, 'app-25-emergency-page.png'), fullPage: true });
await cardPage.click('#lang');
checks.cardPageEs = (await cardPage.textContent('main')).includes('Llamar al 911');
await cardPage.screenshot({ path: path.join(OUT, 'app-26-emergency-page-es.png'), fullPage: true });
await cardPage.close();

// Nobody to ring: the owner's Now says so; a drill goes out; last night's unanswered lows show.
nightRow.morning = { for: 'today', at: Date.now() - 2 * 3600e3, unanswered: 2, lows: [{ pid: 'p1', since: Date.now() - 8 * 3600e3, lowest: 53, lowestAt: Date.now() - 8 * 3600e3, answered: false }, { pid: 'p1', since: Date.now() - 6 * 3600e3, lowest: 61, answered: false }] };
await page.goto(`http://localhost:${PORT}/app/`);
await page.waitForSelector('#tabs button[data-tab="now"]');
await page.click('#tabs button[data-tab="now"]');
await page.waitForSelector('text=Your low alerts reach no phone');
checks.reachWarning = true;
await page.waitForSelector('text=Last night: 2 lows, none answered');
checks.morningCard = (await page.textContent('#main')).includes('Lowest 53 mg/dL');
await shot('33-reach-morning');
await page.click('#drillBtn');
await page.waitForSelector('#toast >> text=Drill sent');
checks.drillSent = drillSent.includes('s-topic') && Boolean(nightRow.drill && nightRow.drill.hashes && nightRow.drill.hashes['me.ntfy']);
await page.click('#morningOk');
await page.waitForFunction(() => !document.body.textContent.includes('Last night: 2 lows'));
await page.click('#driveBtn');
await page.waitForSelector('#sheet >> text=DVLA');
checks.driveCheck = /above 90|eat first|falling|don't drive|No fresh reading/.test(await page.textContent('#sheet h3'));
await shot('34-drive');
await page.click('#sheet button[data-b="0"]');

// Meter, ketones, a pill, weight and exercise; the spreadsheet.
await page.click('#tabs button[data-tab="log"]');
points.push({ t: Date.now(), mg: 150 });                         // the sensor's reading at the meter check
await page.click('button[data-kind="meter"]');
await page.fill('#chkValue', '60');
await page.click('#chkBtn');
await page.waitForSelector('#sheet >> text=Meter check');
checks.meterVsSensor = /The sensor read \d+ mg\/dL then, \d+% higher/.test(await page.textContent('#sheet'));
await shot('35-meter-check');
await page.click('#sheet button[data-b="0"]');
await page.click('button[data-kind="ketone"]');
await page.fill('#chkValue', '2.0');
await page.click('#chkBtn');
await page.waitForSelector('#sheet >> text=Ketone result');
checks.ketonesHigh = (await page.textContent('#sheet')).includes('risk of DKA');
await page.click('#sheet button[data-b="0"]');
await page.click('button[data-kind="med"]');
await page.waitForSelector('#chkLabel');
await page.fill('#chkLabel', 'Atorvastatin');
await page.click('#chkBtn');
await page.waitForSelector('#toast >> text=Logged Atorvastatin.');
await page.click('button[data-kind="weight"]');
await page.click('button[data-wunit="lb"]');
await page.fill('#chkValue', '181.7');
await page.click('#chkBtn');
await page.waitForSelector('#toast >> text=82.4 kg');
await page.click('button[data-kind="exercise"]');
await page.click('button[data-act="run"]');
await page.click('button[data-mins="30"]');
await page.click('#chkBtn');
await page.waitForSelector('#toast >> text=30 min of run');
checks.checksLogged = ['meter', 'ketone', 'med', 'weight', 'exercise'].every((k) => checkRows.some((r) => r.kind === k));
checks.checksListed = /🩸 60 mg\/dL/.test(await page.textContent('.list')) && (await page.textContent('.list')).includes('⚖️ 181.7 lb');
checks.checksFit = await noSideScroll();
await shot('36-checks');
await page.click('#tabs button[data-tab="now"]');
await page.waitForSelector('svg.g circle[r="7"]');
checks.meterDot = true;
await page.click('#tabs button[data-tab="more"]');
await page.waitForSelector('#exportBtn');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
const csvText = fs.readFileSync(await dl.path(), 'utf8');
checks.exportCsv = csvText.startsWith('local time,iso time,type') && /,meter,60,mg\/dL,/.test(csvText) && csvText.includes(',weight,82.4,kg,');

// A typed barcode fills in the carbs; logging it with its name makes a favorite.
await page.close();
const p3 = await ctx.newPage();
p3.on('pageerror', (e) => errors.push(e.message));
await p3.goto(`http://localhost:${PORT}/app/#join=${await share('me', 'Alex phone 2')}`);
await p3.waitForSelector('text=This phone is linked');
await p3.click('#tabs button[data-tab="log"]');
await p3.waitForSelector('button[data-kind="carbs"]');
await p3.click('button[data-kind="carbs"]');
await p3.click('#scanBtn');
await p3.fill('#scanCode', '0 12345 67890 5');
await p3.click('#sheet button[data-b="0"]');
await p3.waitForSelector('#sheet >> text=Grove · Orange juice');
await p3.click('#sheet button[data-serv="2"]');
await p3.waitForSelector('#sheet button[data-b="0"] >> text=Use 48 g');
await p3.screenshot({ path: path.join(OUT, 'app-27-barcode.png') });
await p3.click('#sheet button[data-b="0"]');
await p3.waitForSelector('#amt >> text=48');
checks.barcodeFilled = true;
await p3.click('#logBtn');
checks.mealNamePrefilled = (await p3.inputValue('#mealName')) === 'Grove · Orange juice';
await p3.fill('#mealName', 'OJ');
await p3.click('#sheet button[data-b="0"]');
await p3.waitForSelector('#toast');
checks.favoriteSaved = mealRows.some((m) => m.name === 'OJ' && m.carbs === 48);
await p3.click('button[data-kind="rapid"]');
await p3.click('button[data-kind="carbs"]');
await p3.waitForSelector('button[data-fav="0"] >> text=OJ · 48 g');
checks.favoriteChip = true;
await p3.screenshot({ path: path.join(OUT, 'app-28-favorites.png'), fullPage: true });

// A note with a tag: in the list and as a diamond on the Now graph.
await p3.click('button[data-kind="note"]');
await p3.click('button[data-tag="exercise"]');
await p3.fill('#noteText', 'Walked 30 minutes');
await p3.click('#noteBtn');
await p3.waitForSelector('.list >> text=Walked 30 minutes · Exercise');
checks.noteSaved = noteRows.some((n) => n.text === 'Walked 30 minutes' && n.tags[0] === 'exercise');
await p3.screenshot({ path: path.join(OUT, 'app-29-note.png'), fullPage: true });
await p3.click('#tabs button[data-tab="now"]');
await p3.waitForSelector('svg.g rect[transform^="rotate(45"]');
checks.noteOnGraph = true;

// Change an entry: the juice becomes 40 g.
await p3.click('#tabs button[data-tab="log"]');
const juice = doseRows.find((d) => d.kind === 'carbs' && d.amount === 48 && !d.deleted);
await p3.click(`button[data-edit="${juice.id}"]`);
await p3.fill('#edAmt', '40');
await p3.click('#sheet button[data-b="0"]');
await p3.waitForSelector('#toast >> text=Changed to 40 g of carbs.');
checks.edited = juice.deleted === true && doseRows.some((d) => d.kind === 'carbs' && d.amount === 40 && !d.deleted);

// No signal: the dose waits on the phone, then goes out when the phone is back online.
await p3.click('button[data-kind="rapid"]');
await p3.click('button[data-amount="1"]');
await ctx.setOffline(true);
await p3.click('#logBtn');
await p3.click('#sheet button[data-b="0"]');
await p3.waitForSelector('text=No signal: saved on this phone');
await p3.waitForSelector('.list >> text=waiting to send');
checks.queuedOffline = !doseRows.some((d) => d.kind === 'rapid' && d.amount === 1 && d.source === 'phone');
await p3.screenshot({ path: path.join(OUT, 'app-30-offline.png'), fullPage: true });
await ctx.setOffline(false);
await p3.evaluate(() => window.dispatchEvent(new Event('online')));
await p3.waitForFunction(() => !(JSON.parse(localStorage.getItem('su94rAppQueue') || '[]')).length, null, { timeout: 15000 });
// A dose already logged a little earlier: the double-dose question comes up for the waiting one too.
if (await p3.waitForSelector('#sheet >> text=Saved while offline', { timeout: 6000 }).catch(() => null)) { checks.offlineAsksFirst = true; await p3.click('#sheet button[data-b="0"]'); await p3.waitForSelector('#toast'); }
const sentLater = doseRows.filter((d) => d.kind === 'rapid' && d.amount === 1 && d.source === 'phone' && !d.deleted);
checks.sentWhenBack = sentLater.length === 1 && Date.now() - sentLater[0].t > 0;
checks.everydayFits = await p3.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
page = p3;

// Active insulin on Now; goal, streaks and months in History; the owner changes the goal.
await page.click('#tabs button[data-tab="now"]');
await page.waitForSelector('#main >> text=Active insulin: about');
checks.activeInsulin = true;
await page.waitForSelector('#main >> text=days in a row at 70%+ in range');
checks.streakOnNow = true;
await page.click('#tabs button[data-tab="history"]');
await page.waitForSelector('h2:has-text("Goal: 70% in range")');
await page.waitForSelector('h2:has-text("Month by month")');
checks.monthsChart = (await page.$$('svg[aria-label="GMI by month and lab A1c"] circle')).length >= 2 && (await page.$$('svg[aria-label="GMI by month and lab A1c"] rect')).length === 1;
await page.locator('h2:has-text("Goal: 70% in range")').scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(OUT, 'app-31-goal-months.png'), fullPage: true });
await page.click('#goalBtn');
await page.selectOption('#goalSel', '80');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('h2:has-text("Goal: 80% in range")');
checks.goalChanged = nightRow.goal_tir === 80;

// A doctor visit, then the calendar feed has it.
await page.click('#tabs button[data-tab="more"]');
await page.waitForSelector('#visitAdd');
await page.click('#visitAdd');
await page.fill('#vTitle', 'Dr. Lee');
await page.fill('#vPlace', 'Naples');
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('#main >> text=Dr. Lee · Naples');
await page.click('#calNew');
await page.waitForSelector('a:has-text("Google Calendar")');
const calLink = await page.evaluate(() => localStorage.getItem('su94rAppCal'));
const ics = await (await fetch(calLink)).text();
checks.calendarFeed = ics.startsWith('BEGIN:VCALENDAR') && ics.includes('SUMMARY:Dr. Lee') && ics.includes('LOCATION:Naples') && ics.includes('Change the sensor');
// On https the feed is offered as webcal://; this test server is plain http.
const gHref = await page.getAttribute('a:has-text("Google Calendar")', 'href');
checks.googleLink = gHref.startsWith('https://calendar.google.com/calendar/r?cid=') && decodeURIComponent(gHref.split('cid=')[1]).endsWith(calLink.replace(/^https?:/, ''));
checks.insightsFits = await noSideScroll();
await page.locator('h2:has-text("Calendar")').scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(OUT, 'app-32-calendar.png'), fullPage: true });

// History: lows and meal timing. Now: a phone in another time zone than the night hours.
await page.click('#tabs button[data-tab="history"]');
await page.click('button[data-days="14"]');
await page.waitForSelector('h2:has-text("Lows and their treatment")', { timeout: 20000 });
checks.lowsCard = /lows? in 14 days|No lows/.test(await page.textContent('#main')) && (await page.textContent('#main')).includes('Insulin timing and meals');
const phoneZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
nightRow.time_zone = phoneZone === 'Europe/Madrid' ? 'Asia/Tokyo' : 'Europe/Madrid';
await page.click('#tabs button[data-tab="now"]');
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForSelector('text=You seem to be in', { timeout: 20000 });
await page.click('button[data-tz]');
await page.waitForSelector('#toast >> text=now follow');
checks.travelSwitch = nightRow.time_zone === phoneZone;

// Medals: the card on History, a medal's sheet, sharing a picture without numbers; a new medal on Now.
await page.click('#tabs button[data-tab="history"]');
await page.waitForSelector('h2:has-text("Medals")', { timeout: 20000 });
checks.medalsCard = (await page.$$('.medal')).length >= 3 && (await page.textContent('.medals')).includes('30-day in-range streak');
checks.medalsKept = Boolean(nightRow.medals && nightRow.medals.p1 && nightRow.medals.p1.range30);
await page.evaluate(() => { window.__shared = null; Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true }); Object.defineProperty(navigator, 'share', { value: async (d) => { window.__shared = { n: d.files.length, type: d.files[0].type, size: d.files[0].size, text: d.text }; }, configurable: true }); });
await page.click('.medal[data-medal="range30"]');
await page.waitForSelector('#sheet button[data-b="0"]');
await page.click('#sheet button[data-b="0"]');
await page.waitForFunction(() => window.__shared);
const shared = await page.evaluate(() => window.__shared);
checks.medalShared = shared.n === 1 && shared.type === 'image/png' && shared.size > 5000 && shared.text.includes('30-day in-range streak');
await shot('33-medals');
await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('su94rAppMedals') || '{}'); s.p1 = []; localStorage.setItem('su94rAppMedals', JSON.stringify(s)); });
await page.click('#tabs button[data-tab="now"]');
await page.waitForSelector('text=New medal:', { timeout: 20000 });
await page.click('#medalsOk');
await page.waitForFunction(() => !document.body.textContent.includes('New medal:'));
checks.medalBanner = true;

// Supplements under More, with Fullscript; refills on Now.
await page.click('#tabs button[data-tab="more"]');
await page.waitForSelector('#fsLink');
checks.fullscriptLink = (await page.getAttribute('#fsLink', 'href')) === 'https://us.fullscript.com/login';
await page.click('button[data-supp=""]');
await page.waitForSelector('#spName');
await page.fill('#spName', 'Fish oil');
await page.fill('#spDose', '2 softgels');
await page.fill('#spTimes', '8:00, 20:00');
await page.fill('#spOut', new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10));
await page.click('#sheet button[data-b="0"]');
await page.waitForSelector('#suppList >> text=Fish oil');
checks.supplementSaved = Array.isArray(nightRow.supplements) && nightRow.supplements[0].name === 'Fish oil' && nightRow.supplements[0].times.join(',') === '8:00,20:00';
checks.moreFits = await noSideScroll();
await shot('34-supplements');
await page.click('#tabs button[data-tab="now"]');
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForSelector('text=Running out soon', { timeout: 20000 });
checks.refillCard = (await page.textContent('#main')).includes('Fish oil: runs out');

// The big screen: family dashboard and car layouts.
const tv = await ctx.newPage();
tv.on('pageerror', (e) => errors.push(e.message));
await tv.setViewportSize({ width: 1280, height: 800 });
await tv.goto(`http://localhost:${PORT}/d/tv-key-123?view=family`);
await tv.waitForSelector('.fcard');
checks.familyView = /Active insulin about [\d.]+ u/.test(await tv.textContent('.fcard')) && (await tv.textContent('.fcard')).includes('Last meal');
await tv.screenshot({ path: path.join(OUT, 'tv-family.png') });
forceLow = true;
resetCaches();
await tv.goto(`http://localhost:${PORT}/d/tv-key-123?view=car`);
await tv.waitForSelector('.car .tip');
checks.carLow = (await tv.textContent('.tip')).includes('treat the low') && (await tv.getAttribute('#main', 'data-c')) === 'low';
checks.soundAsk = Boolean(await tv.waitForSelector('#sndBtn', { timeout: 6000 }).catch(() => null));
await tv.click('#sndBtn');
await tv.waitForTimeout(300);
checks.soundAllowed = !(await tv.$('#sndBtn'));
await tv.screenshot({ path: path.join(OUT, 'tv-car-low.png') });
await tv.click('#viewBtn');
await tv.click('.viewMenu button[data-v="standard"]');
await tv.waitForSelector('.read .val');
checks.viewSwitch = (await tv.evaluate(() => localStorage.getItem('su94rView'))) === 'standard';
await tv.close();
forceLow = false;
resetCaches();

// Dark mode
await page.emulateMedia({ colorScheme: 'dark' });
await tab('now');
await page.waitForSelector('.big .v');
await shot('12-now-dark');

await browser.close();
server.close();
console.log(JSON.stringify({ checks, errors }, null, 1));
process.exit(Object.values(checks).every(Boolean) && !errors.length ? 0 : 1);
