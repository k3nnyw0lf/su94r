// The health vault: everything other devices and apps measure, kept on this computer next to
// the glucose readings. A watch's workouts, heart rate, steps and sleep; a scale's weight; a
// cuff's blood pressure; fingersticks, ketones, lab A1c; anything typed in by hand.
//
// Samples: { type, t, end?, value, unit, src, device?, note? }
//   type   one of TYPES (names match the su94r server's health_samples, Apple Health style)
//   t      when it was measured (ms); `end` for spans such as a workout, sleep or a step count
//   value  in the type's canonical unit (TYPES[type].unit); converted on the way in
//   src    where it came from: 'manual', 'google-health', 'health-connect', 'withings', ...
// One sample per (type, t, src): the same reading sent twice is stored once.
//
// A separate IndexedDB database from the glucose archive, so neither can break the other.
// Pure helpers at the bottom are shared with the vault page and the tests.

const DB_NAME = 'su94r-vault';
const STORE = 'samples';
let dbPromise = null;

// Canonical unit, how it is shown, and how values from a day are combined.
export const TYPES = {
  bodyMass: { label: 'Weight', unit: 'kg', icon: '⚖️', group: 'body', combine: 'last', manual: true },
  bodyFatPercentage: { label: 'Body fat', unit: '%', icon: '⚖️', group: 'body', combine: 'last', manual: true },
  muscleMass: { label: 'Muscle mass', unit: 'kg', icon: '💪', group: 'body', combine: 'last' },
  boneMass: { label: 'Bone mass', unit: 'kg', icon: '🦴', group: 'body', combine: 'last' },
  bodyWater: { label: 'Body water', unit: '%', icon: '💧', group: 'body', combine: 'last' },
  visceralFat: { label: 'Visceral fat', unit: 'level', icon: '⚖️', group: 'body', combine: 'last' },
  bmi: { label: 'BMI', unit: '', icon: '⚖️', group: 'body', combine: 'last' },
  basalMetabolicRate: { label: 'Resting energy', unit: 'kcal/day', icon: '🔥', group: 'body', combine: 'last' },
  bloodPressureSystolic: { label: 'Blood pressure (top)', unit: 'mmHg', icon: '🩺', group: 'heart', combine: 'avg', manual: true },
  bloodPressureDiastolic: { label: 'Blood pressure (bottom)', unit: 'mmHg', icon: '🩺', group: 'heart', combine: 'avg' },
  heartRate: { label: 'Heart rate', unit: 'bpm', icon: '❤️', group: 'heart', combine: 'avg', manual: true },
  restingHeartRate: { label: 'Resting heart rate', unit: 'bpm', icon: '❤️', group: 'heart', combine: 'avg' },
  heartRateVariability: { label: 'Heart rate variability', unit: 'ms', icon: '❤️', group: 'heart', combine: 'avg' },
  oxygenSaturation: { label: 'Blood oxygen', unit: '%', icon: '🫁', group: 'heart', combine: 'avg', manual: true },
  respiratoryRate: { label: 'Breathing rate', unit: '/min', icon: '🫁', group: 'heart', combine: 'avg' },
  vo2Max: { label: 'Cardio fitness (VO₂ max)', unit: 'mL/kg/min', icon: '🏃', group: 'activity', combine: 'last' },
  steps: { label: 'Steps', unit: 'steps', icon: '👟', group: 'activity', combine: 'sum' },
  distance: { label: 'Distance', unit: 'km', icon: '👟', group: 'activity', combine: 'sum' },
  floors: { label: 'Floors climbed', unit: 'floors', icon: '🪜', group: 'activity', combine: 'sum' },
  activeEnergy: { label: 'Active calories', unit: 'kcal', icon: '🔥', group: 'activity', combine: 'sum' },
  basalEnergy: { label: 'Resting calories', unit: 'kcal', icon: '🔥', group: 'activity', combine: 'sum' },
  exerciseMinutes: { label: 'Active minutes', unit: 'min', icon: '🏃', group: 'activity', combine: 'sum' },
  workout: { label: 'Workout', unit: 'min', icon: '🏋️', group: 'activity', combine: 'sum', span: true },
  sedentaryMinutes: { label: 'Time sitting', unit: 'min', icon: '🪑', group: 'activity', combine: 'sum' },
  standHours: { label: 'Stand hours', unit: 'h', icon: '🧍', group: 'activity', combine: 'sum' },
  sleepAnalysis: { label: 'Sleep', unit: 'min', icon: '😴', group: 'sleep', combine: 'sum', span: true, manual: true },
  bodyTemperature: { label: 'Body temperature', unit: '°C', icon: '🌡️', group: 'body', combine: 'avg', manual: true },
  bloodGlucose: { label: 'Fingerstick glucose', unit: 'mg/dL', icon: '🩸', group: 'diabetes', combine: 'avg', manual: true },
  ketones: { label: 'Ketones', unit: 'mmol/L', icon: '🧪', group: 'diabetes', combine: 'avg', manual: true },
  a1c: { label: 'A1c (lab)', unit: '%', icon: '🧪', group: 'diabetes', combine: 'last', manual: true },
  hydration: { label: 'Water', unit: 'mL', icon: '💧', group: 'food', combine: 'sum', manual: true },
  dietaryCarbs: { label: 'Carbs eaten (food app)', unit: 'g', icon: '🍽️', group: 'food', combine: 'sum' },
  dietaryEnergy: { label: 'Calories eaten', unit: 'kcal', icon: '🍽️', group: 'food', combine: 'sum' },
  mindfulMinutes: { label: 'Mindful minutes', unit: 'min', icon: '🧘', group: 'sleep', combine: 'sum' },
};

