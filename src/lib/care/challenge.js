// ═══════════════════════════════════════════════════════════════════════════
// Friendly competition inside the care circle.
//
// WHAT MAY BE COMPETED ON, AND WHAT MAY NOT
//
// Activity — calories, steps, active minutes, sessions. These are things a
// person chooses to do, and a nudge to do more of them is benign.
//
// Glucose is NEVER a leaderboard metric. Not time in range, not average, not
// GMI, not hypo count. Two reasons, and both matter more than the feature:
//
//   1. Glucose is not effort. It is affected by illness, hormones, sensor
//      accuracy, sleep and stress. Scoring someone on it means scoring them on
//      luck, and losing at your own disease is demoralising in a way that
//      losing at step count is not.
//
//   2. Ranking people on time in range creates pressure to run high to avoid
//      lows, or to under-treat lows to protect a number. Both are dangerous,
//      and both are entirely predictable responses to a scoreboard.
//
// The same logic drives the rest-day rule below. su94r's whole design is a gate
// willing to say no; a streak that punishes rest would argue with it.
// ═══════════════════════════════════════════════════════════════════════════

/** Metrics eligible for competition. Activity only, by design. */
export const CHALLENGE_METRICS = {
  activeEnergy: { label: 'Active calories', unit: 'kcal', sampleType: 'activeEnergy' },
  steps: { label: 'Steps', unit: '', sampleType: 'steps' },
  exerciseMinutes: { label: 'Active minutes', unit: 'min', sampleType: 'exerciseMinutes' },
  sessions: { label: 'Workouts logged', unit: '', sampleType: null },
};

/**
 * Metrics that must never be ranked. Exported so the UI can assert against it
 * and any future contributor sees the intent rather than guessing.
 */
export const FORBIDDEN_METRICS = ['tir', 'glucose', 'meanGlucose', 'gmi', 'a1c', 'hypos', 'cv', 'timeInRange'];

export function assertCompetable(metric) {
  if (FORBIDDEN_METRICS.includes(metric)) {
    throw new Error(
      `"${metric}" is a health outcome, not an effort metric, and su94r does not rank people on it.`
    );
  }
  if (!CHALLENGE_METRICS[metric]) throw new Error(`Unknown challenge metric: ${metric}`);
  return true;
}

/**
 * Window boundaries use the runtime's local timezone via setHours, which is
 * correct in a browser — it is the user's own clock. Kept explicit here because
 * every other day-boundary in the app had to be moved off UTC, and a future
 * reader should not "fix" this one back.
 */
function windowStart(period, now) {
  const d = new Date(now);
  if (period === 'today') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  // Week starts Monday.
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Totals one member's metric over the period.
 *
 * @param {Array} samples  health_samples rows for that member.
 * @param {Array} workouts
 */
export function memberTotal(metric, { samples = [], workouts = [] }, { period = 'today', now = Date.now() } = {}) {
  assertCompetable(metric);
  const from = windowStart(period, now);

  if (metric === 'sessions') {
    return workouts.filter(w => new Date(w.startedAt).getTime() >= from).length;
  }

  const type = CHALLENGE_METRICS[metric].sampleType;
  return Math.round(
    samples
      .filter(s => s.type === type && new Date(s.recorded_at || s.timestamp).getTime() >= from)
      .reduce((n, s) => n + (Number(s.value) || 0), 0)
  );
}

/**
 * Builds the leaderboard.
 *
 * @param {Array} members [{ email, name, samples, workouts, restDay }]
 */
export function leaderboard(metric, members = [], opts = {}) {
  assertCompetable(metric);
  const { period = 'today', now = Date.now() } = opts;

  const rows = members
    .map(m => ({
      email: m.email,
      name: m.name || m.email,
      // A prescribed rest day is not a loss. Marked so the UI can present it
      // as "resting" rather than last place — the training plan schedules rest
      // deliberately and the scoreboard should not argue with it.
      restDay: !!m.restDay,
      total: memberTotal(metric, m, { period, now }),
    }))
    .sort((a, b) => b.total - a.total);

  const competing = rows.filter(r => !r.restDay);
  const leader = competing[0] || null;

  return {
    metric,
    label: CHALLENGE_METRICS[metric].label,
    unit: CHALLENGE_METRICS[metric].unit,
    period,
    periodLabel: period === 'today' ? 'Today' : 'This week',
    rows: rows.map((r, i) => ({
      ...r,
      rank: r.restDay ? null : competing.indexOf(r) + 1,
      behindLeader: leader && !r.restDay ? Math.max(0, leader.total - r.total) : null,
    })),
    leader,
    // Nothing to crow about with one participant.
    contested: competing.length >= 2,
  };
}

/**
 * One line of banter. Deliberately gentle — teasing about effort is fine,
 * and nobody should feel bad for a rest day or a bad glucose week.
 */
export function summaryLine(board, viewerEmail) {
  if (!board.contested) return `${board.periodLabel.toLowerCase()}: no one else to compare with yet.`;

  const me = board.rows.find(r => r.email === viewerEmail);
  const unit = board.unit ? ` ${board.unit}` : '';

  if (me?.restDay) return `Rest day — you are sitting this one out. ${board.leader.name} leads on ${board.label.toLowerCase()}.`;
  if (!me) return `${board.leader.name} leads with ${board.leader.total}${unit}.`;

  if (me.rank === 1) {
    const second = board.rows.find(r => r.rank === 2);
    return second
      ? `You lead by ${me.total - second.total}${unit}.`
      : `You lead on ${board.label.toLowerCase()}.`;
  }

  return `${board.leader.name} is ahead by ${me.behindLeader}${unit}.`;
}

export const CHALLENGE_NOTE =
  'Competition covers activity only. su94r never ranks anyone on glucose, time ' +
  'in range or A1c — those depend on illness, hormones and sensor accuracy as ' +
  'much as effort, and turning them into a scoreboard pushes people to run high ' +
  'or under-treat lows. Rest days are shown as resting, not as losing.';
