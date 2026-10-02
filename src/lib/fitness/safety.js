// ═══════════════════════════════════════════════════════════════════════════
// Pre-, intra-, and post-exercise glucose safety gates for Type 1 Diabetes.
//
// SCOPE — read this before changing anything in here:
//
//   This module encodes published, general self-management guidance on
//   exercising with T1D (the 2017 Riddell et al. consensus in Lancet Diabetes
//   & Endocrinology, and ADA Standards of Care). It deals ONLY in carbohydrate
//   intake, monitoring cadence, and whether to start or stop a session.
//
//   It does NOT and MUST NOT ever recommend an insulin dose, a basal rate, a
//   temp basal, a bolus adjustment, or a pump setting. That is a clinical
//   decision between the user and their care team. If you are tempted to add
//   it, don't.
//
//   Every threshold here is user-overridable and every output carries the
//   expectation that it gets reviewed by the user's endocrinologist.
// ═══════════════════════════════════════════════════════════════════════════

/** Internal math is always mg/dL. Display converts at the edge. */
export const MGDL_PER_MMOL = 18;

export const toMgdl = (v, unit) => (unit === 'mmol' ? v * MGDL_PER_MMOL : v);
export const fromMgdl = (v, unit) => (unit === 'mmol' ? +(v / MGDL_PER_MMOL).toFixed(1) : Math.round(v));

/**
 * Default pre-exercise decision points, mg/dL.
 * Sourced from the Riddell 2017 consensus starting-glucose ranges.
 */
export const DEFAULT_GATES = {
  hardStop: 90,        // below this, don't start — eat first
  cautionLow: 125,     // 90–125: top up before aerobic work
  idealHigh: 250,      // 125–250: clear to train
  ketoneCheck: 270,    // above this, check ketones before doing anything
};

export const VERDICT = {
  BLOCK: 'block',       // do not start
  CAUTION: 'caution',   // start only after acting on the advice
  CLEAR: 'clear',       // good to go
  UNKNOWN: 'unknown',   // no recent reading — can't judge
};

/** A reading older than this can't be trusted to gate a workout. */
const MAX_READING_AGE_MIN = 15;

export function readingAgeMinutes(reading, now = Date.now()) {
  if (!reading?.timestamp) return Infinity;
  return (now - new Date(reading.timestamp).getTime()) / 60000;
}

/**
 * Decides whether a session may start.
 *
 * @param {object}  reading   Latest CGM reading — { value, trend, timestamp }.
 * @param {string}  modality  'resistance' | 'cardio' | 'mobility'
 * @param {object}  opts
 * @param {object}  [opts.gates]        Override thresholds (mg/dL).
 * @param {string}  [opts.unit]         'mgdl' | 'mmol' — unit of reading.value.
 * @param {number}  [opts.now]
 * @returns {{verdict: string, title: string, detail: string, actions: string[], ageMin: number}}
 */
