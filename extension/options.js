import { watchContext } from './lifecycle.js';
import {
  withDefaults, displayUnits, MGDL_PER_MMOL, EVENT_TYPES, toCsv, mergeSeries, sensorStatus, fmtDuration, localDate,
} from './glucose.js';
import {
  loadReadings, saveReadings, wholeSeries, findGaps, coverage, clearReadings, firstReading,
} from './archive.js';
import { parseLibreViewCsv } from './libreview-csv.js';
import { allPatients, ptKey } from './store.js';
import { addEvents, removeEvents } from './events.js';
import { isLegacy, NEW_ID } from './handover.js';
import { parseScreenLink, claimScreen, listScreens, removeScreen } from './voice.js';
import { insulinTiming } from './insights.js';
import { searchMedication, defaultUnit, MED_UNITS } from './meds.js';
import { listDevices, forgetDevice, deviceId, heartbeat } from './sync.js';
import { PROVIDERS, DEFAULT_MODELS, CLAUDE_MODELS, ollamaModels, pickOllamaModel, connectOpenRouter, describeProvider } from './ai.js';

const $ = (id) => document.getElementById(id);
const local = chrome.storage.local;
const ALERT_FLAGS = ['enabled', 'urgentLowOn', 'lowOn', 'highOn', 'fallingFast', 'risingFast', 'noData'];
const ALERT_LIMITS = ['urgentLow', 'low', 'high'];

let state = {};
let patients = [];
let selected = null;

function say(text, kind = '') {
  const msg = $('msg');
  msg.textContent = text;
  msg.className = `msg ${kind}`;
}

async function settings() {
  const { settings: s } = await local.get('settings');
  return withDefaults(s);
}

async function saveSetting(patch) {
  await local.set({ settings: withDefaults({ ...(await settings()), ...patch }) });
}

async function saveAlert(patch) {
  const s = await settings();
  await local.set({ settings: withDefaults({ ...s, alerts: { ...s.alerts, ...patch } }) });
}

function owner() {
  return selected;
}

// Limits are stored in mg/dL and shown in the display units.
const toShown = (mg, u) => (u === 'mmol/L' ? (mg / MGDL_PER_MMOL).toFixed(1) : String(Math.round(mg)));
const fromShown = (v, u) => (u === 'mmol/L' ? Number(v) * MGDL_PER_MMOL : Number(v));

async function refresh() {
  state = await local.get(['accounts', 'events']);
  const s = await settings();
  patients = await allPatients(s);
  if (!patients.some((p) => p.pid === selected)) selected = patients[0]?.pid || null;
  const sel = patients.find((p) => p.pid === selected);
  const u = displayUnits(s, sel);

  renderPeople(s);
  renderAccounts();
  $('who').replaceChildren(...patients.map((p) => new Option(p.name || 'Unnamed', p.pid, false, p.pid === selected)));
  $('who').disabled = patients.length < 2;

  // Alerts
  for (const k of ALERT_FLAGS) $(`a-${k}`).checked = Boolean(s.alerts[k]);
  for (const k of ALERT_LIMITS) {
    const input = $(`a-${k}`);
    input.step = u === 'mmol/L' ? '0.1' : '1';
    if (document.activeElement !== input) input.value = toShown(s.alerts[k], u);
  }
  for (const el of document.querySelectorAll('.u')) el.textContent = u;
  $('alert-rows').classList.toggle('off', !s.alerts.enabled);
  $('a-sound').value = s.alerts.sound;

  // Sensor
  $('sensorDays').value = String(s.sensorDays);
  $('sensorReminder').checked = s.sensorReminder;
  const ss = sensorStatus(sel?.sensor, s.sensorDays);
  $('sensor-now').textContent = !ss ? 'No sensor information yet.'
    : ss.kind === 'warming' ? `Current sensor is warming up (${fmtDuration(ss.left)} left).`
    : ss.kind === 'ended' ? `Current sensor ended ${new Date(ss.end).toLocaleString()}.`
    : `Current sensor ends ${new Date(ss.end).toLocaleString()} (${fmtDuration(ss.left)} left).`;
  if (ss && patients.length > 1) $('sensor-now').textContent = `${sel.name}: ${$('sensor-now').textContent}`;

  // Window
  $('units').value = s.units;
  $('projection').checked = s.projection;
  $('badge').checked = s.badge;
  $('startup').checked = s.openOnStartup;
  $('desktopWidget').checked = s.desktopWidget !== false;
  $('demo').checked = s.demo;
  $('demo').disabled = Boolean(state.accounts?.length) && !s.demo;

  $('rapidInsulin').value = s.rapidInsulin;
  renderMeds(s);
  renderDevices(s);
  renderVoice(s);
  renderHandover();
  renderAi();
  renderMarkers(s);
  renderHistory();
  renderTiming();
}

