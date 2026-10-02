// Settings: pens, vials and sensors; calendar, heat and sitting heads-ups.
import { withDefaults } from './glucose.js';
import { allPatients, isDemo } from './store.js';
import { PRESETS, DEFAULT_SUPPLIES, penStatus, penLine } from './supplies.js';
import { findPlace, WEATHER_HOSTS } from './weather.js';

const $ = (id) => document.getElementById(id);
const local = chrome.storage.local;
const DAY = 864e5;

async function settings() { return withDefaults((await local.get('settings')).settings); }
async function save(patch) { await local.set({ settings: withDefaults({ ...(await settings()), ...patch }) }); }
const todayInput = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);

// ---- pens, vials and sensors ----

function fillPresets() {
  const sel = $('pen-preset');
  PRESETS.forEach((p, i) => sel.append(new Option(`${p.name} · ${p.units} units · ${p.days} days`, String(i))));
  sel.append(new Option('Something else (type the units and days)', 'custom'));
  const pick = () => {
    const p = PRESETS[Number(sel.value)];
    $('pen-units').value = p ? p.units : '';
    $('pen-days').value = p ? p.days : '';
    $('pen-kind').hidden = Boolean(p);
  };
  sel.addEventListener('change', pick);
  pick();
  $('pen-opened').value = todayInput();
}

// Pens count the doses of the person who uses this computer, chosen on the vault page.
async function owner(s) {
  const people = (await allPatients({ ...s, demo: false })).filter((p) => !isDemo(p.pid));
  return s.vaultOwner && people.some((p) => p.pid === s.vaultOwner) ? s.vaultOwner : null;
}

