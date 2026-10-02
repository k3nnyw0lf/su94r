// Doctor report: an Ambulatory Glucose Profile (AGP) style summary to print or save as a PDF
// for an appointment. Same measures and targets as the international consensus on time in
// range (Battelino et al., Diabetes Care 2019): time below/in/above range, GMI, CV, and the
// 5/25/50/75/95th percentile curve by time of day, plus the logged insulin and meals and
// the insulin timing su94r Mini measured. It describes the past only; it suggests nothing.

import { watchContext } from './lifecycle.js';
import { withDefaults, displayUnits, fmtGlucose, mergeSeries, INSULIN_KINDS, localDate } from './glucose.js';
import { loadReadings, wholeSeries } from './archive.js';
import { allPatients } from './store.js';
import { insulinTiming } from './insights.js';
import { reportPdf, toBase64 } from './reportpdf.js';
import { getToken, DRIVE_SCOPES, GOOGLE_HOSTS, saveBlob } from './google.js';
import { tgDocument } from './voice.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const DAY = 864e5;

export { agp } from './agp.js';
import { agp } from './agp.js';

const pct = (x) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`;
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function rangeBar(r) {
  const parts = [['veryHigh', 'Very high (>250)', 'vh'], ['high', 'High (181–250)', 'h'], ['inRange', 'In range (70–180)', 'in'], ['low', 'Low (54–69)', 'l'], ['veryLow', 'Very low (<54)', 'vl']];
  const targets = { veryHigh: '<5%', high: '<25% with very high', inRange: '>70%', low: '<4% with very low', veryLow: '<1%' };
  const bar = el('div', { class: 'bar' }, ...parts.map(([k, , c]) => {
    const s = el('span', { class: `seg ${c}` });
    s.style.flexGrow = String(Math.max(r[k], 0.004));
    return s;
  }));
  const legend = el('table', { class: 'legend' }, ...parts.map(([k, label, c]) =>
    el('tr', {}, el('td', {}, el('span', { class: `dot ${c}` }), ` ${label}`), el('td', { class: 'num' }, pct(r[k])), el('td', { class: 'target' }, `target ${targets[k]}`))));
  return el('div', { class: 'ranges' }, bar, legend);
}

function profileChart(r, units, low, high) {
  const W = 720, H = 260, padL = 40, padB = 24;
  const plotW = W - padL - 10, plotH = H - padB - 10;
  const top = Math.max(300, ...r.profile.filter(Boolean).map((p) => p.p95));
  const bottom = 40;   // the axis starts at 40 mg/dL so 54 and 70 do not crowd each other
  const y = (mg) => 10 + plotH - ((Math.min(Math.max(mg, bottom), top) - bottom) / (top - bottom)) * plotH;
  const x = (slot) => padL + (slot / 95) * plotW;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'agp', role: 'img', 'aria-label': 'Glucose percentiles by time of day' });
  s.append(svg('rect', { x: padL, y: y(high), width: plotW, height: y(low) - y(high), class: 'band' }));
  for (const v of [54, low, high, 250]) {
    s.append(svg('line', { x1: padL, x2: W - 10, y1: y(v), y2: y(v), class: 'grid' }));
    const t = svg('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = fmtGlucose(v, units);
    s.append(t);
  }
  for (let h = 0; h <= 24; h += 3) {
    const t = svg('text', { x: x(Math.min(95, h * 4)), y: H - 6, 'text-anchor': 'middle' });
    t.textContent = h === 24 ? '12a' : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
    s.append(t);
  }
  const pts = r.profile.filter(Boolean);
  const area = (a, b) => `M${pts.map((p) => `${x(p.slot).toFixed(1)},${y(p[a]).toFixed(1)}`).join('L')}L${[...pts].reverse().map((p) => `${x(p.slot).toFixed(1)},${y(p[b]).toFixed(1)}`).join('L')}Z`;
  if (pts.length > 1) {
    s.append(svg('path', { d: area('p95', 'p5'), class: 'p5' }));
    s.append(svg('path', { d: area('p75', 'p25'), class: 'p25' }));
    s.append(svg('path', { d: `M${pts.map((p) => `${x(p.slot).toFixed(1)},${y(p.p50).toFixed(1)}`).join('L')}`, class: 'p50' }));
  }
  return s;
}

function stat(label, value, note = '') {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-v' }, value), el('div', { class: 'stat-l' }, label), note ? el('div', { class: 'stat-n' }, note) : '');
}

async function build() {
  const params = new URLSearchParams(location.search);
  const { settings: raw, events = [] } = await chrome.storage.local.get(['settings', 'events']);
  const settings = withDefaults(raw);
  const people = await allPatients(settings);
  const pid = params.get('p') && people.some((p) => p.pid === params.get('p')) ? params.get('p') : people[0]?.pid;
  const days = Number(params.get('days')) || 14;
  $('who').replaceChildren(...people.map((p) => new Option(p.name || 'Unnamed', p.pid, false, p.pid === pid)));
  $('days').value = String(days);
  const person = people.find((p) => p.pid === pid);
  if (!person) { $('report').replaceChildren(el('p', {}, 'No one to report on yet.')); return; }
  const units = displayUnits(settings, person);
  const to = Date.now();
  const from = to - days * DAY;
  const saved = wholeSeries(await loadReadings(pid, from));
  const recent = mergeSeries(person.hist, person.live);
  const cutoff = recent.length ? recent[0].t : Infinity;
  const points = [...saved.filter((p) => p.t < cutoff - 60e3), ...recent];
  const mine = events.filter((e) => e.p === pid);
  const r = agp(points, mine, { from, to, low: person.low ?? 70, high: person.high ?? 180 });
  const timing = insulinTiming(points, mine, pid, { now: to });

  const insulinRows = Object.entries(r.insulin).map(([k, v]) => el('tr', {},
    el('td', {}, INSULIN_KINDS[k] || k),
    el('td', { class: 'num' }, String(v.doses)),
    el('td', { class: 'num' }, v.withAmount ? (v.units / r.days).toFixed(1) : '—'),
    el('td', { class: 'num' }, v.withAmount ? (v.units / v.withAmount).toFixed(1) : '—')));

  $('report').replaceChildren(
    el('header', { class: 'r-head' },
      el('div', {}, el('h1', {}, 'Glucose report'), el('div', { class: 'muted' }, `${person.name || ''} · ${localDate(from)} to ${localDate(to)} (${days} days) · ${units}`)),
      el('div', { class: 'muted small' }, 'From su94r Mini (FreeStyle Libre via LibreLinkUp). Not a medical device.')),
    el('section', { class: 'stats' },
      stat('Average glucose', r.mean != null ? `${fmtGlucose(r.mean, units)} ${units}` : '—'),
      stat('GMI', r.gmi != null ? `${r.gmi.toFixed(1)}%` : '—', 'estimated from the average'),
      stat('Variability (CV)', r.cv != null ? `${r.cv.toFixed(1)}%` : '—', 'target ≤36%'),
      stat('Sensor data', pct(r.coverage), r.coverage < 0.7 ? 'below the 70% advised for a reliable report' : 'of the period')),
    el('h2', {}, 'Time in ranges'),
    rangeBar(r),
    el('h2', {}, 'Glucose by time of day'),
    el('p', { class: 'muted small' }, 'Median line, 25–75% band and 5–95% band of all days, by time of day; target range shaded.'),
    profileChart(r, units, person.low ?? 70, person.high ?? 180),
    el('h2', {}, 'Logged insulin and meals'),
    insulinRows.length
      ? el('table', { class: 'tbl' }, el('tr', {}, el('th', {}, 'Insulin'), el('th', {}, 'Doses'), el('th', {}, 'Units per day'), el('th', {}, 'Units per dose')), ...insulinRows)
      : el('p', { class: 'muted' }, 'No insulin logged in this period.'),
    el('p', { class: 'muted small' }, `${r.meals.count} meal${r.meals.count === 1 ? '' : 's'} logged${r.meals.carbs ? `, ${Math.round(r.meals.carbs / r.days)} g carbs per day on average` : ''}. Logged markers are what was entered and may be incomplete.`),
    el('h2', {}, 'Insulin timing measured from this history'),
    timing.enough
      ? el('p', {}, `From ${timing.correction.n} clean rapid doses: starts working after about ${Math.round(timing.correction.onset)} min, works hardest at about ${Math.round(timing.correction.peak)} min, mostly done by about ${Math.round(timing.correction.end)} min.`)
      : el('p', { class: 'muted' }, `Not enough clean rapid doses yet (${timing.usable || 0} usable of ${timing.total || 0}).`),
  );
  document.title = `Glucose report · ${person.name || ''} · ${localDate(to)}`;
}

$('who')?.addEventListener('change', (e) => { const p = new URLSearchParams(location.search); p.set('p', e.target.value); location.search = p; });
$('days')?.addEventListener('change', (e) => { const p = new URLSearchParams(location.search); p.set('days', e.target.value); location.search = p; });
$('print')?.addEventListener('click', () => print());

// ---- the report as a PDF: download, Drive, Telegram (no print dialog) ----
const fileName = () => `su94r-glucose-report-${new Date().toISOString().slice(0, 10)}.pdf`;
const say = (text) => { $('status').textContent = text; };
async function makePdf() {
  say('Making the PDF…');
  const css = await (await fetch('report.css')).text();
  return new Blob([await reportPdf($('report'), css, { title: document.title })], { type: 'application/pdf' });
}
async function run(fn) {
  for (const b of document.querySelectorAll('.toolbar button')) b.disabled = true;
  try { await fn(); } catch (e) { say(e.message || 'That did not work.'); }
  for (const b of document.querySelectorAll('.toolbar button')) b.disabled = false;
}
$('pdf')?.addEventListener('click', () => run(async () => {
  const blob = await makePdf();
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fileName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
  say(`PDF ready (${Math.round(blob.size / 1024)} KB).`);
}));
$('drive')?.addEventListener('click', () => run(async () => {
  const ok = await chrome.permissions.request({ origins: GOOGLE_HOSTS }).catch(() => false);
  if (!ok) throw new Error('su94r Mini needs permission to reach Google Drive.');
  const token = await getToken(DRIVE_SCOPES, { interactive: true });
  const blob = await makePdf();
  say('Saving to Drive…');
  const f = await saveBlob(token, fileName(), blob, 'application/pdf');
  say('Saved in your Drive, folder "su94r".');
  if (f?.webViewLink) chrome.tabs.create({ url: f.webViewLink });
}));
$('telegram')?.addEventListener('click', () => run(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!withDefaults(settings).screenLink) throw new Error('Connect su94r Mini to your su94r server first (Settings → Alexa and screens).');
  const blob = await makePdf();
  if (blob.size > 1400 * 1024) throw new Error('The PDF is too large for Telegram here; use Download PDF.');
  say('Sending to Telegram…');
  const r = await tgDocument(withDefaults(settings).screenLink, fileName(), toBase64(new Uint8Array(await blob.arrayBuffer())), document.title);
  say(`Sent to ${r.sent} Telegram chat${r.sent === 1 ? '' : 's'}.`);
}));
if (globalThis.chrome?.storage) { watchContext(); build(); }