// ---------- AI ----------
async function aiConfig() {
  const { ai } = await local.get('ai');
  return { provider: null, models: {}, keys: {}, consent: {}, customBase: '', ...(ai || {}) };
}
async function saveAi(patch) {
  const cur = await aiConfig();
  const next = { ...cur, ...patch, models: { ...cur.models, ...(patch.models || {}) }, keys: { ...cur.keys, ...(patch.keys || {}) }, consent: { ...cur.consent, ...(patch.consent || {}) } };
  await local.set({ ai: next });
  return next;
}
let ollamaChecked = false;
async function renderAi() {
  const cfg = await aiConfig();
  for (const r of document.querySelectorAll('input[name="aiProvider"]')) r.checked = r.value === cfg.provider;
  if (!$('anthropicModel').options.length) $('anthropicModel').replaceChildren(...CLAUDE_MODELS.map(([id, label]) => new Option(label, id)));
  $('anthropicModel').value = cfg.models.anthropic || DEFAULT_MODELS.anthropic;
  const fill = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v || ''; };
  fill('orModel', cfg.models.openrouter);
  fill('anthropicKey', cfg.keys.anthropic);
  fill('geminiKey', cfg.keys.gemini);
  fill('geminiModel', cfg.models.gemini);
  fill('customBase', cfg.customBase);
  fill('customKey', cfg.keys.custom);
  fill('customModel', cfg.models.custom);
  $('orStatus').textContent = cfg.keys.openrouter ? 'Connected ✓' : '';
  $('orConnect').textContent = cfg.keys.openrouter ? 'Disconnect' : 'Sign in with OpenRouter';
  const cloud = cfg.provider && PROVIDERS[cfg.provider].cloud;
  $('consentRow').hidden = !cloud;
  if (cloud) {
    $('consentText').textContent = `I agree to send my glucose summary to ${PROVIDERS[cfg.provider].label}.`;
    $('aiConsent').checked = Boolean(cfg.consent[cfg.provider]);
  }
  if (!ollamaChecked) {
    ollamaChecked = true;
    try {
      const names = await ollamaModels();
      $('ollamaModel').replaceChildren(...names.map((n) => new Option(n, n)));
      const chosen = cfg.models.ollama && names.includes(cfg.models.ollama) ? cfg.models.ollama : pickOllamaModel(names);
      $('ollamaModel').value = chosen;
      if (chosen && chosen !== cfg.models.ollama) await saveAi({ models: { ollama: chosen } });
      $('ollamaStatus').textContent = names.length ? `Found ${names.length} model${names.length === 1 ? '' : 's'}.` : 'Ollama is running but has no models. Run: ollama pull gemma3';
    } catch (err) {
      $('ollamaModel').hidden = true;
      $('ollamaStatus').textContent = err.code === 'origin'
        ? err.message
        : 'Not found. Install Ollama from ollama.com, then run: ollama pull gemma3';
    }
  }
}
for (const r of document.querySelectorAll('input[name="aiProvider"]')) {
  r.addEventListener('change', async () => { await saveAi({ provider: r.value }); renderAi(); });
}
$('ollamaModel').addEventListener('change', (e) => saveAi({ models: { ollama: e.target.value } }));
$('orModel').addEventListener('change', (e) => saveAi({ models: { openrouter: e.target.value.trim() } }));
$('anthropicKey').addEventListener('change', (e) => saveAi({ keys: { anthropic: e.target.value.trim() } }));
$('anthropicModel').addEventListener('change', (e) => saveAi({ models: { anthropic: e.target.value } }));
$('geminiKey').addEventListener('change', (e) => saveAi({ keys: { gemini: e.target.value.trim() } }));
$('geminiModel').addEventListener('change', (e) => saveAi({ models: { gemini: e.target.value.trim() } }));
$('aiConsent').addEventListener('change', async (e) => {
  const cfg = await aiConfig();
  if (cfg.provider) await saveAi({ consent: { [cfg.provider]: e.target.checked } });
});
$('orConnect').addEventListener('click', async () => {
  const cfg = await aiConfig();
  if (cfg.keys.openrouter) {
    await saveAi({ keys: { openrouter: '' } });
    say('Disconnected from OpenRouter.');
    renderAi();
    return;
  }
  try {
    const key = await connectOpenRouter();
    await saveAi({ provider: 'openrouter', keys: { openrouter: key } });
    say('Connected to OpenRouter.', 'ok');
  } catch (err) {
    say(`OpenRouter sign-in did not finish: ${err.message}`, 'error');
  }
  renderAi();
});
$('customSave').addEventListener('click', async () => {
  const base = $('customBase').value.trim();
  let origin;
  try { origin = new URL(base).origin; } catch { say('Enter a full base URL, e.g. https://api.example.com/v1', 'error'); return; }
  // Ask Chrome for access to just this one service.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) { say('Access to that address was not allowed.', 'error'); return; }
  await saveAi({ provider: 'custom', customBase: base, keys: { custom: $('customKey').value.trim() }, models: { custom: $('customModel').value.trim() } });
  say('Saved.', 'ok');
  renderAi();
});
$('aiOpen').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openAi', pid: owner() }));

