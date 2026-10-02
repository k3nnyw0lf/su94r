import { watchContext } from './lifecycle.js';
import { withDefaults, displayUnits, fmtGlucose, fmtDelta, mergeSeries, sensorStatus, fmtDuration } from './glucose.js';
import { allPatients, getView, saveView } from './store.js';
import { insulinOnBoard, lastDose, kindWord, BOLUS_KINDS } from './insulin.js';
import { askHelper } from './pin.js';

const STALE_MS = 10 * 60e3;
const ROTATION = { 1: 90, 2: 45, 3: 0, 4: -45, 5: -90 };
const RANK = { urgent: 0, low: 1, stale: 2, high: 3, none: 4, in: 5 };
const FLAG = { urgent: 'URGENT LOW', low: 'LOW', high: 'HIGH', stale: 'NO DATA', none: 'WAITING' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const ext = globalThis.chrome?.storage ? chrome : null;

let settings = withDefaults();
let patients = [];
let sort = 'urgency';
let onTop = false;
let pinSuffix = '';   // from the pin helper; empty when it is not running
let events = [];

function category(p) {
  const l = p.latest;
  if (!l) return 'none';
  if (Date.now() - l.t > STALE_MS) return 'stale';
  if (l.mg < 54 || l.mg <= settings.alerts.urgentLow) return 'urgent';
  if (l.mg < (p.low ?? 70)) return 'low';
  if (l.mg > (p.high ?? 180)) return 'high';
  return 'in';
}

function svg(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function spark(p) {
  const W = 300, H = 56, from = Date.now() - 3 * 3600e3;
  const pts = mergeSeries(p.hist, p.live).filter((q) => q.t >= from);
  const s = svg('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const lo = Math.min(50, ...pts.map((q) => q.mg)), hi = Math.max(250, ...pts.map((q) => q.mg));
  const x = (t) => ((t - from) / (Date.now() - from)) * W;
  const y = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
  s.append(svg('rect', { class: 'band', x: 0, y: y(p.high ?? 180), width: W, height: y(p.low ?? 70) - y(p.high ?? 180) }));
  let d = '', prev = null;
  for (const q of pts) {
    d += `${!prev || q.t - prev.t > 20 * 60e3 ? 'M' : 'L'}${x(q.t).toFixed(1)},${y(q.mg).toFixed(1)}`;
    prev = q;
  }
  if (d) s.append(svg('path', { d, 'vector-effect': 'non-scaling-stroke' }));
  return s;
}

function tile(p) {
  const cat = category(p);
  const u = displayUnits(settings, p);
  const l = p.latest;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile';
  b.dataset.cat = cat;
  b.title = `Open ${p.name}'s window`;
  b.onclick = () => ext && chrome.runtime.sendMessage({ type: 'openMini', pid: p.pid });

  const head = document.createElement('div');
  head.className = 't-head';
  const name = document.createElement('span');
  name.className = 't-name';
  name.textContent = p.name || 'Unnamed';
  head.append(name);
  if (FLAG[cat]) {
    const f = document.createElement('span');
    f.className = 't-flag';
    f.textContent = FLAG[cat];
    head.append(f);
  }

  const read = document.createElement('div');
  read.className = 't-read';
  const v = document.createElement('span');
  v.className = 't-value';
  v.textContent = !l ? '—' : l.mg < 40 ? 'LO' : l.mg > 400 ? 'HI' : fmtGlucose(l.mg, u);
  read.append(v);
  if (l && cat !== 'stale' && ROTATION[l.trend] != null) {
    const a = svg('svg', { class: 't-arrow', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    a.append(svg('path', { d: 'M4 12h14M12.5 6l6 6-6 6' }));
    a.style.transform = `rotate(${ROTATION[l.trend]}deg)`;
    read.append(a);
  }
  const units = document.createElement('span');
  units.className = 't-units';
  units.textContent = l ? u : '';
  read.append(units);

  const meta = document.createElement('div');
  meta.className = 't-meta';
  if (l) {
    const ref = mergeSeries(p.hist, p.live).find((q) => Math.abs(q.t - (l.t - 15 * 60e3)) <= 4 * 60e3);
    const mins = Math.max(0, Math.round((Date.now() - l.t) / 60e3));
    const dEl = document.createElement('div');
    dEl.className = 'd';
    dEl.textContent = cat !== 'stale' && ref ? `${fmtDelta(l.mg - ref.mg, u)} / 15m` : '';
    const ago = document.createElement('div');
    ago.textContent = cat === 'stale' ? `none for ${fmtDuration(Date.now() - l.t)}` : mins === 0 ? 'just now' : `${mins} min ago`;
    if (cat === 'stale') ago.className = 'warn';
    meta.append(dEl, ago);
  }
  read.append(meta);

  const foot = document.createElement('div');
  foot.className = 't-foot';
  const err = document.createElement('span');
  if (p.state?.status === 'error' || p.state?.status === 'signed-out') {
    err.textContent = `⚠ ${p.state.message}`;
    err.className = 'warn';
  }
  const sensor = document.createElement('span');
  const ss = sensorStatus(p.sensor, settings.sensorDays);
  if (ss?.kind === 'ended') { sensor.textContent = 'Sensor ended'; sensor.className = 'bad'; }
  else if (ss?.kind === 'warming') sensor.textContent = 'Sensor warming up';
  else if (ss) {
    sensor.textContent = `Sensor ${fmtDuration(ss.left)} left`;
    if (ss.left < 24 * 3600e3) sensor.className = 'warn';
  }
  foot.append(err, sensor);

  const dose = document.createElement('div');
  dose.className = 't-dose';
  const last = lastDose(events, p.pid, BOLUS_KINDS);
  if (last && Date.now() - last.t < 12 * 3600e3) {
    const mins = Math.round((Date.now() - last.t) / 60e3);
    const iob = insulinOnBoard(events, p.pid, settings);
    dose.textContent = `💉 ${Number(last.amount) > 0 ? `${last.amount} u` : 'a dose'} ${kindWord(last.kind)} ${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`} ago${iob > 0 ? ` · ${iob} u active` : ''}`;
  }

  b.append(head, read, spark(p), dose, foot);
  return b;
}

function render() {
  const list = [...patients].sort((a, b) => (sort === 'name'
    ? (a.name || '').localeCompare(b.name || '')
    : RANK[category(a)] - RANK[category(b)] || (a.name || '').localeCompare(b.name || '')));
  document.getElementById('grid').replaceChildren(...list.map(tile));
  document.getElementById('empty').hidden = list.length > 0;

  const counts = {};
  for (const p of list) counts[category(p)] = (counts[category(p)] || 0) + 1;
  const parts = [`${list.length} ${list.length === 1 ? 'person' : 'people'}`];
  for (const [k, label] of [['urgent', 'urgent low'], ['low', 'low'], ['high', 'high'], ['stale', 'no data']]) {
    if (counts[k]) parts.push(`${counts[k]} ${label}`);
  }
  document.getElementById('summary').textContent = parts.join(' · ');
  for (const b of document.querySelectorAll('[data-sort]')) b.setAttribute('aria-pressed', String(b.dataset.sort === sort));
  document.getElementById('pin').setAttribute('aria-pressed', String(onTop));

  const alarm = list.filter((p) => ['urgent', 'low'].includes(category(p))).length;
  document.title = `${alarm ? `${alarm} low · ` : ''}Board · su94r Mini${onTop ? pinSuffix : ''}`;
}

async function load() {
  if (!ext) return render();
  settings = withDefaults((await chrome.storage.local.get('settings')).settings);
  patients = await allPatients(settings);
  events = (await chrome.storage.local.get('events')).events || [];
  const view = await getView('board');
  sort = view.sort || 'urgency';
  onTop = Boolean(view.onTop);
  render();
}

for (const b of document.querySelectorAll('[data-sort]')) {
  b.addEventListener('click', () => {
    sort = b.dataset.sort;
    render();
    if (ext) saveView('board', { sort });
  });
}
document.getElementById('pin').addEventListener('click', () => {
  onTop = !onTop;
  render();
  if (ext) saveView('board', { onTop });
});
document.getElementById('settings').addEventListener('click', () => ext && chrome.runtime.openOptionsPage());
document.getElementById('aiLook').addEventListener('click', () => ext && chrome.runtime.sendMessage({ type: 'openAi', pid: patients[0]?.pid }));

if (ext) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('pt:') || k === 'settings' || k === 'events')) load();
  });
  // Not async: Chrome takes a listener's returned promise as the reply, which would answer
  // other pages' requests to the background worker with nothing.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'toggleMini') return false;
    chrome.windows.getCurrent().then((w) => {
      chrome.windows.update(w.id, w.state === 'minimized' ? { state: 'normal', focused: true } : { state: 'minimized' });
    });
    return false;
  });
  chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
}
setInterval(render, 20e3);
const checkPin = () => ext && askHelper().then((h) => { pinSuffix = h.suffix; render(); });
setInterval(checkPin, 60e3);
watchContext();
load();
checkPin();
