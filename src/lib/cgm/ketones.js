// ═══════════════════════════════════════════════════════════════════════════
// Ketones, DKA risk, and sick-day mode.
//
// THE GAP THIS CLOSES
//
// A Libre measures glucose and nothing else. Diabetic ketoacidosis is driven by
// ketones, not by glucose — and it can develop at glucose levels that look
// merely "a bit high", especially on SGLT2 inhibitors (euglycaemic DKA). su94r
// could see a 280 and say nothing useful about the one thing that actually
// kills people quickly.
//
// This module cannot measure ketones. Nothing in this app can. What it does is
// notice the situations where they must be measured, ask, and then interpret
// the answer against published thresholds.
//
// SCOPE
//
// Same line as everywhere else: fluids, ketone testing, and when to seek help.
// Never an insulin dose, never a correction factor. Sick-day insulin adjustment
// is a clinical plan agreed in advance with a care team, and this module's job
// is to tell someone to follow theirs — not to invent one.
//
// Thresholds are the widely published blood-ketone (BOHB) bands in mmol/L.
// ═══════════════════════════════════════════════════════════════════════════

export const KETONE_LEVEL = {
  NEGATIVE: 'negative',
  TRACE: 'trace',
  MODERATE: 'moderate',
  HIGH: 'high',
};

/**
 * Blood ketone bands, mmol/L. Urine strips lag blood by hours and are far less
 * useful in an emergency, which the UI states when a urine reading is logged.
 */
export const KETONE_BANDS = [
  { level: KETONE_LEVEL.NEGATIVE, max: 0.6, label: 'Negative / normal' },
  { level: KETONE_LEVEL.TRACE, max: 1.5, label: 'Trace to small' },
  { level: KETONE_LEVEL.MODERATE, max: 3.0, label: 'Moderate' },
  { level: KETONE_LEVEL.HIGH, max: Infinity, label: 'High' },
];

/** Named distinctly: outcomes.js also exports a bandFor, for carbohydrate. */
export const ketoneBandFor = mmol =>
  KETONE_BANDS.find(b => Number(mmol) < b.max) || KETONE_BANDS[KETONE_BANDS.length - 1];

/** Sustained hyperglycaemia that should prompt a ketone check, mg/dL. */
export const KETONE_CHECK_THRESHOLD = 250;
const SUSTAINED_MINUTES = 120;

/**
 * Decides whether the user should be asked to test for ketones.
 *
 * Triggers on sustained high glucose, on illness being flagged, and — the case
 * people miss — on a pump user whose glucose is climbing despite a correction,
 * which is the signature of a failed infusion set.
 */
export function shouldCheckKetones({
  history = [],
  unit = 'mgdl',
  sickDay = false,
  lastKetoneAt = null,
  now = Date.now(),
  threshold = KETONE_CHECK_THRESHOLD,
} = {}) {
  const toMg = v => (unit === 'mmol' ? v * 18 : v);
  const recent = history
    .map(r => ({ t: new Date(r.timestamp).getTime(), v: toMg(Number(r.value)) }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v) && now - r.t <= SUSTAINED_MINUTES * 60_000)
    .sort((a, b) => a.t - b.t);

  // A ketone test is only useful so often; asking hourly trains people to say no.
  const recentlyTested = lastKetoneAt && now - new Date(lastKetoneAt).getTime() < 3 * 3_600_000;
  if (recentlyTested) return { check: false, reason: 'tested recently' };

  if (sickDay && recent.length && recent[recent.length - 1].v > 180) {
    return {
      check: true,
      urgency: 'routine',
      reason: 'You have marked yourself unwell and are running high.',
      guidance: 'Illness raises ketone risk even at modest glucose levels. Test every 4 hours while unwell.',
    };
  }

  if (recent.length < 3) return { check: false, reason: 'not enough recent data' };

  const allHigh = recent.every(r => r.v >= threshold);
  const spanMin = (recent[recent.length - 1].t - recent[0].t) / 60_000;

  if (allHigh && spanMin >= SUSTAINED_MINUTES - 20) {
    return {
      check: true,
      urgency: 'prompt',
      reason: `Above ${unit === 'mmol' ? (threshold / 18).toFixed(1) : threshold} for about ${Math.round(spanMin)} minutes.`,
      guidance: 'Sustained high glucose is when ketones build. Test now.',
    };
  }

  // Climbing despite time passing suggests insulin is not getting in — a bent
  // cannula, an air bubble, or degraded insulin.
  const climbing = recent[recent.length - 1].v - recent[0].v > 60 && recent[recent.length - 1].v > 200;
  if (climbing) {
    return {
      check: true,
      urgency: 'prompt',
      reason: 'Glucose is climbing steadily and is already high.',
      guidance:
        'If you use a pump, this pattern can mean insulin is not being delivered — check the site and consider an injection by pen per your care plan. Test ketones now.',
    };
  }

  return { check: false, reason: 'no trigger' };
}