async function renderDevices(s) {
  const { syncError, syncQueue } = await local.get(['syncError', 'syncQueue']);
  const waiting = (syncQueue?.upsert?.length || 0) + (syncQueue?.remove?.length || 0);
  $('sync-status').classList.toggle('bad', Boolean(syncError));
  $('sync-status').textContent = syncError
    ? `Sync problem: ${syncError.message} (${new Date(syncError.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}).`
      + (waiting ? ` ${waiting} change${waiting === 1 ? '' : 's'} waiting to be sent; they are retried every few minutes.` : '')
      + ' Check that Chrome sync is on (Settings → You and Google → Sync).'
    : `Sync works. Extension ID ${chrome.runtime.id}${chrome.runtime.id === NEW_ID ? ' (the same on every computer)' : ''}.`;
  const me = await deviceId();
  if (document.activeElement !== $('deviceName')) $('deviceName').value = s.deviceName || '';
  let devices = [];
  try { devices = await listDevices(); } catch { /* sync unavailable */ }
  const list = $('devices');
  if (!devices.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'This computer will appear here within a minute.' }));
    return;
  }
  list.replaceChildren(...devices.map((d) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    const ago = Math.round((Date.now() - d.lastSeen) / 60e3);
    const seen = ago < 2 ? 'active now' : ago < 120 ? `seen ${ago} min ago` : `seen ${new Date(d.lastSeen).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    text.textContent = `${d.id === me ? '★ ' : ''}${d.name} · ${d.browser} · v${d.version} · ${seen}${d.id === me ? ' (this computer)' : ''}`;
    li.append(text);
    // Which computers sound the urgent-low alarm. Shared, so any computer can set all of them.
    const alarm = document.createElement('label');
    alarm.className = 'check alarm-switch';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !s.quietDevices?.[d.id];
    box.onchange = async () => {
      const cur = await settings();
      const quiet = { ...(cur.quietDevices || {}) };
      if (box.checked) delete quiet[d.id]; else quiet[d.id] = true;
      await saveSetting({ quietDevices: quiet });
      say(box.checked ? `${d.name} will sound the urgent-low alarm.` : `${d.name} will show urgent lows quietly, without the alarm.`, box.checked ? 'ok' : undefined);
    };
    alarm.append(box, ' Urgent-low alarm');
    alarm.title = 'Sound the loud, sticky urgent-low alarm on this computer';
    li.append(alarm);
    if (d.id !== me) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ghost';
      rm.textContent = 'Forget';
      rm.title = 'Remove from this list (it comes back if that computer still runs the extension)';
      rm.onclick = async () => { await forgetDevice(d.id); refresh(); };
      li.append(rm);
    }
    return li;
  }));
}
$('deviceName').addEventListener('change', async (e) => {
  await saveSetting({ deviceName: e.target.value.trim() });
  await heartbeat(await settings(), patients.length, { force: true }).catch(() => {});
  refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && Object.keys(changes).some((k) => k.startsWith('dev:'))) refresh();
});

function renderMeds(s) {
  const list = $('medList');
  const meds = s.meds || [];
  if (!meds.length) {
    const li = document.createElement('li');
    li.textContent = 'No medicines yet. Search above and add the ones you take.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...meds.map((med, i) => {
    const li = document.createElement('li');
    li.className = 'med-row';
    const name = document.createElement('span');
    name.textContent = `${med.isInsulin ? '💉' : '💊'} ${med.display || med.name}`;
    name.style.flex = '1';
    const dose = document.createElement('input');
    dose.type = 'number';
    dose.min = '0';
    dose.step = 'any';
    dose.className = 'num';
    dose.placeholder = 'usual';
    dose.value = med.dose ?? '';
    dose.title = 'Usual amount, filled in when you log it';
    dose.onchange = () => updateMed(i, { dose: dose.value === '' ? null : Number(dose.value) });
    const unit = document.createElement('select');
    unit.replaceChildren(...MED_UNITS.map((u) => new Option(u, u, false, u === med.unit)));
    unit.disabled = Boolean(med.isInsulin);
    unit.onchange = () => updateMed(i, { unit: unit.value });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost';
    rm.textContent = 'Remove';
    rm.onclick = () => updateMed(i, null);
    li.append(name, dose, unit, rm);
    return li;
  }));
}

async function updateMed(index, patch) {
  const s = await settings();
  const meds = [...(s.meds || [])];
  if (patch === null) meds.splice(index, 1);
  else meds[index] = { ...meds[index], ...patch };
  await saveSetting({ meds });
}

async function runMedSearch() {
  const q = $('medSearch').value.trim();
  const box = $('medResults');
  if (q.length < 2) return;
  box.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Searching…' }));
  try {
    const { results, suggestions } = await searchMedication(q);
    if (!results.length) {
      box.replaceChildren(Object.assign(document.createElement('li'), {
        textContent: suggestions.length ? `No match. Did you mean: ${suggestions.slice(0, 4).join(', ')}?` : 'No match found.',
      }));
      return;
    }
    box.replaceChildren(...results.slice(0, 12).map((r) => {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${r.isInsulin ? '💉' : '💊'} ${r.display}${r.concentration ? ` · ${r.concentration}` : ''}`;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ghost';
      add.textContent = 'Add';
      add.onclick = async () => {
        const s = await settings();
        if ((s.meds || []).some((x) => x.rxcui === r.rxcui)) return;
        await saveSetting({ meds: [...(s.meds || []), { rxcui: r.rxcui, name: r.name, display: r.display, isInsulin: r.isInsulin, form: r.form, unit: defaultUnit(r), dose: null }] });
        box.replaceChildren();
        $('medSearch').value = '';
        say(`Added ${r.display}.`, 'ok');
      };
      li.append(text, add);
      return li;
    }));
  } catch (err) {
    box.replaceChildren(Object.assign(document.createElement('li'), { textContent: err.message }));
  }
}
$('medGo').addEventListener('click', runMedSearch);
$('medSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') runMedSearch(); });

