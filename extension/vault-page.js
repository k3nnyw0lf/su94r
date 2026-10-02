// Health vault page: what was learned, connections, adding by hand, what is stored, import.
import { withDefaults, displayUnits, fmtGlucose } from './glucose.js';
import { allPatients, learnedKey, isDemo } from './store.js';
import { TYPES, GROUP_LABELS, putSamples, getSamples, removeSamples, summarize, daily, showValue } from './vault.js';
import { findings, trustworthy, GROUPS, FACTORS } from './learner.js';
import { activeFraction } from './insulin.js';
import { getToken, googleAccount, signOutGoogle, DRIVE_SCOPES, GOOGLE_HOSTS } from './google.js';
import { CONNECTORS } from './connectors.js';
import { parseImport } from './vault-import.js';
import { loadReadings, wholeSeries } from './archive.js';
import { lowRecoveries, recoveryFindings, compressionLows } from './recovery.js';

const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
const us = (navigator.language || '').toLowerCase() === 'en-us';
let settings = withDefaults();
let people = [];

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const send = (msg) => chrome.runtime.sendMessage(msg);

// ---- what was learned ----

async function renderLearned() {
  const pid = $('learn-person').value;
  const p = people.find((x) => x.pid === pid);
  const units = displayUnits(settings, p);
  const fmt = (mg) => `${fmtGlucose(mg, units)} ${units}`;
  renderLows(pid, p, fmt);
  const model = (await store.get(learnedKey(pid)))[learnedKey(pid)];
  const list = $('findings');
  list.replaceChildren();
  $('dose-curves').replaceChildren();
  if (!model || model.empty) {
    $('learn-check').textContent = model?.empty
      ? `Not enough readings yet to learn from (it needs at least a day; ${model.readings || 0} saved).`
      : 'Not learned yet. It learns every few hours, or press "Learn again now".';
    return;
  }
  const c = model.check;
  const days = Math.max(1, Math.round((model.to - model.from) / 864e5));
  if (c) {
    const good = trustworthy(model);
    $('learn-check').className = `check-line${good ? ' good' : ''}`;
    $('learn-check').replaceChildren(
      `Learned from ${days} days, ${when(model.fittedAt)}. On the most recent days, which it did not learn from, its 1-hour estimates were off by `,
      h('strong', {}, fmt(c.mae)), ' on average; "stays the same" was off by ', fmt(c.flatMae), ' and "keeps its trend" by ', fmt(c.trendMae), '. ',
      good ? 'So its estimate line is shown on the graph.' : 'Not better yet, so the graph keeps the plain 20-minute line.',
    );
  } else {
    $('learn-check').textContent = `Learned from ${days} days. Its accuracy is checked once there are a few more days.`;
  }
  const lines = findings(model, fmt);
  for (const l of lines) list.append(h('li', {}, l.text));
  const missing = GROUPS.filter((g) => !model.kinds[g].learned && model.kinds[g].doses > 0);
  for (const g of missing) list.append(h('li', {}, `${FACTORS[g].label[0].toUpperCase()}${FACTORS[g].label.slice(1)}: ${model.kinds[g].doses} dose(s) with readings so far; it needs ${FACTORS[g].min} to say how it works for you.`));
  if (!lines.length && !missing.length) list.append(h('li', {}, 'Log insulin, meals and exercise with amounts (the + on the mini window) and it learns what each does for you.'));
  drawCurves(model, fmt);
}

/** What past lows teach: how long they lasted, what was eaten, how fast it worked; likely compression lows. */
let lowsRun = 0;
async function renderLows(pid, p, fmt) {
  const run = ++lowsRun;
  const points = wholeSeries(await loadReadings(pid, Date.now() - 60 * 864e5));
  const { events = [] } = await store.get('events');
  if (run !== lowsRun) return;
  const low = settings.alerts?.low ?? p?.low ?? 70;
  const high = p?.high ?? 180;
  const lines = recoveryFindings(lowRecoveries(points, events, pid, { low, high }), fmt);
  const comp = compressionLows(points, events, pid, { low });
  if (comp.length) lines.push(`${comp.length} overnight dip${comp.length === 1 ? '' : 's'} in the last 60 days look like pressure on the sensor (compression lows): sudden, short, and back up with nothing eaten. They are marked with a ? on the graph.`);
  if (!lines.length) lines.push('Not enough lows in the last 60 days to say anything yet, which is good news.');
  $('lows').replaceChildren(...lines.map((t) => h('li', {}, t)));
}