async function renderPens() {
  const s = await settings();
  const sup = { ...DEFAULT_SUPPLIES, ...(s.supplies || {}) };
  const { events = [] } = await local.get('events');
  const pid = await owner(s);
  const ul = $('pens');
  ul.replaceChildren();
  $('owner-needed').hidden = Boolean(pid);
  for (const pen of sup.pens) {
    const st = penStatus(pen, events, pid);
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${st.status === 'ok' ? '💉' : '⚠️'} ${penLine(st)} Opened ${new Date(pen.openedAt).toLocaleDateString()}.`;
    const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Finished' });
    rm.addEventListener('click', async () => {
      const cur = { ...DEFAULT_SUPPLIES, ...((await settings()).supplies || {}) };
      await save({ supplies: { ...cur, pens: cur.pens.filter((x) => x.id !== pen.id) } });
    });
    li.append(text, rm);
    ul.append(li);
  }
  if (!sup.pens.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No pen or vial added yet.';
    ul.append(li);
  }
  if (document.activeElement !== $('sensors-left')) $('sensors-left').value = Number.isFinite(sup.sensorsLeft) ? sup.sensorsLeft : '';
  if (document.activeElement !== $('reorder-at')) $('reorder-at').value = sup.reorderAt;
}

$('pen-add').addEventListener('click', async () => {
  const preset = PRESETS[Number($('pen-preset').value)];
  const units = Number($('pen-units').value);
  const days = Number($('pen-days').value);
  const opened = $('pen-opened').value ? new Date(`${$('pen-opened').value}T08:00`).getTime() : Date.now();
  if (!(units >= 10) || !(days >= 1)) { $('supplies-msg').textContent = 'Type how many units it holds and how many days it lasts once opened.'; return; }
  if (opened > Date.now() + DAY) { $('supplies-msg').textContent = 'The opening day cannot be in the future.'; return; }
  const kind = preset?.kind || $('pen-kind').value;
  const cur = { ...DEFAULT_SUPPLIES, ...((await settings()).supplies || {}) };
  const pen = { id: crypto.randomUUID(), name: preset?.name || 'Insulin', kind, units, days, openedAt: Math.min(opened, Date.now()) };
  await save({ supplies: { ...cur, pens: [...cur.pens, pen] } });
  $('supplies-msg').textContent = `Added ${pen.name}.`;
});

for (const id of ['sensors-left', 'reorder-at']) {
  $(id).addEventListener('change', async () => {
    const cur = { ...DEFAULT_SUPPLIES, ...((await settings()).supplies || {}) };
    const left = $('sensors-left').value === '' ? null : Math.max(0, Math.round(Number($('sensors-left').value)));
    await save({ supplies: { ...cur, sensorsLeft: left, reorderAt: Math.max(0, Math.round(Number($('reorder-at').value) || 0)) } });
  });
}

// ---- heads-ups ----

async function renderHeads() {
  const s = await settings();
  if (document.activeElement !== $('calendar-url')) $('calendar-url').value = s.calendarUrl || '';
  if (document.activeElement !== $('place')) $('place').value = s.place?.name || '';
  $('heatNote').checked = s.heatNote !== false;
  $('sitNudge').checked = s.sitNudge !== false;
  $('sitMinutes').value = String(s.sitMinutes || 60);
  const { calendarState, weather } = await local.get(['calendarState', 'weather']);
  $('calendar-msg').textContent = !s.calendarUrl ? ''
    : calendarState?.error ? `Could not read the calendar: ${calendarState.error}`
    : calendarState?.at ? `Read ${new Date(calendarState.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${calendarState.upcoming} event(s) in the next 24 hours.` : 'Saved; it is read within 15 minutes.';
  $('place-msg').textContent = s.place ? `Using ${s.place.name}${weather?.at ? `; weather read ${new Date(weather.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.` : '';
}

$('save-calendar').addEventListener('click', async () => {
  const raw = $('calendar-url').value.trim().replace(/^webcal:/i, 'https:');
  if (!raw) { await save({ calendarUrl: '' }); await local.remove('calendarState'); $('calendar-msg').textContent = 'Calendar heads-ups are off.'; return; }
  let u;
  try { u = new URL(raw); } catch { $('calendar-msg').textContent = 'That does not look like a link.'; return; }
  if (u.protocol !== 'https:') { $('calendar-msg').textContent = 'The link has to start with https://.'; return; }
  const ok = await chrome.permissions.request({ origins: [`${u.origin}/*`] }).catch(() => false);
  if (!ok) { $('calendar-msg').textContent = 'su94r Mini needs permission to read that calendar.'; return; }
  await save({ calendarUrl: u.href });
  chrome.runtime.sendMessage({ type: 'calendarNow' }).catch(() => {});
  $('calendar-msg').textContent = 'Saved. Reading it…';
});

$('save-place').addEventListener('click', async () => {
  const q = $('place').value.trim();
  if (!q) { await save({ place: null }); await local.remove('weather'); $('place-msg').textContent = 'Heat notes are off.'; return; }
  const ok = await chrome.permissions.request({ origins: WEATHER_HOSTS }).catch(() => false);
  if (!ok) { $('place-msg').textContent = 'su94r Mini needs permission to reach the weather service.'; return; }
  $('place-msg').textContent = 'Looking it up…';
  try {
    const place = await findPlace(q);
    if (!place) { $('place-msg').textContent = 'No place by that name. Try "City, State".'; return; }
    await save({ place });
    chrome.runtime.sendMessage({ type: 'weatherNow' }).catch(() => {});
    $('place-msg').textContent = `Using ${place.name}.`;
  } catch (e) {
    $('place-msg').textContent = e.message;
  }
});

$('heatNote').addEventListener('change', (e) => save({ heatNote: e.target.checked }));
$('sitNudge').addEventListener('change', (e) => save({ sitNudge: e.target.checked }));
$('sitMinutes').addEventListener('change', (e) => save({ sitMinutes: Number(e.target.value) }));

fillPresets();
renderPens();
renderHeads();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings || changes.events) renderPens();
  if (changes.settings || changes.calendarState || changes.weather) renderHeads();
});