const mins = (m) => {
  const r = Math.round(m / 5) * 5;
  return r < 90 ? `${r} min` : `${Math.floor(r / 60)} h ${r % 60 ? `${r % 60} min` : ''}`.trim();
};

async function renderTiming() {
  const el = $('timing');
  const pid = owner();
  if (!pid) { el.textContent = 'Nothing yet.'; return; }
  const points = wholeSeries(await loadReadings(pid, Date.now() - 90 * 864e5));
  const r = insulinTiming(points, state.events || [], pid);
  const lines = [];
  if (r.enough) {
    const c = r.correction;
    lines.push(`Rapid insulin, from <strong>${c.n} doses</strong> with no food logged nearby: starts lowering glucose after about <strong>${mins(c.onset)}</strong>, works hardest at about <strong>${mins(c.peak)}</strong>, mostly done after about <strong>${mins(c.end)}</strong>.`);
    if (r.split) {
      const a = r.split.withExercise, b = r.split.withoutExercise;
      lines.push(`With exercise logged nearby (${a.n}): hardest at about ${mins(a.peak)}, done after about ${mins(a.end)}. Without exercise (${b.n}): hardest at about ${mins(b.peak)}, done after about ${mins(b.end)}.`);
    } else {
      lines.push('Log exercise too (+ button or click the graph), and once there are 3 doses each with and without exercise, this compares active days with sitting days.');
    }
  } else {
    lines.push(`Not enough yet: ${r.usable} of ${r.total} rapid doses can be timed. It needs ${r.minDoses} doses with no food logged from 1 hour before to 4 hours after, and a glucose drop of at least 20 mg/dL (1.1 mmol/L). Picking the injection site when you log helps too.`);
  }
  if (r.bySite) {
    const names = { belly: 'belly', thigh: 'thigh', arm: 'arm', buttock: 'buttock' };
    lines.push('By injection area: ' + Object.entries(r.bySite).map(([a, s]) => `${names[a] || a} (${s.n}) hardest at about ${mins(s.peak)}, done after about ${mins(s.end)}`).join('; ') + '.');
  }
  if (r.meals.n >= r.minDoses) lines.push(`With meals (${r.meals.n}): glucose peaked about <strong>${mins(r.meals.peakAfter)}</strong> after the dose${r.meals.backAfter != null ? ` and was back near where it started after about ${mins(r.meals.backAfter)}` : ''}.`);
  const k = r.skipped;
  const left = [[k.stacked, 'other insulin within 2 h before or 4 h after'], [k.foodNearby, 'food logged nearby'], [k.gaps, 'sensor gaps'], [k.unclear, 'too small a change to time'], [k.tooRecent, 'less than 5 hours ago']].filter(([n]) => n);
  if (left.length) lines.push(`Left out: ${left.map(([n, why]) => `${n} (${why})`).join(', ')}.`);
  el.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
}