export const GROUP_LABELS = { body: 'Body', heart: 'Heart and breathing', activity: 'Activity', sleep: 'Sleep and rest', diabetes: 'Diabetes', food: 'Food and water' };

// Units arriving from other systems, converted to the canonical unit.
const CONVERT = {
  lb: (v) => ({ value: v * 0.45359237, unit: 'kg' }),
  lbs: (v) => ({ value: v * 0.45359237, unit: 'kg' }),
  g: (v, type) => (type === 'dietaryCarbs' ? { value: v, unit: 'g' } : { value: v / 1000, unit: 'kg' }),
  '°F': (v) => ({ value: ((v - 32) * 5) / 9, unit: '°C' }),
  degF: (v) => ({ value: ((v - 32) * 5) / 9, unit: '°C' }),
  'mmol/L': (v, type) => (type === 'bloodGlucose' ? { value: v * 18.016, unit: 'mg/dL' } : { value: v, unit: 'mmol/L' }),
  mi: (v) => ({ value: v * 1.609344, unit: 'km' }),
  m: (v, type) => (type === 'distance' ? { value: v / 1000, unit: 'km' } : { value: v, unit: 'm' }),
  'fl oz': (v) => ({ value: v * 29.5735, unit: 'mL' }),
  L: (v) => ({ value: v * 1000, unit: 'mL' }),
  h: (v, type) => (TYPES[type]?.unit === 'min' ? { value: v * 60, unit: 'min' } : { value: v, unit: 'h' }),
  s: (v, type) => (TYPES[type]?.unit === 'min' ? { value: v / 60, unit: 'min' } : { value: v, unit: 's' }),
  kJ: (v) => ({ value: v / 4.184, unit: 'kcal' }),
  fraction: (v) => ({ value: v * 100, unit: '%' }),
  bpm: (v, type) => ({ value: v, unit: TYPES[type]?.unit === '/min' ? '/min' : 'bpm' }),
};

// Other systems' spellings of units → the spelling used here. A unit that is given but is
// neither the type's own nor convertible is refused, never stored as if it were (so "25 mmol/l"
// can never become a 25 mg/dL fingerstick).
const UNIT_ALIAS = {
  'mg/dl': 'mg/dL', 'mmol/l': 'mmol/L', kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', g: 'g', gram: 'g', grams: 'g',
  '°c': '°C', degc: '°C', celsius: '°C', '°f': '°F', degf: '°F', fahrenheit: '°F',
  'count/min': 'bpm', bpm: 'bpm', 'beats/min': 'bpm', '/min': '/min', 'breaths/min': '/min',
  count: 'COUNT', steps: 'COUNT', floors: 'COUNT', level: 'COUNT', '%': '%', percent: '%',
  km: 'km', mi: 'mi', miles: 'mi', m: 'm', meters: 'm', ml: 'mL', l: 'L', 'fl oz': 'fl oz', fl_oz_us: 'fl oz', floz: 'fl oz',
  kcal: 'kcal', kj: 'kJ', 'kcal/day': 'kcal/day', min: 'min', minutes: 'min', h: 'h', hr: 'h', hours: 'h',
  s: 's', sec: 's', seconds: 's', ms: 'ms', mmhg: 'mmHg', 'ml/kg/min': 'mL/kg/min', fraction: 'fraction',
};

