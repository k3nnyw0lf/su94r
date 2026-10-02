import {
  withDefaults, displayUnits, fmtGlucose, fmtDelta, mergeSeries, rangeStats, project,
  sensorStatus, fmtDuration, EVENT_TYPES, markerLabel, INJECTION_SITES,
} from './glucose.js';
import { loadReadings, wholeSeries } from './archive.js';
import { ptKey, learnedKey, allPatients, VIEW_DEFAULTS, firstName } from './store.js';
import { insulinOnBoard, lastDose, doubleDoseWarning, medDuplicateWarning, kindWord, BOLUS_KINDS } from './insulin.js';
import { insulinKindFromName } from './meds.js';
import { watchContext, contextAlive, isInvalidated, stashPending, takePending, reloadIntoCurrentVersion } from './lifecycle.js';
import { addEvents, removeEvents } from './events.js';
import { forecast, trustworthy, doseEffect, trustedHorizon } from './learner.js';
import { compressionLows } from './recovery.js';
import { preparePhoto, estimateCarbs, readPen } from './vision.js';
import { isLegacy } from './handover.js';

const STALE_MS = 10 * 60e3;
const HELPER_URL = 'http://127.0.0.1:47923/ping';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_ROTATION = { 1: 90, 2: 45, 3: 0, 4: -45, 5: -90 };
const ext = globalThis.chrome?.storage ? chrome : null;

// Cached once: when the card moves into the floating window, document.getElementById stops finding it.
const ui = Object.fromEntries(
  ['card', 'graph', 'value', 'arrow', 'units', 'delta', 'ago', 'stats', 'sensor', 'overlay', 'bar', 'status',
    'add', 'tiny', 'pin', 'addPanel', 'addTypes', 'addDetail', 'addIcon', 'addAmount', 'addWhen',
    'dose', 'addWarn', 'addAt', 'addKind', 'addSite', 'addMed', 'addAtLabel', 'markRow', 'markText', 'markDelete',
    'addPhoto', 'addPhotoFile', 'addInfo']
    .map((id) => [id, document.getElementById(id)]),
);
const $ = (id) => ui[id];
const card = $('card');
const graph = $('graph');
const rangeButtons = [...card.querySelectorAll('.ranges button')];

let data = {
  hist: [], live: [], latest: null, patient: null, state: null, sensor: null, events: [],
  learned: null,   // what the learner worked out for this person (learner.js)
  settings: withDefaults(),
};
let pid = new URLSearchParams(location.search).get('p');
let view = { ...VIEW_DEFAULTS };
let globalSettings = withDefaults();
let longSeries = null;
let hoverX = null;
let pipWin = null;
let hideOnPipClose = false;
let helperUp = false;
let helperCode = '';   // the pin helper's private code, as invisible title characters
let addType = null;
let addAt = null;        // set when the panel was opened by clicking a moment on the graph
let shownMark = null;
let confirmBig = false;
let confirmDup = false;
let scale = null;        // last graph geometry, for turning a click into a time
let statusNote = null;

const units = () => displayUnits(data.settings, data.patient);
const low = () => data.patient?.low ?? 70;
const high = () => data.patient?.high ?? 180;
const fmt = (mg) => fmtGlucose(mg, units());
const cat = (mg) => (mg < low() ? 'low' : mg > high() ? 'high' : 'in');
const owner = () => pid;
const fresh = () => data.latest && Date.now() - data.latest.t <= STALE_MS;
const isLong = () => data.settings.hours > 24;