function renderPeople(s) {
  const list = $('people');
  if (!patients.length) {
    const li = document.createElement('li');
    li.textContent = s.demo ? 'Demo people appear within a minute.' : 'No one yet. Add a LibreLinkUp account below.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...patients.map((p) => {
    const li = document.createElement('li');
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('strong');
    name.textContent = p.name || 'Unnamed';
    const now = document.createElement('span');
    now.className = 'now';
    const u = displayUnits(s, p);
    now.textContent = p.latest ? `${p.latest.mg < 40 ? 'LO' : p.latest.mg > 400 ? 'HI' : (u === 'mmol/L' ? (p.latest.mg / MGDL_PER_MMOL).toFixed(1) : p.latest.mg)} ${u} · ${new Date(p.latest.t).toLocaleTimeString([], { timeStyle: 'short' })}` : 'waiting for a reading';
    who.append(name, now);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ghost';
    open.textContent = 'Open window';
    open.onclick = () => chrome.runtime.sendMessage({ type: 'openMini', pid: p.pid });
    li.append(who, open);
    return li;
  }));
}

function renderAccounts() {
  const accounts = state.accounts || [];
  $('add-account').open = accounts.length === 0;
  $('add-summary').textContent = accounts.length ? 'Add another LibreLinkUp account' : 'Add a LibreLinkUp account';
  if (!accounts.length) {
    const li = document.createElement('li');
    li.textContent = 'No accounts yet.';
    $('accounts').replaceChildren(li);
    return;
  }
  $('accounts').replaceChildren(...accounts.map((a) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = a.label || 'LibreLinkUp account';
    const info = document.createElement('div');
    const n = (a.patientIds || []).length;
    if (!a.session) { info.className = 'bad'; info.textContent = a.state?.message || 'Signed out. Remove it and add it again.'; }
    else if (a.state?.status === 'error') { info.className = 'bad'; info.textContent = a.state.message; }
    else info.textContent = `Following ${n} ${n === 1 ? 'person' : 'people'}`;
    text.append(label, info);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost';
    rm.textContent = 'Remove';
    rm.onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'removeAccount', id: a.id });
      say('Account removed. Saved history stays until you delete it.');
      refresh();
    };
    li.append(text, rm);
    return li;
  }));
}

function renderMarkers(s) {
  const list = $('markers');
  const mine = (state.events || []).filter((e) => e.p === owner()).slice(-20).reverse();
  if (!mine.length) {
    const li = document.createElement('li');
    li.textContent = 'No markers yet.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...mine.map((e) => {
    const type = EVENT_TYPES[e.type] || { icon: '•', label: e.type, unit: '' };
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${type.icon} ${type.label}${e.amount != null ? ` · ${e.amount} ${type.unit}` : ''}`
      + `${e.note ? ` (${e.note})` : ''} · ${new Date(e.t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost';
    del.textContent = 'Delete';
    del.onclick = async () => {
      try { await removeEvents([e.id]); } catch (err) { say(err.message, 'error'); }
    };
    li.append(text, del);
    return li;
  }));
}

async function renderHistory() {
  const pid = owner();
  const summary = $('history-summary');
  const gapsEl = $('gaps');
  if (!pid) {
    summary.textContent = 'Nothing saved yet. Sign in to start saving readings.';
    gapsEl.replaceChildren();
    return;
  }
  const first = await firstReading(pid);
  if (!first) {
    summary.textContent = 'Nothing saved yet. Readings are saved from the first update after sign-in.';
    gapsEl.replaceChildren();
    return;
  }
  const points = wholeSeries(await loadReadings(pid, first.t));
  const days = (Date.now() - first.t) / 864e5;
  const cov = coverage(points);
  summary.textContent = `${points.length.toLocaleString()} readings saved over ${days < 1 ? `${Math.round(days * 24)} hours` : `${days.toFixed(1)} days`}`
    + ` (since ${new Date(first.t).toLocaleDateString()}). ${Math.round(cov * 100)}% complete.`;
  const gaps = findGaps(points, 60 * 60e3).slice(0, 8);
  gapsEl.replaceChildren(...gaps.map((g) => {
    const div = document.createElement('div');
    div.className = 'gap';
    const fmt = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    div.textContent = `Gap: ${fmt(g.from)} → ${fmt(g.to)} (${fmtDuration(g.to - g.from)})`;
    return div;
  }));
}