/** The unit a raw sample says, in our spelling; the type's own when none is given; null if unknown. */
function unitOf(raw, type) {
  const want = TYPES[type].unit;
  if (raw == null || raw === '') return want;
  let u = String(raw).trim();
  if (/^mmol<[\d.]+>\/l$/i.test(u)) u = 'mmol/L';   // HealthKit writes mmol<180.155…>/L
  const a = UNIT_ALIAS[u.toLowerCase()] ?? u;
  if (a === 'COUNT') return ['steps', 'floors', '', 'h', 'level'].includes(want) ? want : null;
  return a;
}

// Values outside these are a broken reading or a unit mix-up, not a measurement.
const LIMITS = {
  bodyMass: [20, 400], bodyFatPercentage: [2, 75], heartRate: [25, 240], restingHeartRate: [25, 150],
  bloodPressureSystolic: [60, 260], bloodPressureDiastolic: [30, 160], oxygenSaturation: [50, 100],
  bodyTemperature: [30, 44], bloodGlucose: [20, 600], ketones: [0, 10], a1c: [3, 20], steps: [0, 100000],
  sleepAnalysis: [0, 24 * 60], workout: [0, 24 * 60],
};

/**
 * One incoming sample, cleaned: canonical unit, plausible value, sane time. null if unusable,
 * so one bad row never fails a whole batch.
 */
export function normalize(raw, now = Date.now()) {
  if (!raw || !TYPES[raw.type]) return null;
  let value = Number(raw.value);
  const t = typeof raw.t === 'number' ? raw.t : Date.parse(raw.t ?? raw.timestamp ?? raw.start);
  if (!Number.isFinite(value) || !Number.isFinite(t) || t > now + 6 * 3600e3 || t < Date.UTC(2000, 0, 1)) return null;
  const want = TYPES[raw.type].unit;
  let unit = unitOf(raw.unit, raw.type);
  if (unit == null) return null;
  if (unit !== want) {
    if (!CONVERT[unit]) return null;
    ({ value, unit } = CONVERT[unit](value, raw.type));
    if (unit !== want) return null;
  }
  const endRaw = raw.end ?? raw.endTime;
  const end = endRaw == null ? null : typeof endRaw === 'number' ? endRaw : Date.parse(endRaw);
  // A span given only by its end: its length is the value, in minutes.
  if (TYPES[raw.type].span && !(value > 0) && end > t) value = (end - t) / 60e3;
  const [lo, hi] = LIMITS[raw.type] || [-Infinity, Infinity];
  if (value < lo || value > hi) return null;
  const out = { type: raw.type, t: Math.round(t), value: Math.round(value * 1000) / 1000, unit: TYPES[raw.type].unit, src: String(raw.src || raw.source || 'manual').slice(0, 40) };
  if (Number.isFinite(end) && end > t && end - t <= 36 * 3600e3) out.end = Math.round(end);
  if (raw.device) out.device = String(raw.device).slice(0, 60);
  if (raw.note) out.note = String(raw.note).slice(0, 200);
  if (raw.activity) out.activity = String(raw.activity).slice(0, 40);
  if (raw.stage) out.stage = String(raw.stage).slice(0, 20);
  return out;
}

function openDb() {
  dbPromise ??= openOnce().catch((e) => { dbPromise = null; throw e; });   // a failed open is retried next time
  return dbPromise;
}

function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: ['type', 't', 'src'] });
      s.createIndex('t', 't');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The oldest sample in the vault (for the first Drive save), or null. */
export async function firstSample() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).index('t').openCursor();
  let first = null;
  req.onsuccess = () => { first = req.result?.value || null; };
  await done(tx);
  return first;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

/** Stores samples (cleaned first). A later copy of the same sample replaces the earlier one. Returns how many were new. */
export async function putSamples(raw) {
  const rows = (raw || []).map((r) => normalize(r)).filter(Boolean);
  if (!rows.length) return { added: 0, stored: 0, rejected: (raw || []).length };
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let added = 0;
  for (const r of rows) {
    const get = store.getKey([r.type, r.t, r.src]);
    get.onsuccess = () => { if (get.result === undefined) added++; store.put(r); };
  }
  await done(tx);
  return { added, stored: rows.length, rejected: raw.length - rows.length };
}

/** Samples between `from` and `to`, optionally only some types, oldest first. */
export async function getSamples({ from = 0, to = Date.now() + 864e5, types = null } = {}) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).index('t').getAll(IDBKeyRange.bound(from, to));
  await done(tx);
  const want = types ? new Set(types) : null;
  return req.result.filter((s) => !want || want.has(s.type));
}

