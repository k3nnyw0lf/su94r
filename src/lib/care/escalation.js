// ═══════════════════════════════════════════════════════════════════════════
// Nocturnal hypoglycaemia escalation.
//
// THE PROBLEM THIS EXISTS FOR
//
// Severe low blood glucose during sleep is among the most dangerous events in
// Type 1 diabetes, precisely because the person it is happening to is the one
// least able to act. The whole value of a care circle is that someone else can.
//
// THE CONSTRAINT NOBODY SHOULD PRETEND AWAY
//
// A web app CANNOT guarantee a notification that wakes a sleeping person.
//   • iOS Critical Alerts (bypassing silent/Do Not Disturb) require an Apple
//     entitlement that is not available to web apps at all.
//   • Android notification channels with alarm-level importance are not
//     reachable from the Web Push API.
//
// So push is treated as the FIRST rung, never the only one. Each rung is
// noisier and more intrusive than the last, and the ladder only climbs while
// the situation stays unresolved. A phone call is the final rung because a
// ringing phone is the only channel that reliably penetrates a sleeping
// household — and even that is not a guarantee.
//
// Everything here is pure decision logic. Delivery lives in the Worker.
// ═══════════════════════════════════════════════════════════════════════════

export const RUNG = {
  NONE: 'none',
  SELF: 'self',              // wake the user
  CARE_PUSH: 'care-push',    // push the care circle
  CARE_SMS: 'care-sms',      // SMS the care circle
  CARE_CALL: 'care-call',    // ring them
};

export const RUNG_ORDER = [RUNG.SELF, RUNG.CARE_PUSH, RUNG.CARE_SMS, RUNG.CARE_CALL];

/**
 * Defaults tuned for sleep, where nobody is watching the app.
 *
 * The self-alert window is short because an unacknowledged alert at night most
 * likely means the person is asleep or unable to respond — which is exactly
 * the case the circle exists for. Waiting twenty minutes to tell anyone would
 * defeat the point.
 */
export const DEFAULT_POLICY = {
  lowMgdl: 70,
  severeMgdl: 55,
  nightStartHour: 22,
  nightEndHour: 8,
  selfAckMinutes: 8,          // ack window before involving anyone else
  carePushMinutes: 6,         // then SMS
  careSmsMinutes: 5,          // then call
  severeSkipsToCarePush: true, // a severe low does not wait out the self window
  requireFallingOrFlat: false,
};

import { localHour, resolveTimeZone } from '../util/localDay.js';

const hourIn = (h, start, end) => (start <= end ? h >= start && h < end : h >= start || h < end);

/**
 * Decides what, if anything, should fire right now.
 *
 * @param {object} s
 * @param {object} s.reading        Latest validated CGM reading, mg/dL.
 * @param {number} [s.lowSince]     ms timestamp the low began.
 * @param {boolean} [s.acknowledged] User has acknowledged this episode.
 * @param {string} [s.highestRungFired]
 * @param {number} [s.lastRungAt]
 * @param {number} [s.circleSize]   Consenting caregivers available.
 * @param {object} [s.policy]
 * @param {number} [s.now]
 */
export function evaluateEscalation({
  reading,
  lowSince = null,
  acknowledged = false,
  highestRungFired = RUNG.NONE,
  lastRungAt = null,
  circleSize = 0,
  policy = {},
  timeZone = resolveTimeZone(),
  now = Date.now(),
} = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const idle = { rung: RUNG.NONE, reason: null, severe: false };

  // Number(null) is 0, which is finite — so a missing reading would otherwise
  // be treated as a glucose of zero and fire a "severe low" for entirely the
  // wrong reason. Absence must be detected before coercion.
  const raw = reading?.value;
  const mgdl = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(mgdl)) {
    // A feed that has gone silent during a known low is itself an emergency —
    // it is indistinguishable from a sensor lost while unconscious.
    if (lowSince && !acknowledged && now - lowSince > p.selfAckMinutes * 60_000) {
      return {
        rung: nextRung(highestRungFired, circleSize),
        reason: 'Glucose was low and the sensor has stopped reporting.',
        severe: true,
        dataGap: true,
      };
    }
    return idle;
  }

  if (mgdl >= p.lowMgdl) return { ...idle, resolved: true };

  const severe = mgdl < p.severeMgdl;
  const startedAt = lowSince || now;
  const lowForMin = (now - startedAt) / 60_000;
  // Local hours. A UTC night window would escalate to a phone call in the
  // afternoon and stay silent at 3am for anyone not on UTC.
  const night = hourIn(localHour(now, timeZone), p.nightStartHour, p.nightEndHour);

  // Acknowledging means the user is awake and treating it. Stop climbing.
  // A severe low still notifies the circle once, because people do pass out
  // partway through treating a hypo.
  if (acknowledged && !severe) return { ...idle, acknowledged: true };

  const target = targetRung({ severe, lowForMin, night, p, circleSize, highestRungFired });
  if (target === RUNG.NONE) return idle;

  // Rungs already climbed do not re-fire; the ladder only goes up.
  if (rungIndex(target) <= rungIndex(highestRungFired)) return idle;

  // Minimum spacing so a flapping sensor cannot machine-gun a partner at 3am.
  if (lastRungAt && now - lastRungAt < 60_000) return idle;

  return {
    rung: target,
    severe,
    night,
    lowForMin: Math.round(lowForMin),
    reason: severe
      ? `Severe low: ${Math.round(mgdl)} mg/dL`
      : `Low for ${Math.round(lowForMin)} min: ${Math.round(mgdl)} mg/dL`,
  };
}