// ---- sign-in ----

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  say('');
  const res = await chrome.runtime.sendMessage({ type: 'login', email: $('email').value, password: $('password').value });
  btn.disabled = false;
  btn.textContent = 'Sign in';
  $('password').value = '';
  if (res?.ok) say(`Signed in. Following ${res.patients} ${res.patients === 1 ? 'person' : 'people'}.`, 'ok');
  else say(res?.error || 'Sign-in failed.', 'error');
  refresh();
});

$('open-board').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openBoard' }));
$('open-vault').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('vault.html') }));
$('open-report').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('report.html') }));
$('who').addEventListener('change', (e) => { selected = e.target.value; refresh(); });

// ---- settings ----

for (const k of ALERT_FLAGS) $(`a-${k}`).addEventListener('change', (e) => saveAlert({ [k]: e.target.checked }));
for (const k of ALERT_LIMITS) {
  $(`a-${k}`).addEventListener('change', async (e) => {
    const s = await settings();
    const mg = fromShown(e.target.value, displayUnits(s, patients.find((p) => p.pid === selected)));
    if (!Number.isFinite(mg) || mg < 40 || mg > 400) {
      say('Pick a value between 40 and 400 mg/dL (2.2–22.2 mmol/L).', 'error');
      refresh();
      return;
    }
    await saveAlert({ [k]: Math.round(mg) });
  });
}
$('a-sound').addEventListener('change', (e) => saveAlert({ sound: e.target.value }));
$('test-alert').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'testAlert' });
  say(res?.ok ? 'Test alert sent. Look at the bottom-right of your screen.' : res?.error || 'Could not send the test alert.', res?.ok ? 'ok' : 'error');
});

$('rapidInsulin').addEventListener('change', (e) => saveSetting({ rapidInsulin: e.target.value }));
$('sensorDays').addEventListener('change', (e) => saveSetting({ sensorDays: Number(e.target.value) }));
$('sensorReminder').addEventListener('change', (e) => saveSetting({ sensorReminder: e.target.checked }));
$('units').addEventListener('change', (e) => saveSetting({ units: e.target.value }));
$('projection').addEventListener('change', (e) => saveSetting({ projection: e.target.checked }));
$('badge').addEventListener('change', (e) => saveSetting({ badge: e.target.checked }));
$('startup').addEventListener('change', (e) => saveSetting({ openOnStartup: e.target.checked }));
$('desktopWidget').addEventListener('change', async (e) => {
  await saveSetting({ desktopWidget: e.target.checked });
  chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
});
$('demo').addEventListener('change', async (e) => {
  await saveSetting({ demo: e.target.checked });
  if (e.target.checked) {
    say('Demo mode on. Click the toolbar icon to see the window.', 'ok');
    chrome.runtime.sendMessage({ type: 'openMini' });
  } else {
    say('Demo mode off.');
  }
});