/** Deletes samples by their key fields. */
export async function removeSamples(samples) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  for (const s of samples) tx.objectStore(STORE).delete([s.type, s.t, s.src]);
  await done(tx);
}

/** Every sample (for backups). */
export const allSamples = () => getSamples({ from: 0, to: Infinity });

export async function clearVault() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}

// ---- pure helpers ----

/** Per type: how many samples, the newest one, and which sources sent them. */
export function summarize(samples) {
  const out = {};
  for (const s of samples) {
    const o = (out[s.type] ??= { type: s.type, count: 0, latest: null, sources: new Set() });
    o.count++;
    o.sources.add(s.src);
    if (!o.latest || s.t > o.latest.t) o.latest = s;
  }
  return Object.values(out).map((o) => ({ ...o, sources: [...o.sources] }));
}

/**
 * One source per type and day for totals and spans. A Pixel Watch sends the same steps and
 * workouts to Google Health and to Health Connect; adding both would count them twice. For
 * each day the source with the biggest total is kept (as Apple Health picks one source);
 * readings typed by hand always count. Single readings (heart rate, weight) are left alone.
 */
export function preferOneSource(samples, dayOf = (t) => new Date(t).toLocaleDateString('en-CA')) {
  const totals = new Map();
  const counts = (s) => TYPES[s.type]?.combine === 'sum' || TYPES[s.type]?.span;
  // A source is the route plus the device: a phone and a watch both on Health Connect differ.
  const origin = (s) => `${s.src}|${s.device || ''}`;
  for (const s of samples) {
    if (!counts(s) || s.src === 'manual') continue;
    const k = `${s.type}|${dayOf(s.t)}`;
    const bySrc = totals.get(k) || new Map();
    bySrc.set(origin(s), (bySrc.get(origin(s)) || 0) + s.value);
    totals.set(k, bySrc);
  }
  const pick = new Map([...totals].map(([k, bySrc]) => [k, [...bySrc].sort((a, b) => b[1] - a[1])[0][0]]));
  return samples.filter((s) => !counts(s) || s.src === 'manual' || pick.get(`${s.type}|${dayOf(s.t)}`) === origin(s));
}

/** Day totals or averages per type ({ day: 'YYYY-MM-DD', value }), the way each type is combined. */
export function daily(samples, type, dayOf = (t) => new Date(t).toLocaleDateString('en-CA')) {
  const how = TYPES[type]?.combine || 'avg';
  const days = new Map();
  for (const s of preferOneSource(samples.filter((x) => x.type === type), dayOf).sort((a, b) => a.t - b.t)) {
    const d = dayOf(s.t);
    const o = days.get(d) || { day: d, sum: 0, n: 0, last: null };
    o.sum += s.value; o.n++; o.last = s.value;
    days.set(d, o);
  }
  return [...days.values()].map((o) => ({ day: o.day, value: how === 'sum' ? o.sum : how === 'last' ? o.last : o.sum / o.n }));
}

/** Shows a canonical value in the person's preferred units (US: pounds, °F, miles). */
export function showValue(type, value, { us = false, glucoseUnits = 'mg/dL' } = {}) {
  const t = TYPES[type];
  if (!t) return String(value);
  const r = (v, d = 0) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
  if (type === 'bloodGlucose' && glucoseUnits === 'mmol/L') return `${(value / 18.016).toFixed(1)} mmol/L`;
  if (type === 'bodyMass' || type === 'muscleMass' || type === 'boneMass') return us ? `${r(value / 0.45359237, 1)} lb` : `${r(value, 1)} kg`;
  if (type === 'bodyTemperature') return us ? `${r((value * 9) / 5 + 32, 1)} °F` : `${r(value, 1)} °C`;
  if (type === 'distance') return us ? `${r(value / 1.609344, 2)} mi` : `${r(value, 2)} km`;
  if (type === 'sleepAnalysis' || type === 'workout') return value >= 60 ? `${Math.floor(value / 60)} h ${Math.round(value % 60)} min` : `${Math.round(value)} min`;
  if (type === 'hydration') return us ? `${r(value / 29.5735, 0)} fl oz` : `${r(value)} mL`;
  const digits = ['ketones', 'a1c', 'bodyFatPercentage', 'bmi'].includes(type) ? 1 : 0;
  return `${r(value, digits)}${t.unit && !['', 'steps', 'floors'].includes(t.unit) ? ` ${t.unit}` : ` ${t.unit}`}`.trim();
}
