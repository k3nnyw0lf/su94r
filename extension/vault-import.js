// Reads health files into vault samples. Pure: text in, samples out (vault.normalize cleans
// them on the way into the vault). Formats:
//   • su94r Drive month files (su94r-YYYY-MM.json): health samples, plus readings and markers
//   • CSV, long:  type,time,value,unit[,end,src,note]      (one reading per row)
//   • CSV, wide:  date,bodyMass,heartRate,...              (one column per type)
//   • Health Auto Export (iPhone) JSON: { data: { metrics: [...], workouts: [...] } }
//   • HC Webhook (Android/iPhone app): { timestamp, app_version, steps: [...], heart_rate: [...] }
//   • Health Connect exports and webhooks: { steps: [...], heartRate: [...], ... } records
//   • a plain JSON list of samples: [{ type, t | timestamp, value, unit }]

import { TYPES } from './vault.js';

// Health Auto Export metric names → vault types.
const HAE = {
  step_count: 'steps', heart_rate: 'heartRate', resting_heart_rate: 'restingHeartRate',
  heart_rate_variability: 'heartRateVariability', weight_body_mass: 'bodyMass', body_mass: 'bodyMass',
  body_fat_percentage: 'bodyFatPercentage', lean_body_mass: 'muscleMass', body_mass_index: 'bmi',
  blood_oxygen_saturation: 'oxygenSaturation', respiratory_rate: 'respiratoryRate',
  active_energy: 'activeEnergy', basal_energy_burned: 'basalEnergy', apple_exercise_time: 'exerciseMinutes',
  apple_stand_hour: 'standHours', walking_running_distance: 'distance', flights_climbed: 'floors',
  vo2_max: 'vo2Max', blood_glucose: 'bloodGlucose', body_temperature: 'bodyTemperature',
  dietary_water: 'hydration', carbohydrates: 'dietaryCarbs', dietary_energy: 'dietaryEnergy',
  mindful_minutes: 'mindfulMinutes',
};

// Health Connect record names (Android) → vault types, and where the number sits.
const HC = {
  StepsRecord: ['steps', (r) => r.count], steps: ['steps', (r) => r.count ?? r.value],
  HeartRateRecord: ['heartRate', null], heartRate: ['heartRate', null],
  RestingHeartRateRecord: ['restingHeartRate', (r) => r.beatsPerMinute], restingHeartRate: ['restingHeartRate', (r) => r.beatsPerMinute ?? r.value],
  HeartRateVariabilityRmssdRecord: ['heartRateVariability', (r) => r.heartRateVariabilityMillis],
  WeightRecord: ['bodyMass', (r) => r.weight?.inKilograms ?? r.weight?.kilograms ?? r.weight], weight: ['bodyMass', (r) => r.weight?.inKilograms ?? r.weight ?? r.value],
  BodyFatRecord: ['bodyFatPercentage', (r) => r.percentage?.value ?? r.percentage], bodyFat: ['bodyFatPercentage', (r) => r.percentage ?? r.value],
  BloodPressureRecord: ['bloodPressure', null], bloodPressure: ['bloodPressure', null],
  OxygenSaturationRecord: ['oxygenSaturation', (r) => r.percentage?.value ?? r.percentage], oxygenSaturation: ['oxygenSaturation', (r) => r.percentage ?? r.value],
  RespiratoryRateRecord: ['respiratoryRate', (r) => r.rate],
  ActiveCaloriesBurnedRecord: ['activeEnergy', (r) => r.energy?.inKilocalories ?? r.energy], activeCaloriesBurned: ['activeEnergy', (r) => r.energy ?? r.value],
  DistanceRecord: ['distance', (r) => (r.distance?.inMeters ?? r.distance) / 1000], distance: ['distance', (r) => (r.distance ?? r.value) / 1000],
  FloorsClimbedRecord: ['floors', (r) => r.floors],
  ExerciseSessionRecord: ['workout', null], exercise: ['workout', null], ExerciseSession: ['workout', null],
  SleepSessionRecord: ['sleepAnalysis', null], sleep: ['sleepAnalysis', null], SleepSession: ['sleepAnalysis', null],
  BloodGlucoseRecord: ['bloodGlucose', (r) => r.level?.inMilligramsPerDeciliter ?? r.level], bloodGlucose: ['bloodGlucose', (r) => r.level ?? r.value],
  BodyTemperatureRecord: ['bodyTemperature', (r) => r.temperature?.inCelsius ?? r.temperature],
  HydrationRecord: ['hydration', (r) => (r.volume?.inLiters ?? r.volume) * 1000],
  NutritionRecord: ['dietaryCarbs', (r) => r.totalCarbohydrate?.inGrams ?? r.totalCarbohydrate],
  Vo2MaxRecord: ['vo2Max', (r) => r.vo2MillilitersPerMinuteKilogram],
};