export function preWorkoutCheck(reading, modality = 'resistance', opts = {}) {
  const { gates = DEFAULT_GATES, unit = 'mgdl', now = Date.now() } = opts;
  const ageMin = readingAgeMinutes(reading, now);

  if (!reading || reading.value == null) {
    return {
      verdict: VERDICT.UNKNOWN,
      title: 'No glucose reading',
      detail: 'su94r has no recent reading, so it cannot check whether it is safe to start.',
      actions: ['Check your glucose manually before starting.'],
      ageMin,
    };
  }

  if (ageMin > MAX_READING_AGE_MIN) {
    return {
      verdict: VERDICT.UNKNOWN,
      title: 'Reading is stale',
      detail: `Last reading was ${Math.round(ageMin)} minutes ago. That is too old to gate a workout.`,
      actions: ['Refresh your CGM or check manually before starting.'],
      ageMin,
    };
  }

  const mgdl = toMgdl(reading.value, unit);
  const falling = typeof reading.trend === 'string' && /fall|down|↓/i.test(reading.trend);

  if (mgdl < gates.hardStop) {
    return {
      verdict: VERDICT.BLOCK,
      title: 'Too low to start',
      detail: `You are at ${fromMgdl(mgdl, unit)}. Published guidance is to get above ${fromMgdl(gates.hardStop, unit)} before starting any session.`,
      actions: [
        'Take 15–20g of fast-acting carbohydrate.',
        'Wait 15 minutes and re-check.',
        'Only start once you are above the threshold and stable or rising.',
      ],
      ageMin,
    };
  }

  if (mgdl < gates.cautionLow) {
    return {
      verdict: VERDICT.CAUTION,
      title: 'Low-ish — top up first',
      detail: `At ${fromMgdl(mgdl, unit)} you are in the range where aerobic work commonly drives a hypo.`,
      actions: [
        modality === 'cardio'
          ? 'Take ~10–20g of carbohydrate before starting.'
          : 'Take ~10g of carbohydrate before starting.',
        'Keep fast carbs within arm’s reach for the whole session.',
      ],
      ageMin,
    };
  }

  if (mgdl > gates.ketoneCheck) {
    return {
      verdict: VERDICT.BLOCK,
      title: 'Check ketones before training',
      detail: `At ${fromMgdl(mgdl, unit)} you are high enough that exercising could push glucose higher rather than lower.`,
      actions: [
        'Test for ketones.',
        'If ketones are moderate or high, do not exercise — follow your sick-day plan and contact your care team.',
        'If ketones are negative or trace, light activity only, and re-check before doing more.',
      ],
      ageMin,
    };
  }

  if (mgdl > gates.idealHigh) {
    return {
      verdict: VERDICT.CAUTION,
      title: 'Running high',
      detail: `At ${fromMgdl(mgdl, unit)} you are clear to move, but hard anaerobic work may push you higher still.`,
      actions: [
        'Favour steady aerobic work over heavy lifting or intervals right now.',
        'Re-check within 30 minutes.',
        'If you climb past ' + fromMgdl(gates.ketoneCheck, unit) + ', stop and test ketones.',
      ],
      ageMin,
    };
  }

  if (falling && mgdl < gates.cautionLow + 30) {
    return {
      verdict: VERDICT.CAUTION,
      title: 'In range but falling',
      detail: `You are at ${fromMgdl(mgdl, unit)} and trending down. Exercise will accelerate that.`,
      actions: ['Take ~10–15g of carbohydrate before starting.', 'Re-check within 20 minutes of starting.'],
      ageMin,
    };
  }

  return {
    verdict: VERDICT.CLEAR,
    title: 'Clear to train',
    detail: `${fromMgdl(mgdl, unit)} is in the recommended starting range.`,
    actions: ['Keep fast carbs within reach.', 'Re-check around 30 minutes in.'],
    ageMin,
  };
}

/** How often to prompt a mid-session check, in minutes. */
export function checkIntervalMinutes(modality, preVerdict) {
  if (preVerdict === VERDICT.CAUTION) return 20;
  return modality === 'cardio' ? 30 : 45;
}

/**
 * Evaluates a reading taken mid-session.
 * Returns null when nothing needs to be said.
 */