function clockLabel(t, withMinutes = false) {
  const d = new Date(t);
  const h = d.getHours();
  const ap = h < 12 ? 'a' : 'p';
  const h12 = h % 12 || 12;
  return withMinutes ? `${h12}:${String(d.getMinutes()).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

const dayLabel = (t) => new Date(t).toLocaleDateString([], { weekday: 'short' });
const whenLabel = (t) => (Date.now() - t > 20 * 3600e3 ? `${dayLabel(t)} ${clockLabel(t, true)}` : clockLabel(t, true));
const recent = () => mergeSeries(data.hist, data.live);

function bucket(points, ms) {
  const out = [];
  let cur = null;
  for (const p of points) {
    const k = Math.floor(p.t / ms);
    if (!cur || cur.k !== k) {
      cur = { k, t: p.t, sum: p.mg, n: 1 };
      out.push(cur);
    } else {
      cur.sum += p.mg;
      cur.n++;
    }
  }
  return out.map((c) => ({ t: c.t, mg: c.sum / c.n }));
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function renderGraph() {
  const W = graph.clientWidth;
  const H = graph.clientHeight;
  graph.replaceChildren();
  card.classList.toggle('long', isLong());
  scale = null;
  if (!W || !H) return;
  graph.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const now = Date.now();
  const hours = data.settings.hours;
  const series = isLong() ? (longSeries || recent()) : recent();
  // The learned estimate line when the learner has earned trust (it beat plain guesses on data
  // it did not learn from); otherwise the plain 20-minute straight line.
  const model = data.learned;
  const showAhead = data.settings.projection && !isLong() && fresh();
  const est = showAhead && trustworthy(model)
    ? forecast(series.filter((p) => p.t > data.latest.t - 40 * 60e3), data.events, owner(), model,
      { latest: data.latest, horizonMin: Math.round(Math.min(trustedHorizon(model), Math.max(30, hours * 20))), stepMin: 5, health: model.recentHealth || [] })
    : null;
  const proj = showAhead && !est ? project(series, data.latest) : null;
  const to = est ? est.points[est.points.length - 1].t : proj ? proj.t : now;
  const from = now - hours * 3600e3;
  const pts = series.filter((p) => p.t >= from - 10 * 60e3);
  const shown = pts.filter((p) => p.t >= from);

  const padL = 2, padR = 28, padT = 6, padB = 14;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = [...shown.map((p) => p.mg), ...(proj ? [proj.mg] : []), ...(est ? est.points.map((p) => p.mg) : [])];
  const maxV = Math.max(...values, high() + 30, 220);
  const minV = Math.min(...values, 50);
  const yMin = Math.max(20, Math.floor((minV - 10) / 10) * 10);
  const yMax = Math.min(500, Math.ceil((maxV + 10) / 10) * 10);
  const x = (t) => padL + ((t - from) / (to - from)) * plotW;
  const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  graph.append(el('rect', { class: 'band', x: padL, y: y(high()), width: plotW, height: y(low()) - y(high()) }));
  if (proj || est) graph.append(el('rect', { class: 'future', x: x(now), y: padT, width: x(to) - x(now), height: plotH }));
  for (const v of [low(), high()]) {
    graph.append(el('line', { class: 'grid', x1: padL, x2: padL + plotW, y1: y(v), y2: y(v) }));
    graph.append(el('text', { x: W - padR + 4, y: y(v) + 3.5 }, fmt(v)));
  }

  // Time ticks: hours, or midnights on the 7-day view.
  const ticks = [];
  if (isLong()) {
    const d = new Date(from);
    d.setHours(24, 0, 0, 0);
    for (let t = d.getTime(); t < to; t += 864e5) ticks.push([t, dayLabel(t)]);
  } else {
    const stepH = hours <= 6 ? 1 : hours <= 12 ? 2 : 4;
    const tick = new Date(from);
    tick.setMinutes(0, 0, 0);
    tick.setHours(tick.getHours() + 1);
    while (tick.getHours() % stepH) tick.setHours(tick.getHours() + 1);
    for (let t = tick.getTime(); t < to; t += stepH * 3600e3) ticks.push([t, clockLabel(t)]);
  }
  for (const [t, label] of ticks) {
    const tx = x(t);
    if (tx < padL + 8 || tx > padL + plotW - 8) continue;
    graph.append(el('line', { class: 'grid', x1: tx, x2: tx, y1: padT, y2: padT + plotH }));
    graph.append(el('text', { x: tx, y: H - 2, 'text-anchor': 'middle' }, label));
  }

  // Line, split by range colour and broken across gaps longer than 20 min.
  const clip = el('clipPath', { id: 'plot' });
  clip.append(el('rect', { x: padL, y: 0, width: plotW, height: H }));
  graph.append(clip);
  const g = el('g', { 'clip-path': 'url(#plot)' });
  graph.append(g);

  const segs = [];
  let cur = null;
  let prev = null;
  for (const p of pts) {
    const c = cat(p.mg);
    const gap = prev && p.t - prev.t > 20 * 60e3;
    if (!cur || gap || c !== cur.c) {
      cur = { c, pts: prev && !gap ? [prev, p] : [p] };
      segs.push(cur);
    } else {
      cur.pts.push(p);
    }
    prev = p;
  }
  for (const s of segs) {
    if (s.pts.length === 1) {
      g.append(el('circle', { class: `dot ${s.c}`, cx: x(s.pts[0].t), cy: y(s.pts[0].mg), r: 2 }));
      continue;
    }
    const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.mg).toFixed(1)}`).join('');
    g.append(el('path', { class: `seg ${s.c}`, d }));
  }

  // Likely compression lows (an overnight dip that bounced back with nothing eaten): marked
  // with a ? so a pressure dip is not mistaken for a real low later. Alarms still fire on every low.
  for (const c of compressionLows(pts, data.events, owner(), { low: low() })) {
    if (c.end < from) continue;
    const cx = x((c.start + c.end) / 2);
    const mark = el('text', { class: 'compress', x: cx, y: Math.min(padT + plotH - 2, y(c.nadir) + 14), 'text-anchor': 'middle' }, '?');
    mark.append(el('title', {}, 'Likely pressure on the sensor (a compression low): a sudden overnight dip that bounced back by itself, with nothing eaten. Alarms still sound for every low.'));
    graph.append(mark);
  }

  const last = data.latest;
  if (proj) {
    const c = cat(proj.mg);
    graph.append(el('path', { class: `proj ${c}`, d: `M${x(last.t)},${y(last.mg)}L${x(proj.t)},${y(proj.mg)}` }));
    graph.append(el('circle', { class: `proj-end ${c}`, cx: x(proj.t), cy: y(proj.mg), r: 3.5 }));
    const ly = y(proj.mg) + (proj.mg > last.mg ? -7 : 13);
    graph.append(el('text', { class: 'proj-label', x: x(proj.t), y: ly, 'text-anchor': 'end' }, `~${fmt(proj.mg)}`));
  }
  if (est) {
    // Shaded: where it will likely be (8 times in 10). Dashed: the learner's best estimate.
    const line = [{ t: last.t, mg: last.mg, lo: last.mg, hi: last.mg }, ...est.points];
    const xy = (t, v) => `${x(t).toFixed(1)},${y(Math.min(yMax, Math.max(yMin, v))).toFixed(1)}`;
    const band = el('polygon', { class: `est-band ${cat(est.points[est.points.length - 1].mg)}`, points: [...line.map((p) => xy(p.t, p.hi)), ...[...line].reverse().map((p) => xy(p.t, p.lo))].join(' ') });
    const end = est.points[est.points.length - 1];
    const mins = Math.round((end.t - last.t) / 60e3);
    band.append(el('title', {}, `Learned from your own data: about ${fmt(end.mg)} in ${mins} min (likely ${fmt(end.lo)}–${fmt(end.hi)}). An estimate, not a dosing instruction.`));
    graph.append(band);
    const c = cat(end.mg);
    graph.append(el('path', { class: `proj est ${c}`, d: line.map((p, i) => `${i ? 'L' : 'M'}${xy(p.t, p.mg)}`).join('') }));
    graph.append(el('circle', { class: `proj-end ${c}`, cx: x(end.t), cy: y(end.mg), r: 3.5 }));
    const ly = y(end.mg) + (end.mg > last.mg ? -7 : 13);
    graph.append(el('text', { class: 'proj-label', x: x(end.t), y: ly, 'text-anchor': 'end' }, `~${fmt(end.mg)}`));
  }
  if (last && last.t >= from) {
    graph.append(el('circle', { class: `dot now ${cat(last.mg)}`, cx: x(last.t), cy: y(last.mg), r: 4.5 }));
  }

  // Markers along the top.
  const marks = data.events.filter((e) => e.p === owner() && e.t >= from && e.t <= to);
  scale = { from, to, now, padL, plotW, marks: marks.map((e) => ({ e, x: x(e.t) })) };
  for (const e of marks) {
    const mx = x(e.t);
    graph.append(el('line', { class: 'marker-line', x1: mx, x2: mx, y1: padT + 12, y2: padT + plotH }));
    graph.append(el('text', { class: 'marker', x: mx, y: padT + 9, 'text-anchor': 'middle' }, EVENT_TYPES[e.type]?.icon || '•'));
  }

  // Hover read-out: a marker if the pointer is on one, otherwise the nearest reading.
  if (hoverX == null) return;
  const nearMark = marks.find((e) => Math.abs(x(e.t) - hoverX) <= 7);
  let px, label, dotY = null, dotCat = null;
  const when = (t) => (isLong() ? `${dayLabel(t)} ${clockLabel(t, true)}` : clockLabel(t, true));
  if (nearMark) {
    px = x(nearMark.t);
    label = `${markerLabel(nearMark)} · ${when(nearMark.t)}`;
  } else if (shown.length) {
    const t = from + ((hoverX - padL) / plotW) * (to - from);
    const near = shown.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    px = x(near.t);
    label = `${fmt(near.mg)} · ${when(near.t)}`;
    dotY = y(near.mg);
    dotCat = cat(near.mg);
  } else {
    return;
  }
  graph.append(el('line', { class: 'cross', x1: px, x2: px, y1: padT, y2: padT + plotH }));
  if (dotY != null) graph.append(el('circle', { class: `dot ${dotCat}`, cx: px, cy: dotY, r: 3.5 }));
  const tw = label.length * 6.2 + 10;
  const tx = Math.min(Math.max(px - tw / 2, padL), padL + plotW - tw);
  graph.append(el('rect', { class: 'tip-bg', x: tx, y: padT, width: tw, height: 17, rx: 4 }));
  graph.append(el('text', { class: 'tip', x: tx + tw / 2, y: padT + 12.5, 'text-anchor': 'middle' }, label));
}