// HC Webhook (github.com/mcnaveen/health-connect-webhook) arrays → vault samples.
const HCW = {
  steps: (r) => [{ type: 'steps', t: r.start_time, end: r.end_time, value: r.count }],
  heart_rate: (r) => [{ type: 'heartRate', t: r.time, value: r.avg ?? r.bpm }],
  heart_rate_variability: (r) => [{ type: 'heartRateVariability', t: r.time, value: r.avg ?? r.rmssd_millis }],
  resting_heart_rate: (r) => [{ type: 'restingHeartRate', t: r.time, value: r.bpm }],
  distance: (r) => [{ type: 'distance', t: r.start_time, end: r.end_time, value: r.meters, unit: 'm' }],
  active_calories: (r) => [{ type: 'activeEnergy', t: r.start_time, end: r.end_time, value: r.calories, unit: 'kcal' }],
  weight: (r) => [{ type: 'bodyMass', t: r.time, value: r.kilograms, unit: 'kg' }],
  blood_pressure: (r) => [{ type: 'bloodPressureSystolic', t: r.time, value: r.systolic }, { type: 'bloodPressureDiastolic', t: r.time, value: r.diastolic }],
  blood_glucose: (r) => [{ type: 'bloodGlucose', t: r.time, value: r.mmol_per_liter, unit: 'mmol/L' }],
  oxygen_saturation: (r) => [{ type: 'oxygenSaturation', t: r.time, value: r.avg ?? r.percentage }],
  body_temperature: (r) => [{ type: 'bodyTemperature', t: r.time, value: r.celsius, unit: '°C' }],
  respiratory_rate: (r) => [{ type: 'respiratoryRate', t: r.time, value: r.avg ?? r.rate }],
  hydration: (r) => [{ type: 'hydration', t: r.start_time, end: r.end_time, value: r.liters, unit: 'L' }],
  nutrition: (r) => [
    ...(r.calories != null ? [{ type: 'dietaryEnergy', t: r.start_time, value: r.calories, unit: 'kcal', note: r.name }] : []),
    ...(r.carbs_grams != null ? [{ type: 'dietaryCarbs', t: r.start_time, value: r.carbs_grams, unit: 'g', note: r.name }] : []),
  ],
  basal_metabolic_rate: (r) => [{ type: 'basalMetabolicRate', t: r.time, value: r.watts * 20.65, unit: 'kcal/day' }],
  body_fat: (r) => [{ type: 'bodyFatPercentage', t: r.time, value: r.percentage }],
  bone_mass: (r) => [{ type: 'boneMass', t: r.time, value: r.kilograms, unit: 'kg' }],
  vo2_max: (r) => [{ type: 'vo2Max', t: r.time, value: r.ml_per_kg_per_min }],
  exercise: (r) => [{
    type: 'workout', t: r.start_time, end: r.end_time, value: r.duration_seconds ? r.duration_seconds / 60 : 0, unit: 'min', activity: r.type,
    note: [r.distance_meters ? `${(r.distance_meters / 1000).toFixed(2)} km` : '', r.steps ? `${r.steps} steps` : ''].filter(Boolean).join(', ') || undefined,
  }],
  sleep: (r) => {
    const end = Date.parse(r.session_end_time ?? r.end_time);
    const start = r.start_time ? Date.parse(r.start_time) : r.session_start_time ? Date.parse(r.session_start_time) : end - (r.duration_seconds || 0) * 1000;
    const awake = (r.stages || []).filter((s) => /awake|out_of_bed/i.test(String(s.stage))).reduce((a, s) => a + (s.duration_seconds || 0), 0);
    const asleep = ((end - start) / 1000 - awake) / 60;
    return [{ type: 'sleepAnalysis', t: start, end, value: asleep, unit: 'min' }];
  },
};