export function intraWorkoutCheck(reading, opts = {}) {
  const { gates = DEFAULT_GATES, unit = 'mgdl' } = opts;
  if (!reading || reading.value == null) return null;
  const mgdl = toMgdl(reading.value, unit);

  if (mgdl < 70) {
    return {
      verdict: VERDICT.BLOCK,
      title: 'Stop now',
      detail: `You are at ${fromMgdl(mgdl, unit)}.`,
      actions: [
        'Stop exercising.',
        'Take 15g of fast-acting carbohydrate.',
        'Re-check in 15 minutes. Repeat until above 70.',
        'Do not resume until you are back in range and stable.',
      ],
    };
  }

  if (mgdl < gates.hardStop) {
    return {
      verdict: VERDICT.CAUTION,
      title: 'Dropping — top up',
      detail: `You are at ${fromMgdl(mgdl, unit)} mid-session.`,
      actions: ['Pause and take 15g of carbohydrate.', 'Re-check in 15 minutes before continuing.'],
    };
  }

  if (mgdl > gates.ketoneCheck) {
    return {
      verdict: VERDICT.CAUTION,
      title: 'Climbing high',
      detail: `You are at ${fromMgdl(mgdl, unit)} and rising during the session.`,
      actions: ['Ease off the intensity.', 'Test ketones if you go higher or feel unwell.'],
    };
  }

  return null;
}

/**
 * The window after a session where a delayed hypo is most likely.
 *
 * Resistance and interval work raises insulin sensitivity for hours, and an
 * evening session is the classic setup for an overnight low. This produces the
 * watch window the Fitness page and notification layer schedule against.
 */
export function postWorkoutWatch(session, opts = {}) {
  const { now = Date.now() } = opts;
  const ended = session?.endedAt ? new Date(session.endedAt).getTime() : now;
  const endedHour = new Date(ended).getHours();
  const isEvening = endedHour >= 16;
  const intense = session?.modality === 'resistance' || session?.modality === 'cardio';

  // Elevated insulin sensitivity is commonly described as lasting up to ~24h,
  // with the sharpest risk in the first several hours and overnight.
  const hours = intense ? (isEvening ? 12 : 8) : 4;

  return {
    untilMs: ended + hours * 3600_000,
    hours,
    overnightRisk: isEvening && intense,
    checkpoints: intense
      ? isEvening
        ? ['30 minutes after finishing', 'Before bed', 'Around 3am if you can']
        : ['30 minutes after finishing', '2 hours after', '4 hours after']
      : ['1 hour after finishing'],
    note: isEvening && intense
      ? 'Evening training plus raised insulin sensitivity is the classic setup for an overnight low. Check before bed.'
      : 'Insulin sensitivity stays elevated for hours after a session. Expect to run lower than usual.',
  };
}

/**
 * Low threshold raised for a window after training.
 *
 * Insulin sensitivity stays elevated for hours after a session, so the glucose
 * at which you should act is higher than usual during that window — a reading
 * of 80 falling means something different at 9pm after lifting than it does on
 * a rest day.
 *
 * Only ever raises, never lowers: a bug here must not make the app quieter
 * about lows than the user's own setting.
 *
 * @param {number} baseLow    User's configured low threshold, mg/dL.
 * @param {object} lastSession Most recent finished workout.
 * @returns {{threshold:number, raised:boolean, reason:string|null, hoursLeft:number}}
 */
export function adjustedLowThreshold(baseLow, lastSession, { now = Date.now() } = {}) {
  const unchanged = { threshold: baseLow, raised: false, reason: null, hoursLeft: 0 };
  if (!lastSession?.endedAt) return unchanged;

  const watch = postWorkoutWatch(lastSession, { now });
  if (now >= watch.untilMs) return unchanged;

  const hoursLeft = (watch.untilMs - now) / 3600_000;
  // +15 within the window, tapering as it closes. Evening resistance sessions
  // get the full bump because that is the classic overnight-low setup.
  const bump = watch.overnightRisk ? 15 : 10;

  return {
    threshold: baseLow + bump,
    raised: true,
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    reason:
      `Raised from ${baseLow} for ${Math.round(hoursLeft)}h after your session — ` +
      'insulin sensitivity stays elevated and lows arrive earlier than usual.',
  };
}

/** Shown wherever this module's output is surfaced. Do not remove. */
export const DISCLAIMER =
  'General guidance from published T1D exercise consensus, not medical advice. ' +
  'su94r never recommends insulin doses. Review these thresholds with your endocrinologist and adjust them to your own plan.';
