// Google Health API → the vault: Pixel Watch and Fitbit data (heart rate, steps, workouts,
// sleep, weight, body fat, fingersticks, water, food), read straight from Google in this
// browser with the same Google sign-in as Drive. Read-only; nothing is written to Google.
//
// The Google Health API (health.googleapis.com/v4) replaced the Fitbit Web API in March 2026;
// the Fitbit Web API stops on 2026-10-30. Its scopes are "restricted": an OAuth app can use
// them for up to 100 people without Google's security review, which covers a family. The
// person must have linked their watch in the Google Health app (the renamed Fitbit app).
// No blood pressure type yet: blood pressure comes in through Health Connect instead.

import { getToken, GoogleError, forgetToken } from './google.js';

const API = 'https://health.googleapis.com/v4/users/me/dataTypes';
export const HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];

const ms = (s) => (s ? Date.parse(s) : NaN);
const sample = (p) => p.sampleTime?.physicalTime;
const start = (p) => p.interval?.startTime;
const end = (p) => p.interval?.endTime;
const minutes = (p) => (ms(end(p)) - ms(start(p))) / 60e3;

// Google data type → how each point becomes vault samples. `field` is the point's JSON key.
export const GH_TYPES = [
  { dataType: 'heart-rate', field: 'heartRate', time: 'sample', map: (p) => [{ type: 'heartRate', t: sample(p), value: Number(p.beatsPerMinute), unit: 'bpm' }] },
  { dataType: 'heart-rate-variability', field: 'heartRateVariability', time: 'sample', map: (p) => [{ type: 'heartRateVariability', t: sample(p), value: Number(p.rootMeanSquareOfSuccessiveDifferencesMilliseconds ?? p.standardDeviationMilliseconds), unit: 'ms' }] },
  { dataType: 'resting-heart-rate', field: 'restingHeartRate', time: 'sample', map: (p) => [{ type: 'restingHeartRate', t: sample(p) ?? start(p), value: Number(p.beatsPerMinute), unit: 'bpm' }] },
  { dataType: 'oxygen-saturation', field: 'oxygenSaturation', time: 'sample', map: (p) => [{ type: 'oxygenSaturation', t: sample(p), value: Number(p.percentage), unit: '%' }] },
  { dataType: 'steps', field: 'steps', time: 'interval', map: (p) => [{ type: 'steps', t: start(p), end: end(p), value: Number(p.count), unit: 'steps' }] },
  { dataType: 'active-zone-minutes', field: 'activeZoneMinutes', time: 'interval', map: (p) => [{ type: 'exerciseMinutes', t: start(p), end: end(p), value: Number(p.activeZoneMinutes), unit: 'min' }] },
  {
    dataType: 'exercise', field: 'exercise', time: 'interval',
    map: (p) => [{ type: 'workout', t: start(p), end: end(p), value: minutes(p), unit: 'min', activity: p.exerciseType || p.displayName,
      note: p.metricsSummary?.caloriesKcal ? `${Math.round(p.metricsSummary.caloriesKcal)} kcal${p.metricsSummary.averageHeartRateBeatsPerMinute ? `, avg ${Math.round(p.metricsSummary.averageHeartRateBeatsPerMinute)} bpm` : ''}` : undefined }],
  },
  { dataType: 'sleep', field: 'sleep', time: 'interval', map: (p) => [{ type: 'sleepAnalysis', t: start(p), end: end(p), value: Number(p.summary?.minutesAsleep) || minutes(p), unit: 'min' }] },
  { dataType: 'weight', field: 'weight', time: 'sample', map: (p) => [{ type: 'bodyMass', t: sample(p), value: Number(p.weightGrams) / 1000, unit: 'kg' }] },
  { dataType: 'body-fat', field: 'bodyFat', time: 'sample', map: (p) => [{ type: 'bodyFatPercentage', t: sample(p), value: Number(p.percentage), unit: '%' }] },
  { dataType: 'blood-glucose', field: 'bloodGlucose', time: 'sample', map: (p) => [{ type: 'bloodGlucose', t: sample(p), value: Number(p.bloodGlucoseMilligramsPerDeciliter), unit: 'mg/dL' }] },
  { dataType: 'hydration-log', field: 'hydrationLog', time: 'sample', map: (p) => [{ type: 'hydration', t: sample(p) ?? start(p), value: Number(p.amountConsumed?.milliliters), unit: 'mL' }] },
  {
    dataType: 'nutrition-log', field: 'nutritionLog', time: 'sample',
    map: (p) => {
      const t = sample(p) ?? start(p);
      const carbs = (p.nutrients || []).find((n) => /carbohydrate/i.test(n.nutrient || n.name || ''));
      return [
        { type: 'dietaryEnergy', t, value: Number(p.energy?.kcal), unit: 'kcal' },
        ...(carbs ? [{ type: 'dietaryCarbs', t, value: Number(carbs.amount?.grams ?? carbs.grams ?? carbs.amount), unit: 'g' }] : []),
      ];
    },
  },
];

