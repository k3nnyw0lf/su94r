// ═══════════════════════════════════════════════════════════════════════════
// Hypo treatment effectiveness, and missed basal detection.
//
// TREATMENT: THE RULE OF 15 IS A POPULATION AVERAGE
//
// "15g raises you about 50 mg/dL in 15 minutes" is the standard teaching, and
// it is an average across people who differ by body mass, insulin on board and
// what they actually ate. Yours is a NUMBER, and su94r is holding every
// ingredient needed to measure it: what you took, when, and what glucose did.
//
// Knowing your own response cuts both failure modes:
//   • under-treating, then dropping again twenty minutes later
//   • over-treating, then the rebound spike people then correct for, which is
//     how a single low turns into a whole bad day
//
// This reports what happened. It does not tell anyone how many grams to eat —
// a treatment target belongs with the care team, same as everything else here.
//
// MISSED BASAL: SILENT, AND A COMMON ROUTE TO DKA
//
// Forgetting long-acting insulin feels like nothing for hours. By the time
// glucose climbs, ketones are often already building. If someone doses at
// roughly the same time daily, a missing entry is detectable — and a nudge at
// 23:30 is worth a great deal more than an alarm at 04:00.
// ═══════════════════════════════════════════════════════════════════════════

import { toMgdl } from '../fitness/safety.js';
import { validateSeries } from '../cgm/validate.js';
import { localHour, resolveTimeZone } from '../util/localDay.js';

const MIN = 60_000;

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Measures one hypo treatment.
 *
 * @param {object} treatment { takenAt, carbsGrams }
 * @param {Array}  history
 */
