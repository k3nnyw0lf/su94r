// ═══════════════════════════════════════════════════════════════════════════
// CGM reading validation.
//
// WHY THIS EXISTS
//
// CGM feeds do not emit only glucose. They emit sentinel values that mean
// "no reading, and here is why". In the Dexcom Share / Nightscout `sgv` field
// these occupy the low integers — a value of 5 means SENSOR_NOT_CALIBRATED,
// not five milligrams per decilitre.
//
// Without this layer su94r treated those as real glucose. The consequences are
// not cosmetic:
//   • a false severe-low alarm at "5 mg/dL"
//   • time-in-range, GMI and the correlation engine silently poisoned
//   • the post-exercise threshold and sedentary nudge reading a sensor fault
//     as a medical emergency
//
// Written from the published Dexcom sentinel values and standard CGM operating
// ranges. No code from Nightscout or xDrip is used here — both are copyleft
// (AGPL-3.0 and GPL-3.0) and su94r is MIT.
//
// Design rule: this module DISCARDS rather than repairs. A reading that cannot
// be trusted must not reach the analytics in any form, because a plausible
// wrong number is more dangerous than a gap.
// ═══════════════════════════════════════════════════════════════════════════

/** Sentinel values in the Dexcom `sgv` field. Anything below 39 is not glucose. */
export const SENSOR_ERROR_CODES = {
  0: 'No reading',
  1: 'Sensor not active',
  2: 'Minimal deviation',
  3: 'No antenna',
  5: 'Sensor not calibrated',
  6: 'Counts deviation',
  9: 'Absolute deviation',
  10: 'Power deviation',
  12: 'Bad RF signal',
};

/**
 * Physiological plausibility bounds, mg/dL.
 *
 * 39 is the conventional floor because sentinel codes sit below it. 400 is the
 * reporting ceiling of every mainstream CGM — a value at or above it means
 * "at least this high", so it is kept but flagged as capped rather than
 * treated as an exact figure.
 */
export const MIN_VALID_MGDL = 39;
export const MAX_REPORTED_MGDL = 400;

// NOTE ON FRESHNESS — deliberately not checked here.
//
// An earlier version rejected anything older than 24 hours. That is the right
// question for "may I act on this reading right now", and exactly the wrong one
// for historical analysis, where every reading is old by definition. It
// silently reduced 14 days of history to a single day and broke time in range,
// GMI and the day-type comparison at once.
//
// Freshness belongs to safety.js (readingAgeMinutes / MAX_READING_AGE_MIN),
// which gates workouts. This module answers only "is this a real glucose
// value". Do not add an age cutoff back.

export const REJECT = {
  ERROR_CODE: 'error-code',
  OUT_OF_RANGE: 'out-of-range',
  NOT_NUMERIC: 'not-numeric',
  BAD_TIMESTAMP: 'bad-timestamp',
  FUTURE: 'future',
  WARMUP: 'sensor-warmup',
};

/**
 * Validates a single reading.
 *
 * @param {object} reading  { value, timestamp, ... } in mg/dL.
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.inWarmup]  True when the sensor is still settling.
 * @returns {{valid:boolean, reason:string|null, detail:string|null, capped:boolean}}
 */
export function validateReading(reading, opts = {}) {
  const { now = Date.now(), inWarmup = false } = opts;
  const ok = (capped = false) => ({ valid: true, reason: null, detail: null, capped });
  const no = (reason, detail) => ({ valid: false, reason, detail, capped: false });

  if (!reading) return no(REJECT.NOT_NUMERIC, 'No reading');

  const v = Number(reading.value);
  if (!Number.isFinite(v)) return no(REJECT.NOT_NUMERIC, 'Value is not a number');

  // Sentinel codes first — they masquerade as severe hypoglycaemia and would
  // otherwise trip every alarm in the app.
  if (v < MIN_VALID_MGDL) {
    const named = SENSOR_ERROR_CODES[Math.trunc(v)];
    return no(
      named ? REJECT.ERROR_CODE : REJECT.OUT_OF_RANGE,
      named ? `Sensor status: ${named}` : `Below the plausible range (${v})`
    );
  }

  const t = new Date(reading.timestamp).getTime();
  if (!Number.isFinite(t)) return no(REJECT.BAD_TIMESTAMP, 'Unreadable timestamp');
  // Small clock skew between phone and sensor is normal; hours are not.
  if (t > now + 15 * 60_000) return no(REJECT.FUTURE, 'Timestamp is in the future');

  // Warm-up readings are real numbers and often badly wrong. Excluded from
  // analytics, but the caller may still choose to display them.
  if (inWarmup) return no(REJECT.WARMUP, 'Sensor still warming up');

  return ok(v >= MAX_REPORTED_MGDL);
}

/**
 * Filters a series, returning the clean readings and an audit of what was
 * dropped. The audit matters — silently discarding a third of a feed would
 * look identical to a healthy one.
 */
export function validateSeries(readings = [], opts = {}) {
  const valid = [];
  const rejected = [];
  const reasons = {};

  for (const r of readings) {
    const v = validateReading(r, opts);
    if (v.valid) {
      valid.push(v.capped ? { ...r, capped: true } : r);
    } else {
      rejected.push({ reading: r, reason: v.reason, detail: v.detail });
      reasons[v.reason] = (reasons[v.reason] || 0) + 1;
    }
  }

  return {
    valid,
    rejected,
    reasons,
    total: readings.length,
    // A feed dropping this much is a hardware or connection problem the user
    // should be told about, not a statistic to bury.
    degraded: readings.length > 0 && rejected.length / readings.length > 0.25,
  };
}

/** One-line summary for the UI when a feed looks unhealthy. */
export function describeRejections(result) {
  if (!result?.rejected?.length) return null;
  const parts = Object.entries(result.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason.replace(/-/g, ' ')}`);
  return `${result.rejected.length} of ${result.total} readings ignored (${parts.join(', ')}).`;
}