function deltaText() {
  const last = data.latest;
  if (!last) return '';
  const target = last.t - 15 * 60e3;
  const ref = recent()
    .filter((p) => Math.abs(p.t - target) <= 4 * 60e3)
    .sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target))[0];
  return ref ? `${fmtDelta(last.mg - ref.mg, units())} / 15 min` : '';
}

function renderHeader() {
  const last = data.latest;
  const stale = last && !fresh();
  card.dataset.cat = !last ? 'none' : stale ? 'stale' : cat(last.mg);

  const value = !last ? '—' : last.mg < 40 ? 'LO' : last.mg > 400 ? 'HI' : fmt(last.mg);
  $('value').textContent = value;
  $('units').textContent = last ? units() : '';

  const rot = ARROW_ROTATION[last?.trend];
  $('arrow').toggleAttribute('hidden', rot == null || Boolean(stale)); // SVG elements have no .hidden property
  if (rot != null) $('arrow').style.transform = `rotate(${rot}deg)`;

  $('delta').textContent = stale ? '' : deltaText();
  const ago = $('ago');
  if (last) {
    const mins = Math.max(0, Math.round((Date.now() - last.t) / 60e3));
    ago.textContent = stale ? `No reading for ${fmtDuration(Date.now() - last.t)}` : mins === 0 ? 'just now' : `${mins} min ago`;
    ago.classList.toggle('warn', Boolean(stale));
  } else {
    ago.textContent = '';
  }

  // The pin helper keeps a window whose title ends in "· su94r Mini (on top)" plus its
  // private code above all other windows (see pin-helper.ps1).
  const label = last ? `${value} ${units()} ${['', '↓', '↘', '→', '↗', '↑'][last.trend ?? 0] || ''}`.trim() : 'Glucose';
  const onTop = data.settings.onTop && helperUp ? ` (on top)${helperCode}` : '';
  const who = firstName(data.patient?.name);
  document.title = `${who ? `${who} · ` : ''}${label} · su94r Mini${onTop}`;
  if (pipWin) pipWin.document.title = label;
  card.title = data.settings.tiny ? 'Double-click to show the graph' : '';
}