export function analyzeTreatment(treatment, history, opts = {}) {
  const { unit = 'mgdl', windowMin = 45 } = opts;
  const grams = Number(treatment?.carbsGrams);
  const t0 = new Date(treatment?.takenAt).getTime();
  if (!Number.isFinite(grams) || grams <= 0 || !Number.isFinite(t0)) return null;

  const clean = validateSeries(history, { unit }).valid
    .map(r => ({ t: new Date(r.timestamp).getTime(), v: toMgdl(Number(r.value), unit) }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t);

  // At or BEFORE t0 only. A reading five minutes in has already started to
  // rise, and using it as the baseline silently understates the response.
  const at = clean.filter(r => r.t >= t0 - 12 * MIN && r.t <= t0);
  const after15 = clean.filter(r => r.t >= t0 + 12 * MIN && r.t <= t0 + 20 * MIN);
  const window = clean.filter(r => r.t >= t0 && r.t <= t0 + windowMin * MIN);
  if (!at.length || !window.length) return null;

  const start = at[at.length - 1].v;
  const at15 = after15.length ? median(after15.map(r => r.v)) : null;
  const peak = Math.max(...window.map(r => r.v));
  const trough = Math.min(...window.map(r => r.v));

  const rise15 = at15 != null ? at15 - start : null;
  // Per-gram response is the transferable number — it lets a different amount
  // be reasoned about, where a raw rise only describes this one occasion.
  const perGram = rise15 != null ? rise15 / grams : null;

  return {
    takenAt: treatment.takenAt,
    grams,
    start,
    at15,
    rise15,
    perGram: perGram != null ? Math.round(perGram * 100) / 100 : null,
    peak,
    trough,
    // Still below 70 fifteen minutes later: the treatment was not enough.
    stillLow: at15 != null && at15 < 70,
    // Over 180 within the window: over-treated, and the rebound is what people
    // then correct for, turning one low into a whole bad day.
    rebound: peak > 180,
    droppedAgain: trough < start && trough < 70,
  };
}

export const MIN_TREATMENTS = 5;

/**
 * Rolls treatments up into the user's own response. Silent below the threshold
 * rather than reporting an average of three events as if it meant something.
 */
export function treatmentReview(treatments = [], history = [], opts = {}) {
  const rows = treatments.map(t => analyzeTreatment(t, history, opts)).filter(Boolean);
  const rated = rows.filter(r => r.perGram != null);

  if (rated.length < MIN_TREATMENTS) {
    return {
      count: rows.length,
      enough: false,
      text: `${rows.length} treatment${rows.length === 1 ? '' : 's'} logged with glucose coverage. ` +
            `${MIN_TREATMENTS} are needed before su94r will report your own response.`,
    };
  }

  const perGram = median(rated.map(r => r.perGram));
  const underRate = rows.filter(r => r.stillLow).length / rows.length;
  const overRate = rows.filter(r => r.rebound).length / rows.length;
  const expected15 = Math.round(perGram * 15);

  const notes = [];
  if (underRate >= 0.3) {
    notes.push({
      tone: 'warn',
      text: `${Math.round(underRate * 100)}% of your treatments left you still low at 15 minutes. Worth discussing your treatment amount with your care team.`,
    });
  }
  if (overRate >= 0.4) {
    notes.push({
      tone: 'warn',
      text: `${Math.round(overRate * 100)}% rebounded above 180. Over-treating is understandable when you feel awful, but the spike afterwards is what turns one low into a bad day.`,
    });
  }

  return {
    count: rows.length,
    enough: true,
    perGram,
    expected15,
    underRate,
    overRate,
    text:
      `Across ${rated.length} treatments, carbohydrate raises you about ` +
      `${perGram.toFixed(1)} mg/dL per gram — so 15g moves you roughly ${expected15}, ` +
      `against the textbook 50.`,
    notes,
  };
}

// ─── Missed basal ───────────────────────────────────────────────────────────

/**
 * Learns the usual basal time from history and flags a missing dose.
 *
 * Uses the median hour rather than the mean, so one 03:00 dose after a late
 * night does not drag the expected time across the evening.
 */
export function basalPattern(doses = [], { timeZone = resolveTimeZone(), minDoses = 5 } = {}) {
  const basals = doses
    .filter(d => d?.category === 'basal' && d.takenAt)
    .map(d => ({ t: new Date(d.takenAt).getTime(), hour: localHour(d.takenAt, timeZone) }))
    .filter(d => Number.isFinite(d.t) && d.hour != null)
    .sort((a, b) => b.t - a.t);

  if (basals.length < minDoses) {
    return { known: false, doses: basals.length };
  }

  return {
    known: true,
    doses: basals.length,
    usualHour: Math.round(median(basals.map(b => b.hour))),
    lastAt: new Date(basals[0].t).toISOString(),
  };
}

/**
 * Should we ask whether basal was taken?
 *
 * Deliberately quiet: it needs an established pattern, a window past the usual
 * time, and no dose logged today. Asking someone daily whether they took their
 * insulin is both annoying and, worse, teaches them to dismiss it.
 */
export function checkMissedBasal(doses = [], opts = {}) {
  const { timeZone = resolveTimeZone(), graceHours = 1.5, now = Date.now() } = opts;
  const pattern = basalPattern(doses, { timeZone });
  if (!pattern.known) return { prompt: false, reason: 'no established pattern yet' };

  const hoursSinceLast = (now - new Date(pattern.lastAt).getTime()) / 3_600_000;
  // Long-acting covers roughly a day; under 20 hours there is nothing to ask.
  if (hoursSinceLast < 20) return { prompt: false, reason: 'dosed recently' };

  const hour = localHour(now, timeZone);
  const usual = pattern.usualHour;
  // Handle a usual time near midnight without wrapping into the next evening.
  const past = (hour - usual + 24) % 24;
  if (past < graceHours) return { prompt: false, reason: 'still within the usual window' };

  return {
    prompt: true,
    usualHour: usual,
    hoursSinceLast: Math.round(hoursSinceLast),
    urgency: hoursSinceLast > 28 ? 'high' : 'normal',
    title: 'Did you take your basal?',
    detail:
      `You usually take it around ${String(usual).padStart(2, '0')}:00, and nothing is logged for ` +
      `${Math.round(hoursSinceLast)} hours.`,
    // Never says "take it now" — a double dose is its own emergency.
    guidance:
      'If you have taken it, log it to silence this. If you have not, follow your care team\'s advice ' +
      'on a late dose — do not simply double up, and do not guess at a partial dose.',
  };
}

export const TREATMENT_DISCLAIMER =
  'Your measured response to treating a low, from your own logged treatments. ' +
  'It describes what happened and does not tell you how much to eat — that ' +
  'target is set with your care team.';