/** An HC Webhook payload → vault samples. */
export function fromHcWebhook(obj, src = 'health-connect') {
  const out = [];
  for (const [key, map] of Object.entries(HCW)) {
    for (const r of Array.isArray(obj[key]) ? obj[key] : []) for (const s of map(r)) out.push({ unit: undefined, ...s, src });
  }
  return out.map((s) => (s.unit === undefined ? (({ unit, ...rest }) => rest)(s) : s));
}
const isHcWebhook = (obj) => obj && typeof obj === 'object' && !Array.isArray(obj) && ('app_version' in obj || Object.keys(obj).some((k) => k in HCW && Array.isArray(obj[k]) && obj[k][0] && ('start_time' in obj[k][0] || 'time' in obj[k][0] || 'session_end_time' in obj[k][0])));

const timeOf = (r) => r.time ?? r.startTime ?? r.start ?? r.date ?? r.timestamp;
const endOf = (r) => r.endTime ?? r.end ?? null;

/** Health Connect style records ({ RecordName: [records] } or [{ recordType, ... }]). */
function fromHealthConnect(obj, src = 'health-connect') {
  const out = [];
  const add = (name, records) => {
    const spec = HC[name];
    if (!spec || !Array.isArray(records)) return;
    const [type, value] = spec;
    for (const r of records) {
      const t = timeOf(r), end = endOf(r);
      const device = r.metadata?.device?.model || r.metadata?.dataOrigin || r.dataOrigin || r.app || undefined;
      if (type === 'heartRate') {
        const samples = r.samples || r.heartRateSamples;
        if (Array.isArray(samples)) for (const s of samples) out.push({ type, t: s.time ?? s.timestamp, value: s.beatsPerMinute ?? s.bpm, unit: 'bpm', src, device });
        else out.push({ type, t, value: r.beatsPerMinute ?? r.bpm ?? r.value, unit: 'bpm', src, device });
      } else if (type === 'bloodPressure') {
        out.push({ type: 'bloodPressureSystolic', t, value: r.systolic?.inMillimetersOfMercury ?? r.systolic, unit: 'mmHg', src, device });
        out.push({ type: 'bloodPressureDiastolic', t, value: r.diastolic?.inMillimetersOfMercury ?? r.diastolic, unit: 'mmHg', src, device });
      } else if (type === 'workout' || type === 'sleepAnalysis') {
        const len = (Date.parse(end) - Date.parse(t)) / 60e3;
        out.push({ type, t, end, value: Number.isFinite(len) ? len : r.duration, unit: 'min', src, device, activity: r.exerciseType ?? r.title ?? r.activity });
      } else {
        const v = value(r);
        out.push({ type, t, end: end || undefined, value: v, unit: TYPES[type].unit, src, device });
      }
    }
  };
  if (Array.isArray(obj)) for (const r of obj) add(r.recordType || r.type || r.dataType, [r.data || r]);
  else for (const [name, records] of Object.entries(obj)) add(name, records);
  return out;
}

/** Health Auto Export (iPhone) JSON. */
function fromHealthAutoExport(obj) {
  const out = [];
  const src = 'apple-health';
  for (const m of obj.data?.metrics || []) {
    if (m.name === 'blood_pressure') {
      for (const d of m.data || []) {
        out.push({ type: 'bloodPressureSystolic', t: d.date, value: d.systolic, unit: 'mmHg', src });
        out.push({ type: 'bloodPressureDiastolic', t: d.date, value: d.diastolic, unit: 'mmHg', src });
      }
      continue;
    }
    if (m.name === 'sleep_analysis') {
      for (const d of m.data || []) {
        const start = d.sleepStart || d.inBedStart || d.startDate || d.date;
        const end = d.sleepEnd || d.inBedEnd || d.endDate;
        const hours = d.totalSleep ?? d.asleep ?? d.qty;
        out.push({ type: 'sleepAnalysis', t: start, end, value: Number(hours) * 60, unit: 'min', src });
      }
      continue;
    }
    const type = HAE[m.name];
    if (!type) continue;
    for (const d of m.data || []) out.push({ type, t: d.date, value: d.Avg ?? d.avg ?? d.qty, unit: unitHAE(m.units, type), src, device: d.source });
  }
  for (const w of obj.data?.workouts || []) {
    const len = (Date.parse(w.end) - Date.parse(w.start)) / 60e3;
    out.push({ type: 'workout', t: w.start, end: w.end, value: Number.isFinite(len) ? len : Number(w.duration) / 60, unit: 'min', src, activity: w.name });
  }
  return out;
}