$('change-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
chrome.commands?.getAll((cmds) => {
  const c = cmds.find((x) => x.name === 'toggle-mini');
  $('shortcut').textContent = c?.shortcut || 'not set';
});

async function checkHelper() {
  try {
    const r = await fetch('http://127.0.0.1:47923/ping', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    const ok = r.ok && (await r.json()).app === 'libre-mini-pin';
    $('helper-status').textContent = ok
      ? '✓ The pin helper is running on this computer. The pin button keeps the window on top for good.'
      : 'The pin helper is not running.';
  } catch {
    $('helper-status').textContent = 'The pin helper is not running on this computer.';
  }
}

// ---- history ----

$('import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const s = await settings();
  const pid = owner();
  if (!pid) {
    say('Sign in first, so the import is filed under the right person.', 'error');
    return;
  }
  try {
    say('Importing…');
    const { readings, events } = parseLibreViewCsv(await file.text());
    const added = await saveReadings(pid, readings, 'import');
    // Those months go to Google Drive with the next save.
    if (added) chrome.runtime.sendMessage({ type: 'driveDirty', times: [...new Set(readings.map((r) => new Date(r.t).toISOString().slice(0, 7)))].map((m) => Date.parse(`${m}-01T00:00:00Z`)) }).catch(() => {});
    let newMarkers = 0;
    if (events.length) {
      const { events: stored = [] } = await local.get('events');
      const seen = new Set(stored.filter((x) => x.p === pid).map((x) => `${x.type}|${Math.round(x.t / 60e3)}|${x.amount ?? ''}`));
      const fresh = events
        .filter((x) => !seen.has(`${x.type}|${Math.round(x.t / 60e3)}|${x.amount ?? ''}`))
        .map((x) => ({ id: crypto.randomUUID(), p: pid, source: 'libreview', ...x }));
      newMarkers = fresh.length;
      if (fresh.length) await addEvents(fresh);
    }
    const span = readings.length ? `${new Date(readings[0].t).toLocaleDateString()} – ${new Date(readings[readings.length - 1].t).toLocaleDateString()}` : '';
    say(`Imported ${readings.length.toLocaleString()} readings (${span}). ${added.toLocaleString()} were new.`
      + (newMarkers ? ` Added ${newMarkers} insulin/carb marker${newMarkers === 1 ? '' : 's'}.` : ''), 'ok');
    refresh();
  } catch (err) {
    say(`Import failed: ${err.message}`, 'error');
  }
});

$('export').addEventListener('click', async () => {
  const s = await settings();
  const pid = owner();
  const days = Number($('export-days').value);
  const from = days ? Date.now() - days * 864e5 : 0;
  const { [ptKey(pid)]: person = {}, events = [] } = await local.get([ptKey(pid), 'events']);
  const saved = wholeSeries(await loadReadings(pid, from));
  const recent = mergeSeries(person.hist || [], person.live || []).filter((p) => p.t >= from);
  const cutoff = recent.length ? recent[0].t : Infinity;
  const points = [...saved.filter((p) => p.t < cutoff - 60e3), ...recent];
  if (!points.length) {
    say('No readings saved for that period yet.', 'error');
    return;
  }
  const csv = toCsv(points, events.filter((e) => e.p === pid && e.t >= from));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `glucose-${localDate(Date.now())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  say(`Downloaded ${points.length.toLocaleString()} readings.`, 'ok');
});

$('clear-history').addEventListener('click', async () => {
  const s = await settings();
  const pid = owner();
  if (!pid || !confirm('Delete the saved readings and the AI conversation for this person from this browser? Markers and doses are kept.')) return;
  await clearReadings(pid);
  const { aiChats = {} } = await local.get('aiChats');
  if (aiChats[pid]) {
    delete aiChats[pid];
    await local.set({ aiChats });
  }
  say('Saved readings deleted.');
  refresh();
});

$('clear-markers').addEventListener('click', async () => {
  const pid = owner();
  if (!pid) return;
  const { events = [] } = await local.get('events');
  const ids = events.filter((e) => e.p === pid).map((e) => e.id);
  if (!ids.length) { say('No markers for this person.'); return; }
  if (!confirm(`Delete all ${ids.length} markers and doses for this person? Those from the last 30 days are deleted on ALL your computers; older ones only here. This cannot be undone.`)) return;
  try {
    await removeEvents(ids);
    say('Markers deleted on all computers.');
  } catch (err) {
    say(err.message, 'error');
  }
  refresh();
});

// ---- Alexa and screens ----

async function renderVoice(s) {
  if (document.activeElement !== $('screen-link')) $('screen-link').value = s.screenLink || '';
  const { voiceError } = await local.get('voiceError');
  $('voice-status').classList.toggle('bad', Boolean(voiceError));
  $('voice-status').textContent = !s.screenLink
    ? 'Not connected yet.'
    : voiceError
      ? `Could not reach the su94r server: ${voiceError.message}`
      : 'Connected. Doses said to Alexa appear here within a minute, and Alexa sees the doses logged here.';
  $('screens-box').hidden = !s.screenLink;
}

$('save-screen-link').addEventListener('click', async () => {
  const link = $('screen-link').value.trim();
  if (!link) {
    await saveSetting({ screenLink: '' });
    say('Alexa and screens disconnected.');
    return;
  }
  const p = parseScreenLink(link);
  if (!p) { say('That does not look like a big-screen link. It starts with https:// and has /d/ in it.', 'error'); return; }
  const granted = await chrome.permissions.request({ origins: [`${p.base}/*`] });
  if (!granted) { say('su94r Mini needs permission to reach that address.', 'error'); return; }
  await saveSetting({ screenLink: link });
  try {
    await listScreens(link);
    say('Connected to your su94r server.', 'ok');
    chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  } catch (err) {
    say(`Saved, but the server did not answer: ${err.message}`, 'error');
  }
  refreshScreens();
});

async function refreshScreens() {
  const s = await settings();
  const list = $('screens');
  if (!s.screenLink) { list.replaceChildren(); return; }
  let screens = [];
  try { screens = (await listScreens(s.screenLink)).screens || []; } catch (err) {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: err.message }));
    return;
  }
  if (!screens.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'No screens yet.' }));
    return;
  }
  list.replaceChildren(...screens.map((sc) => {
    const li = document.createElement('li');
    const seen = sc.last_seen ? `seen ${new Date(sc.last_seen).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'not seen yet';
    li.append(Object.assign(document.createElement('span'), { textContent: `${sc.kind === 'widget' ? '🔲' : sc.kind === 'ai' ? '✳️' : '🖥️'} ${sc.name || 'Screen'} · ${seen}` }));
    const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Remove' });
    rm.onclick = async () => {
      if (!confirm(`Remove ${sc.name || 'this screen'}? It stops showing your glucose at once.`)) return;
      try { await removeScreen(s.screenLink, sc.id); say('Screen removed.'); } catch (err) { say(err.message, 'error'); }
      refreshScreens();
    };
    li.append(rm);
    return li;
  }));
}
$('screens-box').addEventListener('toggle', () => { if ($('screens-box').open) refreshScreens(); });

$('pair-screen').addEventListener('click', async () => {
  const s = await settings();
  try {
    const r = await claimScreen(s.screenLink, $('pair-code').value, $('pair-name').value.trim());
    if (!r.ok) { say(r.error || 'That code did not work.', 'error'); return; }
    $('pair-code').value = '';
    $('pair-name').value = '';
    say(`${r.name} is paired. It shows your glucose within a few seconds.`, 'ok');
    refreshScreens();
  } catch (err) {
    say(err.message, 'error');
  }
});

// The old "Libre Mini Graph" copy, or su94r Mini waiting to take over from it.
async function renderHandover() {
  const { retired, migratedFrom, handoverOffer } = await local.get(['retired', 'migratedFrom', 'handoverOffer']);
  const box = $('handover');
  if (isLegacy()) {
    box.hidden = false;
    $('handover-title').textContent = retired ? 'Moved to su94r Mini' : 'Libre Mini Graph is now su94r Mini';
    $('handover-text').textContent = retired
      ? 'Everything was moved to su94r Mini, which now polls and alerts. This old copy has stopped; remove it in chrome://extensions.'
      : `In chrome://extensions, click Load unpacked and choose the su94r-mini folder next to this one. su94r Mini brings over your sign-ins, markers, settings and saved readings by itself, then this copy stops. This copy's ID: ${chrome.runtime.id}.`;
    $('handover-actions').hidden = true;
    return;
  }
  if (migratedFrom?.ok) {
    box.hidden = Date.now() - migratedFrom.at > 7 * 864e5;
    $('handover-title').textContent = 'Moved from Libre Mini Graph';
    $('handover-text').textContent = `Brought over ${migratedFrom.accounts} account${migratedFrom.accounts === 1 ? '' : 's'}, ${migratedFrom.events} marker${migratedFrom.events === 1 ? '' : 's'} and ${migratedFrom.readings.toLocaleString()} saved readings on ${new Date(migratedFrom.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. You can remove the old Libre Mini Graph in chrome://extensions.`;
    $('handover-actions').hidden = true;
    return;
  }
  // Shown until a hand-over happened: once signed in, an old copy may still be running here.
  box.hidden = false;
  if (handoverOffer?.id && !$('old-id').value) $('old-id').value = handoverOffer.id;
  $('handover-title').textContent = handoverOffer ? 'The old Libre Mini Graph is installed here' : 'Used Libre Mini Graph before?';
  $('handover-text').textContent = handoverOffer
    ? `Bring over its sign-ins, markers, settings and saved readings? It then stops, so the two never alert side by side. (Old copy's ID: ${handoverOffer.id})`
    : 'If the old Libre Mini Graph is still installed, su94r Mini can bring over its sign-ins, markers, settings and saved readings. It finds the old copy by itself within a few minutes of the old copy updating; or type the ID shown in the old copy\'s settings.';
  $('handover-actions').hidden = false;
}

$('bring-over').addEventListener('click', async () => {
  say('Looking for the old copy…');
  const id = $('old-id').value.trim();
  const r = await chrome.runtime.sendMessage({ type: 'bringOver', id: /^[a-p]{32}$/.test(id) ? id : undefined });
  if (r?.ok && r.from) say(`Brought over ${r.accounts} account(s), ${r.events} new marker(s) and ${r.readings.toLocaleString()} readings.`, 'ok');
  else say('No old copy answered. Make sure Libre Mini Graph is installed and updated, then try again.', 'error');
  refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => ['accounts', 'events', 'settings', 'syncError', 'syncQueue', 'retired', 'migratedFrom', 'handoverOffer', 'voiceError'].includes(k) || k.startsWith('pt:'))) refresh();
});

watchContext();
refresh();
checkHelper();