function renderInfo() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const st = rangeStats(recent(), midnight.getTime(), Date.now(), low(), high());
  const stats = $('stats');
  if (st) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    stats.textContent = `Today ${pct(st.inRange)} in range · avg ${fmt(st.avg)} · ${st.lows} low${st.lows === 1 ? '' : 's'}`;
    stats.title = `Since midnight (${st.hours.toFixed(1)} h of data): ${pct(st.inRange)} in range (${fmt(low())}–${fmt(high())}), `
      + `${pct(st.below)} low, ${pct(st.above)} high. Average ${fmt(st.avg)} ${units()}. A low counts when it lasts 15+ minutes.`;
  } else {
    stats.textContent = '';
    stats.title = '';
  }

  const sensor = $('sensor');
  const ss = sensorStatus(data.sensor, data.settings.sensorDays);
  sensor.className = 'sensor';
  if (!ss) {
    sensor.textContent = '';
  } else if (ss.kind === 'warming') {
    sensor.textContent = `Sensor warming up · ${fmtDuration(ss.left)}`;
  } else if (ss.kind === 'ended') {
    sensor.textContent = 'Sensor ended';
    sensor.classList.add('bad');
  } else {
    sensor.textContent = ss.left < 24 * 3600e3 ? `Sensor ends in ${fmtDuration(ss.left)}` : `Sensor ${fmtDuration(ss.left)} left`;
    if (ss.left < 2 * 3600e3) sensor.classList.add('bad');
    else if (ss.left < 24 * 3600e3) sensor.classList.add('warn');
  }
  sensor.title = ss ? `Ends ${new Date(ss.end).toLocaleString()} (${data.settings.sensorDays}-day wear)` : '';
}