/**
 * Points of one type since `since` → vault samples, plus the newest point's time. Errors are per
 * type, never fatal; `truncated` means the page limit was reached and the rest comes next time.
 */
export async function pullType(token, spec, since, { fetchImpl = fetch, maxPages = 20 } = {}) {
  const out = [];
  let pageToken = null;
  let newest = 0;
  const key = spec.dataType.replace(/-/g, '_');
  const iso = new Date(since).toISOString();
  const filters = { sample: `${key}.sample_time.physical_time >= "${iso}"`, interval: `${key}.interval.start_time >= "${iso}"` };
  // Some types are filed by sample time, others by interval; if Google rejects one filter as
  // the wrong kind, the other is tried once.
  let filter = filters[spec.time];
  let switched = false;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ pageSize: '1000', filter });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await fetchImpl(`${API}/${spec.dataType}/dataPoints?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) {
      await forgetToken();
      throw new GoogleError('Sign in to Google again to keep reading your watch.', 'signin');
    }
    if (r.status === 400 && !switched && page === 0) {
      switched = true;
      filter = filters[spec.time === 'sample' ? 'interval' : 'sample'];
      page--;
      continue;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const reason = body?.error?.details?.[0]?.reason || body?.error?.status || r.status;
      return { samples: out, error: `${spec.dataType}: ${reason}`, newest, failed: r.status !== 404 };
    }
    const data = await r.json();
    for (const dp of data.dataPoints || []) {
      const p = dp[spec.field];
      if (!p) continue;
      const device = dp.dataSource?.device?.displayName || dp.dataSource?.platform || undefined;
      for (const s of spec.map(p)) {
        if (!Number.isFinite(s.value) || !s.t) continue;
        out.push({ ...s, src: 'google-health', device });
        newest = Math.max(newest, Date.parse(s.t) || 0);
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken) return { samples: out, error: null, newest };
  }
  return { samples: out, error: `${spec.dataType}: more than ${maxPages} pages; the rest comes next time`, newest, truncated: true };
}

/**
 * Reads every type from where it last got to (its own read position) and returns samples,
 * per-type problems and the new read positions. A type's first read goes back 30 days; later
 * ones overlap 36 hours, because a watch can sync hours late and Google files sleep once you
 * wake (the vault keeps one copy). A type that failed keeps its old position, so linking the
 * watch later still brings the first 30 days. `ACCOUNT_NOT_LINKED` means the watch is not
 * linked in the Google Health app.
 */
export async function pullGoogleHealth(cursors = {}, { now = Date.now(), ...opts } = {}) {
  const token = await getToken(HEALTH_SCOPES, { interactive: false });
  const samples = [];
  const errors = [];
  const next = { ...cursors };
  for (const spec of GH_TYPES) {
    const at = cursors[spec.dataType];
    const since = at ? at - 36 * 3600e3 : now - 30 * 864e5;
    const r = await pullType(token, spec, since, opts);
    samples.push(...r.samples);
    if (r.error) errors.push(r.error);
    if (r.failed) continue;
    if (r.newest) next[spec.dataType] = Math.max(at || 0, r.newest);
    else if (!r.truncated && !at) next[spec.dataType] = now - 36 * 3600e3;   // nothing yet: start overlapping from now
  }
  return { samples, errors, cursors: next };
}