function rungIndex(r) {
  const i = RUNG_ORDER.indexOf(r);
  return i === -1 ? -1 : i;
}

function nextRung(highest, circleSize) {
  const i = rungIndex(highest);
  const next = RUNG_ORDER[i + 1];
  if (!next) return RUNG_ORDER[RUNG_ORDER.length - 1];
  // Without a consenting caregiver there is nobody to escalate to; keep
  // alerting the user rather than pretending an alert went somewhere.
  if (next !== RUNG.SELF && circleSize === 0) return RUNG.SELF;
  return next;
}

function targetRung({ severe, lowForMin, night, p, circleSize, highestRungFired }) {
  if (rungIndex(highestRungFired) < rungIndex(RUNG.SELF)) return RUNG.SELF;
  if (circleSize === 0) return RUNG.NONE;

  const elapsedFor = rung => {
    switch (rung) {
      case RUNG.CARE_PUSH:
        return severe && p.severeSkipsToCarePush ? 0 : p.selfAckMinutes;
      case RUNG.CARE_SMS:
        return (severe ? 0 : p.selfAckMinutes) + p.carePushMinutes;
      case RUNG.CARE_CALL:
        return (severe ? 0 : p.selfAckMinutes) + p.carePushMinutes + p.careSmsMinutes;
      default:
        return Infinity;
    }
  };

  // At night the ladder is climbed; during the day the user is usually able to
  // act, and waking a partner over a daytime low they will treat themselves is
  // how people switch the feature off.
  const rungs = night || severe
    ? [RUNG.CARE_CALL, RUNG.CARE_SMS, RUNG.CARE_PUSH]
    : [RUNG.CARE_PUSH];

  for (const rung of rungs) {
    if (lowForMin >= elapsedFor(rung)) return rung;
  }
  return RUNG.NONE;
}

/** Message for a given rung. Plain, actionable, no jargon at 3am. */
export function alertPayload(decision, { name = 'Your partner', unit = 'mgdl' } = {}) {
  const u = unit === 'mmol' ? 'mmol/L' : 'mg/dL';
  const urgent = decision.severe || decision.rung === RUNG.CARE_CALL;

  if (decision.rung === RUNG.SELF) {
    return {
      title: decision.severe ? 'Severe low' : 'Low glucose',
      body: `${decision.reason}. Treat now and tap to acknowledge.`,
      urgency: urgent ? 'critical' : 'high',
      requireInteraction: true,
    };
  }

  return {
    title: urgent ? `${name} needs help now` : `${name} is low`,
    body:
      `${decision.reason}.` +
      (decision.dataGap ? ' The sensor has stopped reporting.' : '') +
      (decision.acknowledged ? '' : ' They have not acknowledged the alert.') +
      ' Check on them.',
    urgency: urgent ? 'critical' : 'high',
    requireInteraction: true,
  };
}

export const ESCALATION_LIMITS =
  'Web push cannot bypass silent mode or Do Not Disturb — iOS Critical Alerts ' +
  'need an entitlement web apps cannot obtain, and Android alarm channels are ' +
  'not reachable from web push. Treat push as a best effort, keep SMS and call ' +
  'rungs enabled for night-time cover, and do not rely on this app as the only ' +
  'safeguard against severe nocturnal hypoglycaemia.';