/** How 1 unit of each learned insulin lowers glucose over the hours after it. */
function drawCurves(model, fmt) {
  const kinds = GROUPS.filter((g) => model.kinds[g].learned);
  if (!kinds.length) return;
  const W = 700, H = 150, padL = 44, padB = 18, padT = 8;
  const maxH = Math.max(...kinds.map((g) => model.kinds[g].durationMin)) / 60;
  const maxV = Math.max(...kinds.map((g) => model.kinds[g].isf));
  const x = (hr) => padL + (hr / maxH) * (W - padL - 10);
  const y = (v) => padT + (v / maxV) * (H - padT - padB);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a = {}, text) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'How 1 unit of each insulin lowers you over time' });
  svg.append(el('line', { class: 'axis', x1: padL, x2: W - 10, y1: padT, y2: padT }));
  for (let hr = 0; hr <= maxH; hr += maxH > 10 ? 2 : 1) svg.append(el('text', { x: x(hr), y: H - 4, 'text-anchor': 'middle' }, `${hr}h`));
  svg.append(el('text', { x: padL - 6, y: y(maxV), 'text-anchor': 'end' }, `−${fmt(maxV).split(' ')[0]}`));
  svg.append(el('text', { x: padL - 6, y: padT + 4, 'text-anchor': 'end' }, '0'));
  kinds.forEach((g, i) => {
    const k = model.kinds[g];
    let d = '';
    for (let m = 0; m <= k.durationMin; m += 5) d += `${m ? 'L' : 'M'}${x(m / 60).toFixed(1)},${y(k.isf * (1 - activeFraction(m, k))).toFixed(1)}`;
    svg.append(el('path', { class: `curve c-${g}`, d }));
    svg.append(el('text', { class: `legend`, x: W - 12, y: H - padB - 6 - i * 13, 'text-anchor': 'end', fill: 'currentColor' }, `${FACTORS[g].label}: 1 unit`));
  });
  $('dose-curves').append(svg);
}

$('learn-now').addEventListener('click', async () => {
  $('learn-msg').textContent = 'Learning…';
  const r = await send({ type: 'learnNow' }).catch((e) => ({ ok: false, error: e.message }));
  $('learn-msg').textContent = r?.ok ? 'Done.' : `Could not learn: ${r?.error || 'unknown'}`;
  renderLearned();
});
$('learn-person').addEventListener('change', renderLearned);

// ---- connections ----

// Cards are built off-page and swapped in at once; when two redraws overlap, the newest wins.
let connectorsRun = 0;
async function renderConnectors() {
  const run = ++connectorsRun;
  const cards = [];
  const ctx = { settings, account: await googleAccount(), state: await store.get(['driveState', 'connectors']), refresh: renderAll, send, h, saveSetting, connectDrive, disconnectDrive, when };
  for (const c of CONNECTORS) {
    const card = h('li', { class: 'connector' },
      h('div', { class: 'name' }, h('span', { class: 'icon' }, c.icon), c.name),
      h('div', { class: 'what' }, c.what));
    const extra = await (c.render?.(ctx) ?? null);
    if (extra) card.append(...[extra].flat().filter(Boolean));
    cards.push(card);
  }
  if (run === connectorsRun) $('connectors').replaceChildren(...cards);
}

async function saveSetting(patch) {
  const { settings: raw } = await store.get('settings');
  await store.set({ settings: withDefaults({ ...raw, ...patch }) });
  settings = withDefaults({ ...raw, ...patch });
}

