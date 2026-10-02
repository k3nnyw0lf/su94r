// ═══════════════════════════════════════════════════════════════════════════
// Insulin on board.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
//
// This module answers "how much of what I already took is still working?"
// That is a statement about the past — arithmetic over doses the user chose and
// logged themselves.
//
// It does NOT compute a dose. There is no bolus calculator here and there must
// not be one. A dose recommendation is a regulated device function, and the
// specific hazard in su94r is chaining: the carb figure upstream comes from a
// PHOTO with acknowledged wide error bars, and multiplying an uncertain carb
// estimate into units of insulin compounds that error in the one direction that
// cannot be walked back. Carbs guessed high, you correct an hour later. Insulin
// guessed high, you are in trouble in twenty minutes.
//
// Knowing your IOB prevents stacking, which is the most common way people end
// up hypo. That is worth a lot on its own.
//
// The curve is the standard exponential model parameterised by duration of
// action and time to peak — published pharmacokinetics, not anyone's code.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rapid-acting analogue profiles, minutes.
 * Duration and peak are the manufacturers' published figures; individuals vary,
 * so both are user-adjustable in settings.
 */
export const INSULIN_PROFILES = {
  lyumjev: { label: 'Lyumjev', peakMin: 45, durationMin: 300 },
  fiasp: { label: 'Fiasp', peakMin: 55, durationMin: 300 },
  novorapid: { label: 'NovoRapid / Novolog', peakMin: 75, durationMin: 360 },
  humalog: { label: 'Humalog', peakMin: 75, durationMin: 360 },
  apidra: { label: 'Apidra', peakMin: 70, durationMin: 330 },
  regular: { label: 'Regular / Actrapid', peakMin: 150, durationMin: 480 },
};

export const DEFAULT_PROFILE = 'novorapid';

/**
 * Fraction of a dose still active `t` minutes after it was given.
 *
 * Exponential model: with duration td and peak tp,
 *   tau = tp * (1 - tp/td) / (1 - 2*tp/td)
 *   a   = 2*tau/td
 *   S   = 1 / (1 - a + (1+a)*exp(-td/tau))
 *
 * Returns 1 at t=0 and 0 at t>=td.
 */
export function activeFraction(minutesSince, { peakMin, durationMin }) {
  const t = Number(minutesSince);
  const td = Number(durationMin);
  const tp = Number(peakMin);

  if (!Number.isFinite(t) || t < 0) return 0;
  if (t >= td) return 0;
  // The model degenerates when peak reaches half of duration.
  if (!(td > 0) || !(tp > 0) || tp >= td / 2) return Math.max(0, 1 - t / td);

  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));

  const iob =
    1 -
    S *
      (1 - a) *
      (((t * t) / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);

  return Math.min(1, Math.max(0, iob));
}

/**
 * Total insulin still active from a set of logged doses.
 *
 * @param {Array} doses  [{ units, takenAt, insulinType }]
 * @param {object} [opts] { now, profiles, defaultType }
 * @returns {{units:number, contributions:Array, lastDoseAt:string|null}}
 */
export function insulinOnBoard(doses = [], opts = {}) {
  const { now = Date.now(), profileOverrides = {}, defaultType = DEFAULT_PROFILE } = opts;
  const contributions = [];
  let total = 0;
  let lastDoseAt = null;

  for (const d of doses) {
    const units = Number(d?.units);
    const at = new Date(d?.takenAt).getTime();
    if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(at)) continue;
    // Long-acting basal is not modelled by this curve and must not be summed
    // into a bolus IOB figure — doing so would wildly overstate active insulin.
    if (d.category === 'basal') continue;
    if (at > now) continue;

    const type = d.insulinType || defaultType;
    const profile = profileOverrides[type] || INSULIN_PROFILES[type] || INSULIN_PROFILES[defaultType];
    const minutes = (now - at) / 60000;
    const frac = activeFraction(minutes, profile);
    if (frac <= 0) continue;

    const remaining = units * frac;
    total += remaining;
    contributions.push({
      takenAt: d.takenAt,
      units,
      remaining: Math.round(remaining * 100) / 100,
      minutesAgo: Math.round(minutes),
      percentLeft: Math.round(frac * 100),
      insulinType: type,
    });
    if (!lastDoseAt || at > new Date(lastDoseAt).getTime()) lastDoseAt = d.takenAt;
  }

  contributions.sort((a, b) => a.minutesAgo - b.minutesAgo);
  return { units: Math.round(total * 100) / 100, contributions, lastDoseAt };
}

/**
 * Minutes until active insulin falls below a threshold.
 * Used to answer "when is it reasonable to think about eating again?" without
 * ever suggesting what to take.
 */
export function minutesUntilIobBelow(doses, threshold = 0.5, opts = {}) {
  const { now = Date.now(), maxLookaheadMin = 480 } = opts;
  for (let m = 0; m <= maxLookaheadMin; m += 5) {
    const { units } = insulinOnBoard(doses, { ...opts, now: now + m * 60000 });
    if (units < threshold) return m;
  }
  return null;
}

/**
 * Flags insulin stacking — a new dose given while a meaningful amount of the
 * previous one is still working. Descriptive, not prescriptive: it reports what
 * happened, it does not tell the user what to do about it.
 */
export function detectStacking(doses = [], opts = {}) {
  const { stackThresholdUnits = 1, windowMin = 180 } = opts;
  const sorted = [...doses]
    .filter(d => d?.category !== 'basal' && Number(d?.units) > 0)
    .sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt));

  const events = [];
  for (let i = 1; i < sorted.length; i++) {
    const at = new Date(sorted[i].takenAt).getTime();
    const priorIob = insulinOnBoard(sorted.slice(0, i), { ...opts, now: at });
    const gapMin = (at - new Date(sorted[i - 1].takenAt).getTime()) / 60000;
    if (priorIob.units >= stackThresholdUnits && gapMin <= windowMin) {
      events.push({
        takenAt: sorted[i].takenAt,
        units: Number(sorted[i].units),
        iobAtTime: priorIob.units,
        gapMin: Math.round(gapMin),
      });
    }
  }
  return events;
}

export const IOB_DISCLAIMER =
  'Active insulin estimated from the doses you logged, using published action ' +
  'curves. It shows what is still working — it never suggests a dose. Curves ' +
  'vary between people; treat it as a guide and confirm settings with your care team.';