const unitHAE = (u, type) => ({ count: TYPES[type].unit, 'count/min': 'bpm', '%': '%', kg: 'kg', lb: 'lb', kcal: 'kcal', kJ: 'kJ', km: 'km', mi: 'mi', 'mg/dL': 'mg/dL', 'mmol/L': 'mmol/L', degF: '°F', degC: '°C', ml: 'mL', mL: 'mL', 'fl_oz_us': 'fl oz', g: 'g', min: 'min', ms: 'ms' }[u] || u);

/** CSV (long or wide). */
function fromCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (l) => {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]).map((x) => x.replace(/^﻿/, ''));
  const col = (name) => head.findIndex((x) => x.toLowerCase() === name);
  const out = [];
  if (col('type') >= 0 && col('value') >= 0) {
    const [ty, ti, va, un, en, sr, no] = ['type', 'time', 'value', 'unit', 'end', 'src', 'note'].map((n) => (n === 'time' && col('time') < 0 ? col('timestamp') : col(n)));
    for (const l of lines.slice(1)) {
      const c = split(l);
      out.push({ type: c[ty], t: c[ti], value: c[va], unit: c[un] || undefined, end: en >= 0 ? c[en] || undefined : undefined, src: (sr >= 0 && c[sr]) || 'csv', note: no >= 0 ? c[no] : undefined });
    }
    return out;
  }
  const timeCol = head.findIndex((x) => /^(date|time|timestamp|datetime)$/i.test(x));
  const typeCols = head.map((x, i) => [x, i]).filter(([x]) => TYPES[x]);
  if (timeCol < 0 || !typeCols.length) throw new Error('the CSV needs columns type,time,value,unit, or a date column and columns named after vault types');
  for (const l of lines.slice(1)) {
    const c = split(l);
    for (const [type, i] of typeCols) if (c[i] !== '' && c[i] != null) out.push({ type, t: c[timeCol], value: c[i], src: 'csv' });
  }
  return out;
}

/** Any supported file → { format, samples, raw? (a su94r Drive file, for its readings and markers) }. */
export function parseImport(text, name = '') {
  const trimmed = text.trim();
  if (/\.csv$/i.test(name) || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return { format: 'CSV', samples: fromCsv(trimmed) };
  return parseBody(JSON.parse(trimmed));
}

/** A parsed JSON body (a file, or something a phone app posted to the inbox) → samples. */
export function parseBody(obj) {
  if (isHcWebhook(obj)) return { format: 'HC Webhook', samples: fromHcWebhook(obj) };
  if (obj?.app === 'su94r') return { format: 'a su94r Drive file', samples: obj.health || [], raw: obj, readings: Object.keys(obj.readings || {}), markers: obj.markers || [] };
  if (obj?.data?.metrics || obj?.data?.workouts) return { format: 'Health Auto Export', samples: fromHealthAutoExport(obj) };
  if (Array.isArray(obj) && obj.every((x) => x && TYPES[x.type])) return { format: 'a list of samples', samples: obj.map((x) => ({ ...x, t: x.t ?? x.timestamp, src: x.src || x.source || 'file' })) };
  if (obj?.samples && Array.isArray(obj.samples)) return { format: 'a list of samples', samples: obj.samples.map((x) => ({ ...x, t: x.t ?? x.timestamp, src: x.src || x.source || 'file' })) };
  const hc = fromHealthConnect(obj.data && typeof obj.data === 'object' ? obj.data : obj);
  if (hc.length) return { format: 'Health Connect records', samples: hc };
  throw new Error('this file is not a format the vault knows');
}

export { fromHealthConnect, fromHealthAutoExport, fromCsv };
