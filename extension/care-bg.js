// Everyday heads-ups, run by the background worker every few minutes: pens and sensors
// running out, a meeting coming up while you're low or falling, a hot day, and a long stretch
// at the computer while running high. Each notice is shown once (per pen, event or day).
// Notification ids start with "care|"; clicking one opens the right page.

import { withDefaults, displayUnits, fmtGlucose } from './glucose.js';
import { allPatients, ptKey, learnedKey, isDemo } from './store.js';
import { supplyWarnings, sensorUsed, DEFAULT_SUPPLIES } from './supplies.js';
import { parseIcs, headsUp } from './calendar.js';
import { hourlyTemps, heatNote } from './weather.js';
import { trendSlope, forecast, trustworthy } from './learner.js';

const local = chrome.storage.local;
const MIN = 60e3;

async function getSettings() { return withDefaults((await local.get('settings')).settings); }

/**
 * The person who uses this computer (chosen on the vault page): their pens, calendar and
 * readings drive these heads-ups. Nobody until chosen, so one person's pens or meetings are
 * never matched to someone else's glucose.
 */
async function ownerOf(settings) {
  if (!settings.vaultOwner) return null;
  const people = (await allPatients({ ...settings, demo: false })).filter((p) => !isDemo(p.pid));
  return people.find((p) => p.pid === settings.vaultOwner) || null;
}