// What was taken and what is still working, so a dose is not repeated by mistake.
function renderDose() {
  const el = $('dose');
  const now = Date.now();
  const bolus = lastDose(data.events, owner(), BOLUS_KINDS, now);
  const basal = lastDose(data.events, owner(), new Set(['basal', 'intermediate', 'mix']), now);
  const recent = (d) => d && now - d.t < 24 * 3600e3;
  if (!recent(bolus) && !recent(basal)) {
    el.hidden = true;
    return;
  }
  const ago = (t) => { const mins = Math.round((now - t) / 60e3); return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`; };
  const iob = insulinOnBoard(data.events, owner(), data.settings, now);
  el.replaceChildren();
  el.append('💉 ');
  if (recent(bolus)) {
    el.append(`${Number(bolus.amount) > 0 ? `${bolus.amount} u` : 'a dose'} ${kindWord(bolus.kind)} ${ago(bolus.t)}`);
    if (iob > 0) {
      const b = document.createElement('span');
      b.className = 'iob';
      b.textContent = ` · ${iob} u active`;
      el.append(b);
    }
  }
  if (recent(basal)) el.append(`${recent(bolus) ? ' · ' : ''}${basal.amount} u ${kindWord(basal.kind)} at ${clockLabel(basal.t, true)}`);
  el.title = 'Logged doses only. Active insulin counts rapid and regular doses (long-acting is not included).';
  el.hidden = false;
}

function renderStatus() {
  const s = data.state;
  const status = $('status');
  const overlay = $('overlay');
  status.classList.toggle('error', s?.status === 'error');
  status.replaceChildren();
  if (statusNote) {
    status.append(statusNote.text);
    if (statusNote.action) {
      const b = document.createElement('button');
      b.textContent = statusNote.action.label;
      b.onclick = statusNote.action.run;
      status.append(b);
    }
  } else {
    status.textContent = s?.status === 'error' ? `⚠ ${s.message}` : data.patient?.name || '';
  }

  const signedOut = (s?.status === 'signed-out' && !data.latest) || (!pid && ext);
  overlay.hidden = !signedOut && data.latest != null;
  if (overlay.hidden) return;
  overlay.replaceChildren();
  const msg = document.createElement('div');
  msg.textContent = !pid ? 'No one to show yet. Sign in, or turn on demo mode.' : signedOut ? (s.message || 'Not signed in.') : 'Waiting for the first reading…';
  overlay.append(msg);
  if (signedOut && ext) {
    const b = document.createElement('button');
    b.textContent = 'Sign in';
    b.onclick = () => chrome.runtime.openOptionsPage();
    overlay.append(b);
  }
}

function renderControls() {
  for (const b of rangeButtons) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.h) === data.settings.hours));
  }
  const pin = $('pin');
  const pinned = Boolean(pipWin) || (helperUp && data.settings.onTop);
  pin.setAttribute('aria-pressed', String(pinned));
  pin.title = helperUp
    ? (data.settings.onTop ? 'Stop keeping on top' : 'Keep on top of all windows')
    : (pipWin ? 'Stop floating' : 'Float on top of all windows');
}

function updateLayout() {
  const h = card.clientHeight;
  card.classList.toggle('compact', Boolean(data.settings.tiny) || (h > 0 && h < 120));
  card.classList.toggle('short', h > 0 && h < 175);
}

function render() {
  updateLayout();
  renderHeader();
  renderInfo();
  renderDose();
  renderStatus();
  renderControls();
  renderGraph();
}

// ---- data plumbing ----

const keys = () => [ptKey(pid), learnedKey(pid), 'settings', 'views', 'events'];

// One patient record (pt:<id>) plus global settings and this window's own view choices.
function absorb(got) {
  if (ptKey(pid) in got) {
    const p = got[ptKey(pid)] || {};
    data.hist = p.hist || [];
    data.live = p.live || [];
    data.latest = p.latest || null;
    data.sensor = p.sensor || null;
    data.state = p.state || null;
    data.patient = p.pid ? { name: p.name, units: p.units, low: p.low, high: p.high } : null;
  }
  if ('settings' in got) globalSettings = withDefaults(got.settings);
  if ('views' in got) view = { ...VIEW_DEFAULTS, ...((got.views || {})[pid] || {}) };
  if ('events' in got) data.events = got.events || [];
  if (learnedKey(pid) in got) data.learned = got[learnedKey(pid)] || null;
  data.settings = { ...globalSettings, ...view };
}

async function loadLong() {
  if (!isLong() || !ext) {
    longSeries = null;
    return;
  }
  const from = Date.now() - data.settings.hours * 3600e3;
  const recs = await loadReadings(owner(), from);
  longSeries = bucket(wholeSeries(recs), 5 * 60e3);
  renderGraph();
}

async function load() {
  if (ext) {
    if (!pid) pid = (await allPatients(withDefaults((await chrome.storage.local.get('settings')).settings)))[0]?.pid || null;
    absorb(await chrome.storage.local.get(keys()));
  } else {
    pid = 'preview';
    absorb(previewData());
  }
  render();
  loadLong();
}

const VIEW_KEYS = Object.keys(VIEW_DEFAULTS);

async function saveSettings(patch) {
  const viewPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => VIEW_KEYS.includes(k)));
  const globalPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => !VIEW_KEYS.includes(k)));
  view = { ...view, ...viewPatch };
  globalSettings = withDefaults({ ...globalSettings, ...globalPatch });
  data.settings = { ...globalSettings, ...view };
  render();
  if (!ext) return;
  if (Object.keys(viewPatch).length) {
    const { views = {} } = await chrome.storage.local.get('views');
    views[pid] = { ...VIEW_DEFAULTS, ...(views[pid] || {}), ...viewPatch };
    await chrome.storage.local.set({ views });
  }
  if (Object.keys(globalPatch).length) {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: withDefaults({ ...settings, ...globalPatch }) });
  }
}

if (ext) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !keys().some((k) => k in changes)) return;
    const got = {};
    for (const k of keys()) if (k in changes) got[k] = changes[k].newValue;
    absorb(got);
    render();
    if (changes[ptKey(pid)] || changes.views) loadLong();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggleMini') toggleVisibility();
  });
}

// Used only when the page is opened outside the extension (design preview).
function previewData() {
  const f = (t) => { const h = t / 3600e3; return Math.round(135 + 50 * Math.sin(h * 2 * Math.PI / 5.3) + 22 * Math.sin(h * 2 * Math.PI / 1.4 + 1.3) + 6 * Math.sin(h * 2 * Math.PI / 0.37)); };
  const now = Math.floor(Date.now() / 60e3) * 60e3;
  const hist = [];
  for (let t = now - 24 * 3600e3; t <= now - 30 * 60e3; t += 5 * 60e3) hist.push([t, f(t)]);
  const live = [];
  for (let t = now - 30 * 60e3; t <= now; t += 60e3) live.push([t, f(t)]);
  return {
    'pt:preview': { pid: 'preview', name: 'Preview Patient', units: 'mg/dL', low: 70, high: 180, hist, live,
      latest: { t: now, mg: f(now), trend: 4 }, state: { status: 'ok', message: 'Demo data' }, sensor: { sn: 'P', start: now - 9.4 * 864e5 } },
    events: [{ id: 'a', p: 'preview', t: now - 100 * 60e3, type: 'meal', amount: 45 }, { id: 'b', p: 'preview', t: now - 95 * 60e3, type: 'insulin', amount: 4 }],
  };
}

function note(text, action, ms = 8000) {
  statusNote = { text, action };
  renderStatus();
  clearTimeout(note.timer);
  note.timer = setTimeout(() => { statusNote = null; renderStatus(); }, ms);
}

// ---- interaction ----

for (const b of rangeButtons) {
  b.addEventListener('click', async () => {
    await saveSettings({ hours: Number(b.dataset.h) });
    loadLong();
  });
}

graph.addEventListener('pointermove', (e) => {
  const r = graph.getBoundingClientRect();
  hoverX = e.clientX - r.left;
  renderGraph();
});
graph.addEventListener('pointerleave', () => {
  hoverX = null;
  renderGraph();
});

// Markers: meal, insulin, exercise.
function openAdd(open, at = null) {
  $('addPanel').hidden = !open;
  $('bar').hidden = open;
  $('addTypes').hidden = false;
  $('addDetail').hidden = true;
  $('markRow').hidden = true;
  addType = null;
  addAt = open ? at : null;
  shownMark = null;
  confirmBig = false;
  confirmDup = false;
  $('addWarn').hidden = true;
  $('addInfo').hidden = true;
  $('addAmount').disabled = false;
  $('addAt').hidden = addAt == null;
  if (addAt != null) $('addAt').textContent = `At ${whenLabel(addAt)}:`;
}
$('add').addEventListener('click', () => openAdd(true));
document.getElementById('aiBtn').addEventListener('click', () => ext && chrome.runtime.sendMessage({ type: 'openAi', pid }));

// Click a moment on the graph to log something there; click a marker to see or delete it.
graph.addEventListener('click', (e) => {
  if (!scale || !ext && !data.patient) return;
  const px = e.clientX - graph.getBoundingClientRect().left;
  const hit = scale.marks.find((m) => Math.abs(m.x - px) <= 7);
  if (hit) {
    showMark(hit.e);
    return;
  }
  const raw = scale.from + ((px - scale.padL) / scale.plotW) * (scale.to - scale.from);
  if (raw < scale.from) return;
  openAdd(true, Math.round(Math.min(raw, Date.now()) / 60e3) * 60e3);
});

function showMark(ev) {
  openAdd(true);
  shownMark = ev;
  $('addTypes').hidden = true;
  $('markRow').hidden = false;
  // For insulin, what the learner says this dose does: how much, when strongest, when done.
  const eff = ev.type === 'insulin' && data.learned ? doseEffect(ev, data.learned) : null;
  const effText = eff?.learned && trustworthy(data.learned)
    ? ` · lowers about ${fmt(eff.total)} (likely ${fmt(eff.low)}–${fmt(eff.high)}), strongest ${clockLabel(eff.peakAt, true)}, done ${clockLabel(eff.endAt, true)}${eff.toCome >= 5 ? `, ${fmt(eff.toCome)} still to come` : ''}`
    : '';
  $('markText').textContent = `${EVENT_TYPES[ev.type]?.icon || '•'} ${markerLabel(ev)} · ${whenLabel(ev.t)}${effText}`;
  $('markText').title = $('markText').textContent;
}

$('markDelete').addEventListener('click', async () => {
  const ev = shownMark;
  if (!ev) return;
  openAdd(false);
  await storeEvents({ remove: [ev.id] });
  note('Marker deleted', {
    label: 'Undo',
    // A fresh id: the deleted one carries a deletion notice to the other computers.
    run: async () => {
      await storeEvents({ add: [{ ...ev, id: crypto.randomUUID() }] });
      note('Marker restored', null, 3000);
    },
  });
});
for (const b of $('addPanel').querySelectorAll('[data-close]')) b.addEventListener('click', () => openAdd(false));
for (const b of $('addPanel').querySelectorAll('[data-type]')) {
  b.addEventListener('click', () => {
    addType = b.dataset.type;
    $('addTypes').hidden = true;
    $('addDetail').hidden = false;
    $('addIcon').textContent = EVENT_TYPES[addType].icon;
    $('addAmount').value = '';
    $('addAmount').placeholder = EVENT_TYPES[addType].unit;
    $('addKind').hidden = addType !== 'insulin';
    // Always start at rapid: a dose saved as the wrong type would hide it from the guard.
    $('addKind').value = 'rapid';
    $('addSite').hidden = addType !== 'insulin';
    $('addSite').value = '';
    $('addMed').hidden = addType !== 'med';
    if (addType === 'med') setupMedPicker();
    // Rotation hint: name the last site used, so the next one can be different.
    const lastSite = data.events.filter((x) => x.p === owner() && x.type === 'insulin' && x.site).sort((a, b) => b.t - a.t)[0];
    $('addSite').options[0].text = lastSite ? `Site (last: ${$('addSite').querySelector(`option[value="${lastSite.site}"]`)?.text || lastSite.site})` : 'Site';
    $('addSite').title = lastSite ? `Last site: ${INJECTION_SITES[lastSite.site] || lastSite.site}, ${whenLabel(lastSite.t)}` : 'Injection site (optional)';
    $('addPhoto').hidden = addType !== 'meal' && addType !== 'insulin';
    $('addInfo').hidden = true;
    $('addWhen').value = '0';
    $('addWhen').hidden = addAt != null;
    $('addAtLabel').hidden = addAt == null;
    if (addAt != null) $('addAtLabel').textContent = `at ${whenLabel(addAt)}`;
    $('addAmount').focus();
  });
}
// Any change after a warning means the next Add is a new decision, so check again.
for (const id of ['addAmount', 'addKind', 'addWhen']) {
  for (const type of ['input', 'change']) {
    $(id).addEventListener(type, () => { confirmBig = false; confirmDup = false; $('addWarn').hidden = true; });
  }
}
$('addPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') openAdd(false); });

// Photo: a meal → an estimated carb range; a pen's dose window → the units it shows. The number
// only fills the field to check; nothing is saved until Add, and nothing suggests a dose.
async function fromPhoto(file) {
  if (!file || !ext || (addType !== 'meal' && addType !== 'insulin')) return;
  const kind = addType;
  const info = $('addInfo');
  info.hidden = false;
  info.textContent = kind === 'meal' ? 'Looking at the meal…' : 'Reading the pen…';
  try {
    const { ai: cfg = {} } = await chrome.storage.local.get('ai');
    if (!cfg.provider) throw new Error('Connect an AI in Settings (AI analysis) to use photos.');
    const photo = await preparePhoto(file);
    if (addType !== kind) return;
    if (kind === 'meal') {
      const r = await estimateCarbs(cfg, photo);
      $('addAmount').value = String(r.best);
      info.textContent = `Photo estimate: about ${r.best} g carbs (likely ${r.low}–${r.high} g, ${r.confidence} confidence)${r.items.length ? `: ${r.items.slice(0, 4).map((i) => i.name).join(', ')}` : ''}. Check it before adding.`;
    } else {
      const r = await readPen(cfg, photo);
      if (r.units == null) throw new Error(`Could not read the pen${r.note ? `: ${r.note}` : ''}. Type the units instead.`);
      $('addAmount').value = String(r.units);
      info.textContent = `The pen shows ${r.units} units (${r.confidence} confidence). Check it before adding.`;
    }
    $('addAmount').dispatchEvent(new Event('input'));
  } catch (err) {
    info.textContent = err.message;
  }
}
$('addPhoto').addEventListener('click', () => $('addPhotoFile').click());
$('addPhotoFile').addEventListener('change', (e) => { fromPhoto(e.target.files?.[0]); e.target.value = ''; });
$('addPanel').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); fromPhoto(item.getAsFile()); }
});
$('addPanel').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!addType) return;
  const amount = $('addAmount').value === '' ? null : Number($('addAmount').value);
  // A dose with no amount cannot be counted in active insulin, so ask for it.
  if ((addType === 'insulin' || selectedMedIsInsulin()) && !(amount > 0)) {
    showWarn('Enter the number of units.');
    $('addAmount').focus();
    return;
  }
  if ((addType === 'insulin' || selectedMedIsInsulin()) && amount > 100 && !confirmBig) {
    confirmBig = true;
    showWarn('Over 100 units. Check the amount, then click Add again to confirm.');
    return;
  }
  const med = addType === 'med' ? selectedMed() : null;
  if (addType === 'med' && !med) return;
  // An insulin product from the medicine list is logged as insulin, so the guard and active insulin see it.
  const loggedType = med?.isInsulin ? 'insulin' : addType;
  const kind = loggedType === 'insulin' ? $('addKind').value : null;
  const ev = {
    id: crypto.randomUUID(),
    p: owner(),
    t: addAt ?? Date.now() - Number($('addWhen').value) * 60e3,
    type: loggedType,
    ...(Number.isFinite(amount) && amount > 0 ? { amount } : {}),
    ...(kind ? { kind } : {}),
    ...(loggedType === 'insulin' && $('addSite').value ? { site: $('addSite').value } : {}),
    ...(med ? { medId: med.rxcui || null, medName: med.short || med.display || med.name, ...(med.isInsulin ? {} : { unit: med.unit || 'dose' }) } : {}),
  };
  if ((loggedType === 'insulin' || loggedType === 'med') && !confirmDup) {
    const warning = loggedType === 'insulin'
      ? doubleDoseWarning(data.events, owner(), ev, data.settings)
      : medDuplicateWarning(data.events, owner(), ev);
    if (warning) {
      confirmDup = true;
      showWarn(`⚠ ${warning} Click Add again only if this is a separate dose.`);
      return;
    }
  }
  const type = EVENT_TYPES[loggedType];
  openAdd(false);
  // If the extension was reloaded under this window, keep the entry and save it after reloading.
  if (ext && !contextAlive()) {
    stashPending(ev);
    reloadIntoCurrentVersion();
    return;
  }
  try {
    await storeEvents({ add: [ev] });
  } catch (err) {
    // Never lose a dose: keep it in this window and save it as soon as the extension answers.
    stashPending(ev);
    if (isInvalidated(err)) {
      reloadIntoCurrentVersion();
    } else {
      note('Saving… the extension is busy, trying again.', null, 4000);
      setTimeout(savePendingEntries, 2000);
    }
    return;
  }
  note(`${type.icon} added`, {
    label: 'Undo',
    run: async () => {
      await storeEvents({ remove: [ev.id] });
      note('Marker removed', null, 3000);
    },
  });
});

// Medicines come from the list kept in Settings (looked up in RxNorm there).
function setupMedPicker() {
  const meds = data.settings.meds || [];
  const sel = $('addMed');
  sel.replaceChildren(...meds.map((x) => new Option(x.short || x.display || x.name, x.rxcui || x.name)));
  if (!meds.length) {
    showWarn('Add the medicines you take in Settings first (Insulin & medicines).');
    $('addAmount').disabled = true;
    return;
  }
  $('addAmount').disabled = false;
  applyMedDefaults();
}
function selectedMed() {
  const meds = data.settings.meds || [];
  return meds.find((x) => (x.rxcui || x.name) === $('addMed').value) || null;
}
function applyMedDefaults() {
  const med = selectedMed();
  if (!med) return;
  $('addAmount').value = med.dose ?? '';
  $('addAmount').placeholder = med.unit || 'dose';
  const insulin = Boolean(med.isInsulin);
  $('addKind').hidden = !insulin;
  $('addSite').hidden = !insulin;
  if (insulin) $('addKind').value = insulinKindFromName(med.name);
}
$('addMed').addEventListener('change', () => { confirmDup = false; $('addWarn').hidden = true; applyMedDefaults(); });

function selectedMedIsInsulin() {
  return addType === 'med' && Boolean(selectedMed()?.isInsulin);
}

function showWarn(text) {
  $('addWarn').textContent = text;
  $('addWarn').hidden = false;
}

// Entries made in a window that lost its connection to the extension (see lifecycle.js).
async function savePendingEntries() {
  const pending = takePending();
  if (!pending.length) return;
  try {
    await storeEvents({ add: pending });
  } catch {
    for (const ev of pending) stashPending(ev);
    setTimeout(savePendingEntries, 5000);
    return;
  }
  note(`Saved ${pending.length === 1 ? 'the entry' : `${pending.length} entries`} you made while the extension was updating.`, null, 10000);
}

async function storeEvents({ add = [], remove = [] }) {
  if (!ext) {
    data.events = [...data.events.filter((x) => !remove.includes(x.id)), ...add].sort((a, b) => a.t - b.t);
    render();
    return;
  }
  if (remove.length) await removeEvents(remove);
  if (add.length) await addEvents(add);
}

// Number-only mode.
$('tiny').addEventListener('click', async () => {
  const host = pipWin || window;
  await saveSettings({ tiny: true, normalSize: { width: host.outerWidth, height: host.outerHeight } });
  if (pipWin) {
    try { pipWin.resizeTo(220, 120); } catch { /* the float keeps its size */ }
  } else if (ext) {
    chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { width: 230, height: 130 });
  }
});
card.addEventListener('dblclick', async () => {
  if (!data.settings.tiny) return;
  const size = data.settings.normalSize || { width: 360, height: 270 };
  await saveSettings({ tiny: false });
  if (pipWin) {
    try { pipWin.resizeTo(size.width, size.height); } catch { /* keep size */ }
  } else if (ext) {
    chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { width: size.width, height: size.height });
  }
});

// Keep on top: the Windows pin helper when it is running (stays on top for good), otherwise
// Chrome's Document Picture-in-Picture float (needs a click each time).
async function checkHelper() {
  if (!ext) return false;
  try {
    const r = await fetch(HELPER_URL, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    const j = r.ok ? await r.json() : {};
    helperUp = j.app === 'libre-mini-pin';
    // The helper's private code, written into the title as invisible characters, so a web
    // page cannot pin its own window by copying the visible marker.
    helperCode = typeof j.code === 'string' ? [...j.code].map((b) => (b === '1' ? '\u200C' : '\u200B')).join('') : '';
  } catch {
    helperUp = false;
    helperCode = '';
  }
  renderControls();
  renderHeader();
  return helperUp;
}

$('pin').addEventListener('click', async () => {
  if (pipWin) {
    pipWin.close();
    return;
  }
  if (helperUp || await checkHelper()) {
    await saveSettings({ onTop: !data.settings.onTop });
    return;
  }
  openFloat();
});

async function openFloat() {
  if (!('documentPictureInPicture' in window)) {
    note('Keep-on-top needs Chrome 116 or newer.');
    return;
  }
  const w = data.settings.tiny ? 220 : Math.max(240, card.offsetWidth);
  const h = data.settings.tiny ? 110 : Math.max(140, card.offsetHeight);
  pipWin = await documentPictureInPicture.requestWindow({ width: w, height: h });

  for (const sheet of document.styleSheets) {
    const style = pipWin.document.createElement('style');
    style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
    pipWin.document.head.append(style);
  }
  pipWin.document.body.append(card);
  watchSize(pipWin);
  render();

  pipWin.addEventListener('pagehide', () => {
    document.body.append(card);
    pipWin = null;
    watchSize(window);
    render();
    if (ext && !hideOnPipClose) chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { state: 'normal', focused: true });
    hideOnPipClose = false;
  });

  // The floating copy replaces this window; tuck it away (closing it would close the float too).
  if (ext) chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { state: 'minimized' });
}

// Keyboard shortcut (Alt+Shift+G by default): show or hide.
async function toggleVisibility() {
  if (pipWin) {
    hideOnPipClose = true;
    pipWin.close();
    return;
  }
  const w = await chrome.windows.getCurrent();
  chrome.windows.update(w.id, w.state === 'minimized' ? { state: 'normal', focused: true } : { state: 'minimized' });
}

// The observer must belong to the window that currently hosts the card, so it is recreated on every move.
let sizeObserver = null;
function watchSize(win) {
  sizeObserver?.disconnect();
  sizeObserver = new win.ResizeObserver(() => {
    updateLayout();
    renderGraph();
  });
  sizeObserver.observe(card);
}
watchSize(window);
setInterval(() => { renderHeader(); renderInfo(); renderDose(); }, 20e3);
setInterval(checkHelper, 60e3);

// First open: park the window in the bottom-right corner.
if (ext) {
  chrome.storage.local.get('bounds').then(async ({ bounds = {} }) => {
    if (bounds[pid]) return;
    const win = await chrome.windows.getCurrent();
    if (win.type !== 'popup') return;
    chrome.windows.update(win.id, {
      left: Math.max(0, screen.availLeft + screen.availWidth - win.width - 24),
      top: Math.max(0, screen.availTop + screen.availHeight - win.height - 24),
    });
  });
  watchContext();
  savePendingEntries();
  chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  chrome.storage.local.get(['justUpdated', 'retired']).then(({ justUpdated: u, retired }) => {
    if (isLegacy() && retired) note('Moved to su94r Mini. This old copy no longer updates; you can remove it in chrome://extensions.', null, 60000);
    else if (isLegacy()) note('Libre Mini Graph is now su94r Mini: in chrome://extensions click Load unpacked and pick the su94r-mini folder. Your data moves over by itself.', null, 30000);
    else if (u && Date.now() - u.at < 3 * 60e3) note(`Updated to version ${u.to}`, null, 8000);
  });
}

load();
checkHelper();