// Google Drive lives here (not in connectors.js) because sign-in needs this page's click.
async function connectDrive() {
  const ok = await chrome.permissions.request({ origins: GOOGLE_HOSTS }).catch(() => false);
  if (!ok) throw new Error('su94r Mini needs permission to reach Google to save there.');
  await getToken(DRIVE_SCOPES, { interactive: true });
  await saveSetting({ driveBackup: true });
  return send({ type: 'driveSave' });
}
async function disconnectDrive() {
  await saveSetting({ driveBackup: false });
  // Google Health uses the same sign-in: keep it unless that is off too.
  const { connectors = {} } = await store.get('connectors');
  if (!connectors.googleHealth?.on) await signOutGoogle();
}

// ---- add by hand ----

const manualTypes = Object.entries(TYPES).filter(([, t]) => t.manual);
function fillTypes() {
  const sel = $('m-type');
  for (const [k, t] of manualTypes) sel.append(h('option', { value: k }, `${t.icon} ${k === 'bloodPressureSystolic' ? 'Blood pressure' : t.label}`));
  $('type-names').textContent = Object.entries(TYPES).map(([k, t]) => `${k} (${t.label}, ${t.unit || 'number'})`).join(' · ');
  setUnit();
}
function unitFor(type) {
  if (type === 'bodyMass') return us ? 'lb' : 'kg';
  if (type === 'bodyTemperature') return us ? '°F' : '°C';
  if (type === 'hydration') return us ? 'fl oz' : 'mL';
  if (type === 'sleepAnalysis') return 'h';
  if (type === 'bloodGlucose') return displayUnits(settings, people[0]);
  return TYPES[type].unit;
}
function setUnit() {
  const type = $('m-type').value;
  $('m-unit').textContent = unitFor(type);
  $('m-value2-wrap').hidden = type !== 'bloodPressureSystolic';
  $('m-value-wrap').firstChild.textContent = type === 'bloodPressureSystolic' ? 'Top number' : type === 'sleepAnalysis' ? 'Hours slept' : 'Value';
}
$('m-type').addEventListener('change', setUnit);
const localInput = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
$('m-when').value = localInput(Date.now());

$('m-add').addEventListener('click', async () => {
  const type = $('m-type').value;
  const v = Number($('m-value').value);
  const t = $('m-when').value ? new Date($('m-when').value).getTime() : Date.now();
  const note = $('m-note').value.trim() || undefined;
  if (!Number.isFinite(v) || !$('m-value').value) { $('m-msg').textContent = 'Type a number first.'; return; }
  const unit = unitFor(type);
  const rows = [];
  if (type === 'sleepAnalysis') rows.push({ type, t: t - v * 3600e3, end: t, value: v * 60, unit: 'min', src: 'manual', note });
  else rows.push({ type, t, value: v, unit, src: 'manual', note });
  if (type === 'bloodPressureSystolic') {
    const v2 = Number($('m-value2').value);
    if (!Number.isFinite(v2) || !$('m-value2').value) { $('m-msg').textContent = 'Type both blood pressure numbers.'; return; }
    rows.push({ type: 'bloodPressureDiastolic', t, value: v2, unit: 'mmHg', src: 'manual', note });
  }
  const r = await putSamples(rows);
  if (r.stored) send({ type: 'driveDirty', times: rows.map((x) => x.t) }).catch(() => {});
  $('m-msg').textContent = r.stored ? 'Added.' : 'That value looks out of range, so it was not added.';
  if (r.stored) { $('m-value').value = ''; $('m-value2').value = ''; $('m-note').value = ''; renderStored(); }
});

// ---- what is stored ----

function spark(points) {
  if (points.length < 2) return null;
  const vs = points.map((p) => p.value);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 28');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * 100).toFixed(1)},${(26 - ((p.value - lo) / (hi - lo || 1)) * 24).toFixed(1)}`).join(''));
  svg.append(path);
  return svg;
}