/**
 * Interprets a logged ketone reading against glucose.
 *
 * The combination matters more than either number. High ketones WITH high
 * glucose is developing DKA. High ketones with normal glucose can still be DKA
 * on an SGLT2 inhibitor, and is the presentation most often missed.
 */
export function assessKetones({ ketonesMmol, glucoseMgdl = null, sickDay = false } = {}) {
  const k = Number(ketonesMmol);
  if (!Number.isFinite(k)) return null;

  const band = ketoneBandFor(k);
  const high = glucoseMgdl != null && glucoseMgdl > 250;
  const euglycaemic = glucoseMgdl != null && glucoseMgdl < 200;

  if (band.level === KETONE_LEVEL.HIGH) {
    return {
      band, emergency: true, tone: 'emergency',
      title: 'Seek urgent medical help now',
      detail: `Blood ketones ${k} mmol/L. This is the range where diabetic ketoacidosis develops.`,
      actions: [
        'Contact your diabetes team or emergency services now. Do not wait to see if it improves.',
        'Keep drinking water if you are able to.',
        'Follow the sick-day insulin plan agreed with your team — su94r does not calculate doses.',
        'Do not exercise.',
      ],
    };
  }

  if (band.level === KETONE_LEVEL.MODERATE) {
    return {
      band, emergency: true, tone: 'urgent',
      title: 'Call your diabetes team',
      detail:
        `Blood ketones ${k} mmol/L${high ? ' with high glucose' : ''}. This can progress to DKA within hours.` +
        (euglycaemic ? ' Note that ketones this high with near-normal glucose still matter, particularly on an SGLT2 inhibitor.' : ''),
      actions: [
        'Contact your diabetes team today.',
        'Follow your agreed sick-day plan.',
        'Fluids: water steadily, and carbohydrate-containing drinks if glucose is not high.',
        'Re-test ketones in 2 hours.',
        'Do not exercise.',
      ],
    };
  }

  if (band.level === KETONE_LEVEL.TRACE) {
    return {
      band, emergency: false, tone: 'caution',
      title: 'Trace ketones',
      detail: `Blood ketones ${k} mmol/L. Not an emergency, but worth acting on before it climbs.`,
      actions: [
        'Drink water steadily.',
        'Follow your sick-day plan if you have one.',
        'Re-test in 2 hours, sooner if you feel worse.',
        'Avoid exercise until this clears — it can push ketones higher.',
      ],
    };
  }

  return {
    band, emergency: false, tone: 'ok',
    title: 'Ketones negative',
    detail: `Blood ketones ${k} mmol/L.`,
    actions: sickDay ? ['Keep testing every 4 hours while you are unwell.'] : [],
  };
}

// ─── Sick-day mode ──────────────────────────────────────────────────────────

/**
 * Illness changes almost every assumption in this app: insulin resistance
 * rises, glucose runs high on the same doses, ketone risk climbs, and exercise
 * becomes actively unsafe rather than merely inadvisable.
 *
 * Turning it on adjusts the app's behaviour and, importantly, MARKS the data —
 * so a fortnight of flu does not silently drag the training-versus-rest
 * comparison and make someone think their programme stopped working.
 */
export function sickDayState({ enabled = false, startedAt = null, now = Date.now() } = {}) {
  if (!enabled) return { active: false };

  const hours = startedAt ? (now - new Date(startedAt).getTime()) / 3_600_000 : 0;
  return {
    active: true,
    startedAt,
    hours: Math.round(hours),
    // Every one of these is a behaviour change elsewhere in the app.
    effects: {
      suppressWorkoutPrompts: true,
      suppressSedentaryNudges: true,
      suppressLeaderboard: true,
      excludeFromAnalytics: true,
      ketoneReminderHours: 4,
      raiseHighAlertSensitivity: true,
    },
    guidance: [
      'Never stop your basal insulin, even if you cannot eat. Stopping it is the fastest route to DKA.',
      'Test ketones every 4 hours, and any time glucose goes above target.',
      'Sip fluids constantly. Carbohydrate-containing drinks if glucose is not high, water if it is.',
      'Do not exercise.',
      'Follow the sick-day plan agreed with your team — su94r will not calculate dose changes.',
    ],
    escalate:
      'Seek urgent help if you cannot keep fluids down, are vomiting repeatedly, are breathless, ' +
      'confused, or ketones stay above 1.5 mmol/L despite following your plan.',
  };
}

/** Days marked sick, so analytics can exclude them rather than be skewed. */
export function sickDays(episodes = []) {
  const out = new Set();
  for (const e of episodes) {
    const from = new Date(e.startedAt).getTime();
    const to = e.endedAt ? new Date(e.endedAt).getTime() : from;
    if (!Number.isFinite(from)) continue;
    for (let t = from; t <= to; t += 86_400_000) {
      out.add(new Date(t).toISOString().slice(0, 10));
    }
  }
  return out;
}

export const KETONE_DISCLAIMER =
  'su94r cannot measure ketones — a Libre reads glucose only. It notices when ' +
  'you should test and interprets what you enter against published thresholds. ' +
  'It never calculates insulin: sick-day dose changes are the plan you agree ' +
  'with your care team in advance.';
