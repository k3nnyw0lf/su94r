// ═══════════════════════════════════════════════════════════════════════════
// Cross-stream analytics: time in range by day type, and sleep versus next-day
// glucose stability.
//
// These answer the two questions the rest of the app cannot:
//   "Is any of this actually working?"        → timeInRangeByDayType
//   "Does a bad night cost me the next day?"  → sleepVsNextDay
//
// Everything is pure. Feed it store data, get numbers back. No thresholds are
// hardcoded that the user can configure — they come from settings.
// ═══════════════════════════════════════════════════════════════════════════

import { toMgdl } from './safety.js';
import { validateSeries } from '../cgm/validate.js';
import { excludeWarmup } from '../cgm/sensor.js';
import { localDayKey, resolveTimeZone, addDays } from '../util/localDay.js';

const DAY_MS = 86_400_000;

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Normalises glucose history into { t, mgdl } sorted oldest first. */
function normalizeHistory(history, unit) {
  return history
    .map(r => ({ t: new Date(r.timestamp).getTime(), mgdl: toMgdl(r.value, unit) }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.mgdl))
    .sort((a, b) => a.t - b.t);
}

/**
 * Groups readings by calendar day and computes range statistics.
 *
 * Note this is a count of READINGS in range, not minutes. With a CGM sampling
 * at a fixed interval the two are equivalent; with gaps they are not, so days
 * below `minReadings` are dropped rather than reported as though complete.
 */