async function renderStored() {
  const days = Number($('range').value);
  const shown2 = { us, glucoseUnits: displayUnits(settings, people.find((x) => x.pid === settings.vaultOwner) || people[0]) };
  const samples = await getSamples({ from: Date.now() - days * 864e5 });
  const sum = summarize(samples).sort((a, b) => Object.keys(TYPES).indexOf(a.type) - Object.keys(TYPES).indexOf(b.type));
  $('empty').hidden = sum.length > 0;
  const tiles = $('tiles');
  tiles.replaceChildren();
  for (const s of sum) {
    const t = TYPES[s.type];
    const combine = t.combine;
    const perDay = daily(samples, s.type);
    const shown = combine === 'sum' && perDay.length
      ? `${showValue(s.type, perDay[perDay.length - 1].value, shown2)} ${perDay[perDay.length - 1].day === new Date().toLocaleDateString('en-CA') ? 'today' : 'last day'}`
      : s.type === 'bloodPressureSystolic'
        ? `${Math.round(s.latest.value)}/${Math.round(samples.filter((x) => x.type === 'bloodPressureDiastolic' && x.t === s.latest.t)[0]?.value ?? 0) || '?'} mmHg`
        : showValue(s.type, s.latest.value, shown2);
    if (s.type === 'bloodPressureDiastolic') continue;
    tiles.append(h('div', { class: 'tile', title: `${s.count} readings from ${s.sources.join(', ')}` },
      h('span', { class: 'label' }, `${t.icon} ${s.type === 'bloodPressureSystolic' ? 'Blood pressure' : t.label}`),
      h('span', { class: 'value' }, shown),
      h('span', { class: 'when' }, `${when(s.latest.t)} · ${s.sources.join(', ')}`),
      spark(perDay)));
  }
  const rows = $('rows');
  rows.replaceChildren();
  for (const s of samples.slice(-300).reverse()) {
    rows.append(h('tr', {},
      h('td', {}, when(s.t)),
      h('td', {}, TYPES[s.type]?.label || s.type),
      h('td', {}, showValue(s.type, s.value, shown2) + (s.note ? ` · ${s.note}` : '')),
      h('td', {}, s.src),
      h('td', {}, h('button', { type: 'button', class: 'ghost', onclick: async () => { await removeSamples([s]); renderStored(); } }, 'Delete'))));
  }
}
$('range').addEventListener('change', renderStored);

// ---- import ----

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $('import-msg').textContent = 'Reading…';
  try {
    const parsed = parseImport(await file.text(), file.name);
    const r = await putSamples(parsed.samples);
    if (r.stored) send({ type: 'driveDirty', times: parsed.samples.map((x) => x.t) }).catch(() => {});
    let extra = '';
    if (parsed.markers?.length || parsed.readings?.length) {
      const back = await send({ type: 'importDriveFile', file: parsed.raw });
      extra = back?.ok ? ` Also ${back.readings} glucose readings and ${back.markers} markers.` : '';
    }
    $('import-msg').textContent = `${r.added} new readings added (${r.stored - r.added} already here, ${r.rejected} skipped) from ${parsed.format}.${extra}`;
    renderStored();
  } catch (err) {
    $('import-msg').textContent = `Could not read that file: ${err.message}`;
  }
  e.target.value = '';
});

// ---- start ----

async function renderAll() {
  settings = withDefaults((await store.get('settings')).settings);
  await renderConnectors();
  await renderLearned();
  await renderStored();
}

(async () => {
  settings = withDefaults((await store.get('settings')).settings);
  people = (await allPatients({ ...settings, demo: false })).filter((p) => !isDemo(p.pid));
  const sel = $('learn-person');
  for (const p of people) sel.append(h('option', { value: p.pid }, p.name || 'Someone'));
  if (!people.length) sel.hidden = true;
  // Whose health data the vault is: nobody until chosen.
  const own = $('vault-owner');
  own.append(h('option', { value: '' }, 'Choose who uses this computer…'), ...people.map((p) => h('option', { value: p.pid }, p.name || 'Someone')));
  own.value = people.some((p) => p.pid === settings.vaultOwner) ? settings.vaultOwner : '';
  if (own.value) sel.value = own.value;
  own.addEventListener('change', async () => {
    await saveSetting({ vaultOwner: own.value });
    send({ type: 'learnNow' }).catch(() => {});
  });
  fillTypes();
  await renderAll();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k.startsWith('learned:'))) renderLearned();
    if (changes.driveState || changes.google || changes.connectors) renderConnectors();
  });
})();
