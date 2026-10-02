// ═══════════════════════════════════════════════════════════════════════════
// Meal + dose → outcome.
//
// This is the part that beats a bolus calculator, and the reason su94r does not
// need to be one.
//
// A calculator applies your ratios. It cannot tell you whether those ratios are
// RIGHT. Only the outcome data can, and su94r is holding all three streams
// needed to see it: what you ate, what you took, and what your glucose actually
// did afterwards.
//
// What it produces is evidence to take to your endocrinologist — "my 60-80g
// meals landed high at four hours in seven of nine cases" — which is a far
// better conversation than "the app said take six units".
//
// SCOPE, and it is absolute:
//   Describes what happened. Never proposes a ratio, a dose, or an adjustment.
//   The phrase "worth reviewing with your care team" is the strongest
//   recommendation this module is permitted to make. Changing insulin ratios
//   without clinical input is how people end up in hospital.
// ═══════════════════════════════════════════════════════════════════════════

import { toMgdl } from '../fitness/safety.js';
import { validateSeries } from '../cgm/validate.js';

const MIN = 60_000;

/** Carb bands. Response to 15g and 90g differ enough to be worth separating. */
export const CARB_BANDS = [
  { id: 'small', label: 'Under 30g', min: 0, max: 30 },
  { id: 'medium', label: '30–60g', min: 30, max: 60 },
  { id: 'large', label: '60–90g', min: 60, max: 90 },
  { id: 'xlarge', label: 'Over 90g', min: 90, max: Infinity },
];

export const bandFor = g =>
  CARB_BANDS.find(b => g >= b.min && g < b.max) || CARB_BANDS[CARB_BANDS.length - 1];

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function seriesBetween(history, from, to, unit) {
  return history
    .map(r => ({ t: new Date(r.timestamp).getTime(), v: toMgdl(r.value, unit) }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v) && r.t >= from && r.t <= to)
    .sort((a, b) => a.t - b.t);
}

/**
 * Analyses one meal dose against what glucose did afterwards.
 *
 * Four hours is the assessment point: for rapid analogues most of the dose has
 * acted by then, so where you land is informative rather than mid-flight.
 */
export function analyzeMealDose(dose, history, opts = {}) {
  const { unit = 'mgdl', low = 70, high = 180, target = 110 } = opts;
  if (!dose?.takenAt || dose.category === 'basal') return null;
  if (!Number.isFinite(Number(dose.carbsGrams))) return null;

  const t0 = new Date(dose.takenAt).getTime();
  if (!Number.isFinite(t0)) return null;

  const clean = validateSeries(history, { unit }).valid;
  const at = seriesBetween(clean, t0 - 15 * MIN, t0 + 15 * MIN, unit);
  const during = seriesBetween(clean, t0, t0 + 240 * MIN, unit);
  const at2h = seriesBetween(clean, t0 + 105 * MIN, t0 + 135 * MIN, unit);
  const at4h = seriesBetween(clean, t0 + 225 * MIN, t0 + 255 * MIN, unit);

  if (!at.length || !during.length) return null;

  const start = at[at.length - 1].v;
  const peak = Math.max(...during.map(r => r.v));
  const trough = Math.min(...during.map(r => r.v));
  const twoHour = at2h.length ? median(at2h.map(r => r.v)) : null;
  const fourHour = at4h.length ? median(at4h.map(r => r.v)) : null;

  let verdict = 'unknown';
  if (fourHour != null) {
    if (fourHour < low) verdict = 'low';
    else if (fourHour > high) verdict = 'high';
    else verdict = 'in-range';
  }

  return {
    doseId: dose.id,
    takenAt: dose.takenAt,
    units: Number(dose.units),
    carbsGrams: Number(dose.carbsGrams),
    band: bandFor(Number(dose.carbsGrams)).id,
    ratioUsed: Math.round((Number(dose.carbsGrams) / Number(dose.units)) * 10) / 10,
    start,
    peak,
    trough,
    twoHour,
    fourHour,
    riseToPeak: Math.round(peak - start),
    // A low anywhere in the window matters even if four hours looks fine.
    hypoInWindow: trough < low,
    verdict,
  };
}