export function dailyGlucoseStats(history = [], opts = {}) {
  const { unit = 'mgdl', low = 70, high = 180, veryLow = 55, minReadings = 24, sensors = [],
          timeZone = resolveTimeZone() } = opts;

  // Sentinel error codes and warm-up readings must never reach these numbers.
  // A Dexcom sgv of 5 means "sensor not calibrated"; counted as glucose it
  // would drag the mean down and invent a severe hypo that never happened.
  const clean = validateSeries(excludeWarmup(history, sensors), { unit }).valid;
  const rows = normalizeHistory(clean, unit);
  const byDay = new Map();

  for (const r of rows) {
    const k = localDayKey(r.t, timeZone);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r.mgdl);
  }

  return [...byDay.entries()]
    .filter(([, vals]) => vals.length >= minReadings)
    .map(([date, vals]) => {
      const n = vals.length;
      const avg = mean(vals);
      const sd = stdev(vals);
      return {
        date,
        readings: n,
        tir: vals.filter(v => v >= low && v <= high).length / n,
        below: vals.filter(v => v < low).length / n,
        above: vals.filter(v => v > high).length / n,
        veryLowEvents: vals.filter(v => v < veryLow).length,
        mean: avg,
        // Coefficient of variation. The consensus stability target is <36%,
        // and it is far more informative than average glucose alone.
        cv: sd != null && avg ? (sd / avg) * 100 : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Splits days by what the user did, then compares glucose control across them.
 *
 * This is the "is it working?" screen. A rest day and a strength day are
 * different physiological days, and averaging them together hides the effect
 * entirely.
 */
export function timeInRangeByDayType(workouts = [], history = [], opts = {}) {
  const { timeZone = resolveTimeZone() } = opts;
  const days = dailyGlucoseStats(history, opts);
  const typeByDay = new Map();

  for (const w of workouts) {
    if (!w?.startedAt) continue;
    const k = localDayKey(w.startedAt, timeZone);
    // A day with both counts as the harder of the two — resistance wins,
    // because its overnight tail is what dominates the following night.
    const existing = typeByDay.get(k);
    if (existing === 'resistance') continue;
    typeByDay.set(k, w.modality === 'resistance' ? 'resistance' : existing || w.modality || 'cardio');
  }

  const groups = { resistance: [], cardio: [], mobility: [], rest: [] };
  for (const d of days) {
    const t = typeByDay.get(d.date) || 'rest';
    (groups[t] || groups.rest).push(d);
  }

  return Object.entries(groups)
    .filter(([, ds]) => ds.length > 0)
    .map(([type, ds]) => ({
      type,
      days: ds.length,
      tir: mean(ds.map(d => d.tir)),
      below: mean(ds.map(d => d.below)),
      above: mean(ds.map(d => d.above)),
      meanGlucose: mean(ds.map(d => d.mean)),
      cv: mean(ds.map(d => d.cv).filter(v => v != null)),
      // Two days of anything is an anecdote. The UI uses this to decide
      // whether to show a comparison or a "keep logging" message.
      reliable: ds.length >= 3,
    }))
    .sort((a, b) => b.days - a.days);
}

/**
 * Compares training days against rest days and states the difference plainly.
 * Returns null when there is not enough of both to compare honestly.
 */
export function trainingEffect(byType) {
  const rest = byType.find(g => g.type === 'rest');
  const trained = byType.filter(g => g.type !== 'rest' && g.reliable);
  if (!rest?.reliable || !trained.length) return null;

  const trainedDays = trained.reduce((n, g) => n + g.days, 0);
  const trainedTir =
    trained.reduce((sum, g) => sum + g.tir * g.days, 0) / trainedDays;

  const deltaPts = Math.round((trainedTir - rest.tir) * 100);

  return {
    trainedTir,
    restTir: rest.tir,
    trainedDays,
    restDays: rest.days,
    deltaPts,
    better: deltaPts > 0,
    text:
      deltaPts === 0
        ? `Time in range is the same on training and rest days so far (${Math.round(rest.tir * 100)}%).`
        : `Time in range is ${Math.abs(deltaPts)} points ${deltaPts > 0 ? 'higher' : 'lower'} on training days ` +
          `(${Math.round(trainedTir * 100)}% across ${trainedDays} days) than rest days ` +
          `(${Math.round(rest.tir * 100)}% across ${rest.days} days).`,
  };
}

// ─── Sleep versus next day ──────────────────────────────────────────────────

/**
 * Short sleep is well documented to reduce insulin sensitivity the following
 * day. This pairs each night's sleep duration with the NEXT day's glucose
 * stability and reports whether the user's own data shows the pattern.
 *
 * @param {Array} sleepSamples  health_samples rows of type 'sleepAnalysis',
 *                              value in minutes, recorded_at = sleep start.
 */
export function sleepVsNextDay(sleepSamples = [], history = [], opts = {}) {
  const { minPairs = 5, shortSleepMin = 390, timeZone = resolveTimeZone() } = opts; // 6.5h
  const days = new Map(dailyGlucoseStats(history, opts).map(d => [d.date, d]));

  const pairs = [];
  for (const s of sleepSamples) {
    const minutes = Number(s.value);
    const start = new Date(s.recorded_at || s.timestamp).getTime();
    if (!Number.isFinite(minutes) || !Number.isFinite(start)) continue;
    // A night starting on the 3rd belongs to the 4th's daytime. Computed
    // through local days so a DST night is not silently dropped or doubled.
    const next = days.get(addDays(localDayKey(start, timeZone), 1));
    if (!next) continue;
    pairs.push({ minutes, tir: next.tir, cv: next.cv, date: next.date });
  }

  if (pairs.length < minPairs) {
    return { pairs: pairs.length, enough: false, text: null };
  }

  const short = pairs.filter(p => p.minutes < shortSleepMin);
  const long = pairs.filter(p => p.minutes >= shortSleepMin);
  if (!short.length || !long.length) {
    return { pairs: pairs.length, enough: false, text: null };
  }

  const shortTir = mean(short.map(p => p.tir));
  const longTir = mean(long.map(p => p.tir));
  const deltaPts = Math.round((longTir - shortTir) * 100);

  return {
    pairs: pairs.length,
    enough: true,
    shortNights: short.length,
    longNights: long.length,
    shortTir,
    longTir,
    deltaPts,
    text:
      Math.abs(deltaPts) < 3
        ? `Sleep length has not made a clear difference to your next-day time in range yet (${pairs.length} nights).`
        : `After nights under ${(shortSleepMin / 60).toFixed(1)}h your next-day time in range averages ` +
          `${Math.round(shortTir * 100)}%, against ${Math.round(longTir * 100)}% after longer nights — ` +
          `a ${Math.abs(deltaPts)} point difference across ${pairs.length} nights.`,
  };
}


// ─── Glucose Management Indicator ───────────────────────────────────────────

/**
 * GMI — the CGM-derived estimate of A1c, and the first number most
 * endocrinologists look for.
 *
 * Formula from Bergenstal et al. (2018), Diabetes Care:
 *   GMI(%) = 3.31 + 0.02392 x mean glucose in mg/dL
 *
 * A published formula, not anyone's code.
 *
 * It is an ESTIMATE and routinely differs from a lab A1c by half a point or
 * more, because it reflects only the period the CGM covered. Reported with its
 * coverage so nobody mistakes it for a lab result.
 */
export function glucoseManagementIndicator(history = [], opts = {}) {
  const { unit = 'mgdl', minDays = 12 } = opts;
  const daily = dailyGlucoseStats(history, opts);
  if (!daily.length) return { gmi: null, days: 0, reliable: false, text: 'Not enough CGM data yet.' };

  const meanMgdl = daily.reduce((a, d) => a + d.mean, 0) / daily.length;
  const gmi = 3.31 + 0.02392 * meanMgdl;
  const reliable = daily.length >= minDays;

  return {
    gmi: Math.round(gmi * 10) / 10,
    meanGlucose: meanMgdl,
    days: daily.length,
    reliable,
    text: reliable
      ? `GMI ${gmi.toFixed(1)}% from ${daily.length} days of CGM data.`
      : `GMI ${gmi.toFixed(1)}% from only ${daily.length} days — needs about ${minDays} to be meaningful.`,
    caveat:
      'An estimate from CGM averages, not a lab A1c. The two commonly differ, ' +
      'and GMI only reflects the days the sensor was actually worn.',
  };
}