/** Shows a notice unless the same id was shown in the last `everyMs`. */
async function noticeOnce(id, title, message, everyMs = 12 * 3600e3) {
  const { careSeen = {} } = await local.get('careSeen');
  if (careSeen[id] && Date.now() - careSeen[id] < everyMs) return false;
  await chrome.notifications.create(`care|${id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 });
  const fresh = Object.fromEntries(Object.entries(careSeen).filter(([, t]) => Date.now() - t < 7 * 864e5));
  await local.set({ careSeen: { ...fresh, [id]: Date.now() } });
  return true;
}

/** What to open when a care notice is clicked. */
export function careClicked(nid) {
  if (!nid.startsWith('care|')) return false;
  chrome.notifications.clear(nid);
  const kind = nid.split('|')[1];
  chrome.tabs.create({ url: chrome.runtime.getURL(kind === 'pen' || kind === 'sensors' ? 'options.html#supplies-panel' : 'vault.html') });
  return true;
}

// ---- pens and sensors ----

async function checkSupplies(settings, person, events) {
  if (!person) return;
  let sup = { ...DEFAULT_SUPPLIES, ...(settings.supplies || {}) };
  // A new sensor went on: one fewer spare at home.
  const start = person?.sensor?.start;
  if (start && sup.lastSensorStart && start > sup.lastSensorStart && Number.isFinite(sup.sensorsLeft)) sup = sensorUsed(sup);
  if (start && start !== sup.lastSensorStart) {
    const { settings: raw } = await local.get('settings');
    await local.set({ settings: withDefaults({ ...raw, supplies: { ...sup, lastSensorStart: start } }) });
  }
  for (const w of supplyWarnings(sup, events, person?.pid)) {
    await noticeOnce(w.id, w.kind === 'pen' ? 'Insulin pen or vial' : 'Sensors', w.text, w.status === 'now' ? 6 * 3600e3 : 24 * 3600e3);
  }
}

// ---- calendar ----

async function checkCalendar(settings, person, events) {
  if (!settings.calendarUrl || !person) return;
  const { calendarCache } = await local.get('calendarCache');
  let list = calendarCache?.url === settings.calendarUrl && Date.now() - calendarCache.at < 15 * MIN ? calendarCache.events : null;
  if (!list) {
    try {
      const r = await fetch(settings.calendarUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`the calendar answered ${r.status}`);
      const text = await r.text();
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('that link is not an iCal calendar');
      list = parseIcs(text, Date.now() - 3600e3, Date.now() + 24 * 3600e3);
      await local.set({ calendarCache: { url: settings.calendarUrl, at: Date.now(), events: list }, calendarState: { at: Date.now(), upcoming: list.filter((e) => !e.allDay).length, error: null } });
    } catch (e) {
      await local.set({ calendarState: { at: Date.now(), error: e.message } });
      return;
    }
  }
  const pt = (await local.get(ptKey(person.pid)))[ptKey(person.pid)];
  const latest = pt?.latest;
  if (!latest) return;
  // The trend always ends at the latest reading itself (it replaces a stored point of the same minute).
  const points = [...[...(pt.hist || []), ...(pt.live || [])].map(([t, mg]) => ({ t, mg })).filter((p) => p.t > latest.t - 40 * MIN && Math.abs(p.t - latest.t) >= 30e3), { t: latest.t, mg: latest.mg }].sort((a, b) => a.t - b.t);
  const slope = trendSlope(points, latest);
  const model = (await local.get(learnedKey(person.pid)))[learnedKey(person.pid)];
  const units = displayUnits(settings, pt);
  const low = settings.alerts?.low ?? 70;
  for (const ev of list) {
    let estimateAtStart = null;
    if (trustworthy(model) && ev.start > latest.t) {
      const f = forecast(points, events, person.pid, model, { latest, horizonMin: Math.min(120, Math.ceil((ev.start - latest.t) / MIN / 5) * 5), stepMin: 5 });
      estimateAtStart = f?.points[f.points.length - 1]?.mg ?? null;
    }
    const h = headsUp(ev, latest, { slope, estimateAtStart, low, fmt: (v) => fmtGlucose(v, units) });
    if (h) await noticeOnce(`cal|${ev.uid}|${ev.start}`, h.level === 'high' ? 'Coming up, and you\'re high' : 'Coming up, and you\'re low', h.text, 24 * 3600e3);
  }
}

// ---- heat ----

async function checkWeather(settings) {
  if (!settings.place) return;
  const { weather } = await local.get('weather');
  let temps = weather?.place?.lat === settings.place.lat && Date.now() - weather.at < 3 * 3600e3 ? weather.temps : null;
  if (!temps) {
    try {
      temps = await hourlyTemps(settings.place, { pastDays: 30 });
      await local.set({ weather: { place: settings.place, at: Date.now(), temps } });
    } catch { return; }
  }
  if (settings.heatNote === false) return;
  const hour = new Date().getHours();
  if (hour < 7 || hour > 14) return;   // a morning-to-midday note, not at night
  const note = heatNote(temps, { us: (navigator.language || '').toLowerCase() === 'en-us' });
  if (note) await noticeOnce(note.id, 'Hot day', note.text, 20 * 3600e3);
}

// ---- sitting ----

async function checkSitting(settings, person) {
  if (settings.sitNudge === false || !person || !chrome.idle) return;
  const state = await chrome.idle.queryState(5 * 60);
  const { sitting = {} } = await local.get('sitting');
  const now = Date.now();
  // Active since: reset after 5 minutes away from the keyboard and mouse.
  const since = state === 'active' ? (sitting.since && now - (sitting.seen || 0) < 10 * MIN ? sitting.since : now) : null;
  await local.set({ sitting: { ...sitting, since, seen: now } });
  if (!since || now - since < (settings.sitMinutes || 60) * MIN) return;
  if (sitting.nudged && now - sitting.nudged < 90 * MIN) return;
  const pt = (await local.get(ptKey(person.pid)))[ptKey(person.pid)];
  const l = pt?.latest;
  const high = settings.alerts?.high ?? 240;
  if (!l || now - l.t > 15 * MIN || l.mg < Math.min(high, 180) || (l.trend != null && l.trend < 3)) return;
  const model = (await local.get(learnedKey(person.pid)))[learnedKey(person.pid)];
  const units = displayUnits(settings, pt);
  const ex = model?.effects?.exercise, st = model?.effects?.steps;
  const effect = ex?.learned ? 10 * ex.size : st?.learned && st.size > st.sd ? st.size : null;
  const mins = Math.round((now - since) / MIN);
  const text = `About ${mins} minutes at the computer and you're ${fmtGlucose(l.mg, units)}.`
    + (effect && effect > 2 ? ` A 10-minute walk has lowered you about ${fmtGlucose(effect, units)} before.` : ' A short walk often helps bring it down.');
  if (await noticeOnce(`sit|${Math.floor(now / (90 * MIN))}`, 'Time for a short walk?', text, 90 * MIN)) {
    await local.set({ sitting: { since, seen: now, nudged: now } });
  }
}

/** Runs every heads-up check; each is independent and never throws. */
export async function careTick() {
  const settings = await getSettings();
  if (settings.demo) return;
  const person = await ownerOf(settings);
  const { events = [] } = await local.get('events');
  const errors = {};
  const jobs = { supplies: () => checkSupplies(settings, person, events), calendar: () => checkCalendar(settings, person, events), weather: () => checkWeather(settings), sitting: () => checkSitting(settings, person) };
  for (const [name, job] of Object.entries(jobs)) {
    // One heads-up failing never stops the others; the reason is kept for Settings.
    try { await job(); } catch (e) { errors[name] = String(e?.message || e); }
  }
  await local.set({ careErrors: { at: Date.now(), ...errors } });
}

/** Fresh calendar or weather now (after Settings saves a link or a place). */
export async function careRefresh(what) {
  if (what === 'calendar') await local.remove('calendarCache');
  if (what === 'weather') await local.remove('weather');
  return careTick();
}