export function analyzeAllMealDoses(doses = [], history = [], opts = {}) {
  return doses.map(d => analyzeMealDose(d, history, opts)).filter(Boolean);
}

/** Below this, a pattern is an anecdote. */
export const MIN_MEALS_FOR_PATTERN = 5;

/**
 * Groups outcomes by carb band and reports the pattern in each.
 *
 * Reports only. Any wording that sounds like a prescription is a bug.
 */
export function ratioReview(outcomes = [], opts = {}) {
  const { unit = 'mgdl' } = opts;
  const fmt = v => (unit === 'mmol' ? `${(v / 18).toFixed(1)} mmol/L` : `${Math.round(v)} mg/dL`);

  const byBand = {};
  for (const o of outcomes) (byBand[o.band] ||= []).push(o);

  return CARB_BANDS.map(band => {
    const items = byBand[band.id] || [];
    if (!items.length) return null;

    const rated = items.filter(o => o.verdict !== 'unknown');
    const highs = rated.filter(o => o.verdict === 'high').length;
    const lows = rated.filter(o => o.verdict === 'low').length;
    const hypos = items.filter(o => o.hypoInWindow).length;
    const enough = rated.length >= MIN_MEALS_FOR_PATTERN;

    let pattern = null;
    if (enough) {
      if (highs / rated.length >= 0.6) {
        pattern = {
          tone: 'high',
          text:
            `${highs} of ${rated.length} meals in this range finished above target four hours later ` +
            `(median ${fmt(median(rated.map(o => o.fourHour)))}). Worth reviewing with your care team.`,
        };
      } else if (lows / rated.length >= 0.3 || hypos / items.length >= 0.3) {
        pattern = {
          tone: 'low',
          text:
            `${Math.max(lows, hypos)} of ${rated.length} meals in this range ended low or dipped low within four hours. ` +
            `Worth raising with your care team promptly.`,
        };
      } else {
        pattern = {
          tone: 'ok',
          text: `${rated.length} meals in this range mostly finished in target.`,
        };
      }
    }

    return {
      band: band.id,
      label: band.label,
      meals: items.length,
      assessed: rated.length,
      enough,
      medianRatio: median(items.map(o => o.ratioUsed).filter(Number.isFinite)),
      medianFourHour: median(rated.map(o => o.fourHour)),
      medianRise: median(items.map(o => o.riseToPeak)),
      highRate: rated.length ? highs / rated.length : 0,
      lowRate: rated.length ? lows / rated.length : 0,
      hypoRate: items.length ? hypos / items.length : 0,
      pattern,
    };
  }).filter(Boolean);
}

/**
 * Compact factual context for the AI agents, so MealAdvisor reasons about real
 * outcomes instead of textbook carb ratios. Null when there is nothing solid.
 */
export function outcomeContext(review) {
  const solid = review.filter(r => r.enough);
  if (!solid.length) return null;
  return (
    'This user\'s own meal outcomes (four hours after a mealtime dose):\n' +
    solid
      .map(
        r =>
          `- ${r.label}: ${r.assessed} meals, median ratio 1u per ${r.medianRatio}g, ` +
          `${Math.round(r.highRate * 100)}% finished high, ${Math.round(r.hypoRate * 100)}% dipped low`
      )
      .join('\n') +
    '\nDescribe these patterns. Do not propose ratios or doses.'
  );
}

export const OUTCOMES_DISCLAIMER =
  'Patterns from your own logged meals, doses and CGM data. They describe what ' +
  'happened — they are not a recommendation to change anything. Insulin ratios ' +
  'are set with your care team, and this is evidence to bring to that conversation.';
