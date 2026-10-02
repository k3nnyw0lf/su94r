// ═══════════════════════════════════════════════════════════════════════════
// Personalised pre-workout carbohydrate estimate.
//
// SCOPE — same hard boundary as safety.js:
//   Carbohydrate only. Never insulin, never a basal rate, never a temp basal.
//
// The gate in safety.js quotes published ranges ("10–20g") because that is all
// you can say to a stranger. Once enough of the user's own sessions are logged,
// the correlation engine knows how far THEY actually drop for a given kind of
// session — so the estimate can stop being generic.
//
// Two rules govern everything here:
//
//   1. Fall back to published guidance whenever the data is thin, the spread is
//      wide, or the arithmetic produces something implausible. A number derived
//      from four noisy sessions is worse than an honest range, because it looks
//      authoritative.
//
//   2. Round UP, never down. The failure mode of over-estimating carbs is a
//      temporarily higher glucose. The failure mode of under-estimating is a
//      hypo mid-session. These are not symmetric and the code should not treat
//      them as if they are.
// ═══════════════════════════════════════════════════════════════════════════

import { toMgdl, fromMgdl, DEFAULT_GATES } from './safety.js';
import { MIN_SESSIONS_FOR_CONFIDENCE } from './correlate.js';

/**
 * mg/dL rise per gram of fast carbohydrate. ~4 is the usual adult rule of
 * thumb and the basis of "15g raises you about 50". It scales with body mass,
 * so it is a setting rather than a constant — but it is only ever used to size
 * a snack, never a dose.
 */
export const DEFAULT_CARB_FACTOR = 4;

/** Never suggest more than this from a computed estimate. */
const MAX_SUGGESTED_G = 45;

/** Glucose we want the user to still be above when the session ends. */
const SAFE_FLOOR_MGDL = 100;

const roundUpTo5 = g => Math.ceil(g / 5) * 5;
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median absolute deviation — spread measure that a single outlier cannot inflate. */
function mad(xs) {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.map(x => Math.abs(x - m)));
}

/**
 * Estimates carbohydrate to take before a session.
 *
 * @param {object}  opts
 * @param {object}  opts.reading      Latest CGM reading { value, trend }.
 * @param {string}  opts.modality     'resistance' | 'cardio' | 'mobility'
 * @param {Array}   opts.analyses     Output of correlate.analyzeAll().
 * @param {number}  [opts.durationMin] Planned session length.
 * @param {string}  [opts.unit]
 * @param {number}  [opts.carbFactor]
 * @param {object}  [opts.gates]
 * @returns {{grams:number|null, personalised:boolean, basis:string, detail:string, sessions:number}}
 */
export function estimateCarbs({
  reading,
  modality = 'resistance',
  analyses = [],
  durationMin = null,
  unit = 'mgdl',
  carbFactor = DEFAULT_CARB_FACTOR,
  gates = DEFAULT_GATES,
}) {
  const generic = {
    grams: null,
    personalised: false,
    sessions: 0,
    basis: 'published guidance',
    detail: 'Not enough of your own sessions yet — following published ranges.',
  };

  if (!reading || reading.value == null) return generic;
  const now = toMgdl(reading.value, unit);

  // Only sessions of the same kind: a lifting session and a zone-2 hour move
  // glucose in opposite directions, so pooling them would cancel out the very
  // signal we are looking for.
  const same = analyses.filter(a => a.modality === modality && a.deltaDuring != null);
  if (same.length < MIN_SESSIONS_FOR_CONFIDENCE) {
    return { ...generic, sessions: same.length };
  }

  const deltas = same.map(a => a.deltaDuring);
  const typical = median(deltas);
  const spread = mad(deltas);

  // A median of -40 means nothing if the sessions ranged -5 to -90. Wide spread
  // means this user's response is not yet predictable for this kind of session.
  if (spread != null && Math.abs(spread) > 35) {
    return {
      ...generic,
      sessions: same.length,
      detail: `Your ${modality} sessions vary too much so far (±${Math.round(spread)} mg/dL) to predict a number. Following published ranges.`,
    };
  }

  // Scale by duration when the history has a usable typical length.
  const typicalMin = median(same.map(a => a.durationMin).filter(Boolean));
  let expectedDelta = typical;
  if (durationMin && typicalMin && typicalMin > 0) {
    const ratio = Math.min(Math.max(durationMin / typicalMin, 0.5), 2);
    expectedDelta = typical * ratio;
  }

  const projected = now + expectedDelta;
  const falling = typeof reading.trend === 'string' && /fall|down|↓/i.test(reading.trend);

  // Already heading below the floor before exercise is a safety.js matter,
  // not a snack-sizing one.
  if (now < gates.hardStop) {
    return {
      grams: 20,
      personalised: false,
      sessions: same.length,
      basis: 'pre-exercise minimum',
      detail: `At ${fromMgdl(now, unit)} you are below the starting threshold. Treat first, then re-check.`,
    };
  }

  if (projected >= SAFE_FLOOR_MGDL && !falling) {
    return {
      grams: 0,
      personalised: true,
      sessions: same.length,
      basis: 'your measured response',
      detail:
        `Across ${same.length} ${modality} sessions you typically move ` +
        `${typical > 0 ? '+' : ''}${Math.round(typical)} mg/dL. From ${fromMgdl(now, unit)} that lands near ` +
        `${fromMgdl(projected, unit)} — no carbs needed, but keep fast carbs to hand.`,
    };
  }

  let deficit = SAFE_FLOOR_MGDL - projected;
  // A falling arrow means the projection is already optimistic.
  if (falling) deficit += 20;

  const grams = Math.min(roundUpTo5(Math.max(deficit, 0) / carbFactor), MAX_SUGGESTED_G);

  return {
    grams,
    personalised: true,
    sessions: same.length,
    basis: 'your measured response',
    detail:
      `Across ${same.length} ${modality} sessions you typically move ` +
      `${typical > 0 ? '+' : ''}${Math.round(typical)} mg/dL. From ${fromMgdl(now, unit)}` +
      (falling ? ' and falling' : '') +
      ` that projects to about ${fromMgdl(projected, unit)}, below ${fromMgdl(SAFE_FLOOR_MGDL, unit)}.`,
  };
}

/** Shown wherever an estimate is surfaced. */
export const CARB_DISCLAIMER =
  'An estimate from your own logged sessions, not a prescription. It sizes a snack — ' +
  'it never suggests insulin. Check your glucose rather than trusting the number, and ' +
  'review the approach with your care team.';
