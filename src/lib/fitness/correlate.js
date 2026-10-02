// ═══════════════════════════════════════════════════════════════════════════
// Glucose ↔ exercise correlation.
//
// su94r already streams CGM data and now logs workouts. Joining the two is the
// thing a generic fitness app structurally cannot do: it turns "resistance work
// tends to raise glucose" into "YOUR resistance sessions raise you a median of
// 34 mg/dL, and three of your last five evening sessions were followed by an
// overnight low."
//
// Everything here is pure. Feed it sessions + readings, get analysis back.
// ═══════════════════════════════════════════════════════════════════════════

import { toMgdl } from './safety.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Readings whose timestamp falls in [from, to], oldest first. */
function readingsBetween(history, from, to, unit) {
  return history
    .map(r => ({ ...r, t: new Date(r.timestamp).getTime(), mgdl: toMgdl(r.value, unit) }))
    .filter(r => Number.isFinite(r.t) && r.t >= from && r.t <= to && Number.isFinite(r.mgdl))
    .sort((a, b) => a.t - b.t);
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Analyses a single session against the glucose history.
 * Returns null when there isn't enough data on either side of the session.
 *
 * @param {object} session  { startedAt, endedAt, modality }
 * @param {Array}  history  Store's glucose.history
 * @param {object} opts     { unit, lowThreshold }
 */
export function analyzeSession(session, history, opts = {}) {
  const { unit = 'mgdl', lowThreshold = 70 } = opts;
  if (!session?.startedAt || !session?.endedAt) return null;

  const start = new Date(session.startedAt).getTime();
  const end = new Date(session.endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const during = readingsBetween(history, start, end, unit);
  const after = readingsBetween(history, end, end + 2 * HOUR, unit);
  const overnight = readingsBetween(history, end, end + 12 * HOUR, unit);

  if (!during.length && !after.length) return null;

  const startVal = during[0]?.mgdl ?? null;
  const endVal = during[during.length - 1]?.mgdl ?? after[0]?.mgdl ?? null;
  const duringMin = during.length ? Math.min(...during.map(r => r.mgdl)) : null;
  const afterMin = after.length ? Math.min(...after.map(r => r.mgdl)) : null;

  return {
    sessionId: session.id,
    modality: session.modality || 'resistance',
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMin: Math.round((end - start) / MIN),
    endedHour: new Date(end).getHours(),
    startGlucose: startVal,
    endGlucose: endVal,
    deltaDuring: startVal != null && endVal != null ? Math.round(endVal - startVal) : null,
    delta2h:
      startVal != null && after.length
        ? Math.round(after[after.length - 1].mgdl - startVal)
        : null,
    minDuring: duringMin,
    minAfter2h: afterMin,
    hypoDuring: duringMin != null && duringMin < lowThreshold,
    hypoAfter2h: afterMin != null && afterMin < lowThreshold,
    hypoOvernight:
      overnight.length > 0 && Math.min(...overnight.map(r => r.mgdl)) < lowThreshold,
    coverage: { during: during.length, after: after.length },
  };
}

/** Analyses every session that has usable glucose coverage. */
export function analyzeAll(sessions = [], history = [], opts = {}) {
  return sessions.map(s => analyzeSession(s, history, opts)).filter(Boolean);
}

/**
 * Rolls per-session analyses up into the user's own measured response,
 * grouped by modality.
 *
 * `confident` gates whether the UI shows this instead of the generic
 * population tendency. Below the threshold we don't have enough signal and
 * shouldn't pretend otherwise.
 */
export const MIN_SESSIONS_FOR_CONFIDENCE = 4;

export function summarizeByModality(analyses) {
  const groups = {};
  for (const a of analyses) {
    (groups[a.modality] ||= []).push(a);
  }

  return Object.entries(groups).map(([modality, items]) => {
    const deltas = items.map(i => i.deltaDuring).filter(v => v != null);
    const deltas2h = items.map(i => i.delta2h).filter(v => v != null);
    const hypoCount = items.filter(i => i.hypoDuring || i.hypoAfter2h).length;
    const evening = items.filter(i => i.endedHour >= 16);
    const eveningOvernightHypo = evening.filter(i => i.hypoOvernight).length;

    return {
      modality,
      sessions: items.length,
      confident: items.length >= MIN_SESSIONS_FOR_CONFIDENCE,
      medianDeltaDuring: median(deltas),
      medianDelta2h: median(deltas2h),
      hypoRate: items.length ? hypoCount / items.length : 0,
      eveningSessions: evening.length,
      eveningOvernightHypoRate: evening.length ? eveningOvernightHypo / evening.length : 0,
    };
  });
}

/**
 * Turns the summary into plain statements for the Fitness page and for the
 * ActivityCoach agent's prompt context.
 *
 * These describe what happened. They deliberately stop short of prescribing —
 * see the scope note in safety.js.
 */
export function insights(summaries, opts = {}) {
  const { unit = 'mgdl' } = opts;
  const fmt = v => (unit === 'mmol' ? `${(v / 18).toFixed(1)} mmol/L` : `${Math.round(v)} mg/dL`);
  const signed = v => (v > 0 ? `+${fmt(v)}` : `−${fmt(Math.abs(v))}`);
  const out = [];

  for (const s of summaries) {
    if (!s.confident) {
      out.push({
        level: 'info',
        text: `Only ${s.sessions} ${s.modality} session${s.sessions === 1 ? '' : 's'} logged with glucose coverage. Need ${MIN_SESSIONS_FOR_CONFIDENCE} before su94r will report your own pattern.`,
      });
      continue;
    }

    if (s.medianDeltaDuring != null) {
      out.push({
        level: 'info',
        text: `Your ${s.modality} sessions move glucose a median of ${signed(s.medianDeltaDuring)} from start to finish, across ${s.sessions} sessions.`,
      });
    }

    if (s.hypoRate >= 0.3) {
      out.push({
        level: 'warn',
        text: `${Math.round(s.hypoRate * 100)}% of your ${s.modality} sessions ended in or were followed by a low within 2 hours. Worth raising with your endocrinologist.`,
      });
    }

    if (s.eveningSessions >= 3 && s.eveningOvernightHypoRate >= 0.3) {
      out.push({
        level: 'warn',
        text: `${Math.round(s.eveningOvernightHypoRate * 100)}% of your evening ${s.modality} sessions were followed by an overnight low. This is the most common delayed-hypo pattern in T1D.`,
      });
    }
  }

  return out;
}

/**
 * Compact factual context for the ActivityCoach agent, so it stops giving
 * textbook advice and reasons about actual measured response.
 * Returns null when there is nothing trustworthy to say.
 */
export function coachContext(summaries, opts = {}) {
  const confident = summaries.filter(s => s.confident);
  if (!confident.length) return null;
  const { unit = 'mgdl' } = opts;
  const fmt = v => (unit === 'mmol' ? (v / 18).toFixed(1) : Math.round(v));

  const lines = confident.map(s =>
    `- ${s.modality}: ${s.sessions} sessions, median change during session ${s.medianDeltaDuring > 0 ? '+' : ''}${fmt(s.medianDeltaDuring)}, ` +
    `low within 2h in ${Math.round(s.hypoRate * 100)}% of sessions` +
    (s.eveningSessions >= 3
      ? `, overnight low after ${Math.round(s.eveningOvernightHypoRate * 100)}% of evening sessions`
      : '')
  );

  return `This user's own measured exercise response (units: ${unit}):\n${lines.join('\n')}`;
}
