// ═══════════════════════════════════════════════════════════════════════════
// Live sitting + glucose nudge.
//
// The one feature that needs BOTH streams at once, which is why no general
// fitness app and no CGM app can do it. A step counter knows you have been
// still. A CGM knows you are drifting up. Only something holding both can say
// "you have been sitting 90 minutes and you are 168 and climbing — walk."
//
// Evidence base: interrupting prolonged sitting has its strongest and most
// consistent effect on POST-MEAL glucose, which is exactly when a desk worker
// is least likely to move. Short frequent breaks beat one long walk.
//
// Deliberately conservative about when it speaks. A nudge that fires while you
// are already walking, already low, or in a meeting at 22:00 trains you to
// ignore it, and an ignored alert is worse than no alert.
// ═══════════════════════════════════════════════════════════════════════════

import { toMgdl, fromMgdl } from './safety.js';
import { localHour, resolveTimeZone } from '../util/localDay.js';

export const NUDGE = {
  NONE: 'none',
  MOVE: 'move',           // sitting + glucose drifting up
  STAND: 'stand',         // sitting a long time, glucose fine
  POST_MEAL: 'post-meal', // sitting right after a rise that looks like a meal
};

const DEFAULTS = {
  sitMinutes: 60,        // sitting before we say anything at all
  longSitMinutes: 105,   // sitting long enough to mention on its own
  risingMgdlPerHour: 25, // climb that counts as "drifting up"
  quietStartHour: 21,
  quietEndHour: 7,
  minGapMinutes: 45,     // never nudge twice inside this window
};

/** mg/dL per hour over the trailing window. Null when coverage is too thin. */
export function glucoseSlope(history = [], { unit = 'mgdl', windowMin = 45, now = Date.now() } = {}) {
  const from = now - windowMin * 60_000;
  const pts = history
    .map(r => ({ t: new Date(r.timestamp).getTime(), v: toMgdl(r.value, unit) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t >= from && p.t <= now)
    .sort((a, b) => a.t - b.t);

  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const hours = (last.t - first.t) / 3_600_000;
  if (hours < 0.25) return null;
  return (last.v - first.v) / hours;
}

/**
 * Minutes sat in the current unbroken stretch, from Google Health
 * 'sedentaryMinutes' samples.
 *
 * Samples are intervals, so a gap between them means the user moved — that is
 * what ends a stretch. Summing all of today's samples would report someone as
 * "sitting 7 hours" at 5pm even if they walked every hour, which is useless
 * as a trigger.
 */
export function currentSitStreak(samples = [], { now = Date.now(), gapToleranceMin = 10 } = {}) {
  const rows = samples
    .map(s => ({
      start: new Date(s.recorded_at || s.timestamp).getTime(),
      minutes: Number(s.value),
    }))
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.minutes) && r.minutes > 0)
    .sort((a, b) => b.start - a.start);

  if (!rows.length) return 0;

  const newest = rows[0];
  const newestEnd = newest.start + newest.minutes * 60_000;
  // If the most recent sitting block ended a while ago, they are up now.
  if (now - newestEnd > gapToleranceMin * 60_000) return 0;

  let total = newest.minutes;
  let earliest = newest.start;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rEnd = r.start + r.minutes * 60_000;
    if (earliest - rEnd > gapToleranceMin * 60_000) break; // they moved
    total += r.minutes;
    earliest = r.start;
  }

  return Math.round(total + (now - newestEnd) / 60_000);
}

/**
 * Decides whether to interrupt the user.
 *
 * @returns {{kind:string, title?:string, detail?:string, action?:string, minutes?:number}}
 */
export function evaluateSedentary({
  sedentarySamples = [],
  glucoseHistory = [],
  currentReading = null,
  lastNudgeAt = null,
  unit = 'mgdl',
  lowThreshold = 70,
  config = {},
  timeZone = resolveTimeZone(),
  now = Date.now(),
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const none = { kind: NUDGE.NONE };

  // Local hours, not UTC — otherwise quiet hours land in the evening for
  // anyone off UTC and alerts fire at 4am.
  const hour = localHour(now, timeZone);
  if (hour >= cfg.quietStartHour || hour < cfg.quietEndHour) return none;

  if (lastNudgeAt && now - new Date(lastNudgeAt).getTime() < cfg.minGapMinutes * 60_000) {
    return none;
  }

  const minutes = currentSitStreak(sedentarySamples, { now });
  if (minutes < cfg.sitMinutes) return none;

  const mgdl = currentReading?.value != null ? toMgdl(currentReading.value, unit) : null;

  // Never send someone who is low out for a walk. This check must come before
  // every other branch.
  if (mgdl != null && mgdl < lowThreshold + 20) return none;

  const slope = glucoseSlope(glucoseHistory, { unit, now });
  const rising = slope != null && slope >= cfg.risingMgdlPerHour;

  if (rising && mgdl != null) {
    return {
      kind: NUDGE.MOVE,
      minutes,
      title: 'Sitting and climbing',
      detail:
        `${minutes} minutes without moving, and you are at ${fromMgdl(mgdl, unit)} rising about ` +
        `${Math.round(slope)} ${unit === 'mmol' ? 'mmol/L' : 'mg/dL'} an hour.`,
      action: 'A 5–10 minute walk now blunts the rise more reliably than waiting it out.',
    };
  }

  if (minutes >= cfg.longSitMinutes) {
    return {
      kind: NUDGE.STAND,
      minutes,
      title: 'Time to stand up',
      detail: `${minutes} minutes in the chair.`,
      action: 'Two or three minutes on your feet is enough to break the stretch.',
    };
  }

  return none;
}
