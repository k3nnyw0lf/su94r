// ═══════════════════════════════════════════════════════════════════════════
// Progress tracking and the avatar.
//
// WHY THE AVATAR IS SCHEMATIC AND NOT A GENERATED PHOTO
//
// It would be trivial to generate a picture of a slimmer version of someone.
// It would also be a lie — an invented image presented next to real data, which
// is exactly how people end up trusting a number that was never measured. The
// avatar here is a diagram whose every property is driven by something actually
// recorded: posture markers from a scan, composition from the scale.
//
// THE ORDERING PROBLEM THIS SOLVES
//
// Scale weight is the WORST early progress metric and the one everybody checks.
// In the first two months of resistance training weight often barely moves
// while muscle rises and fat falls underneath it. Someone judging themselves on
// the scale during exactly the period their body is changing most will conclude
// it is not working and stop.
//
// So progressNarrative() deliberately reports strength first, composition
// second, and scale weight last — because that is the order in which they
// actually respond, not the order people look at them.
//
// PHOTOS: posture SCAN RESULTS are stored. The photographs are not. If a
// progress album is ever added it must be opt-in and local-only — see
// postureScan.js, which promises photos are never stored, and that promise is
// not negotiable here.
// ═══════════════════════════════════════════════════════════════════════════

import { POSTURE_MARKERS } from '../fitness/postureScan.js';

const DAY = 86_400_000;
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Averages a metric series over a window, so one odd weigh-in cannot swing it. */
function windowAverage(samples = [], type, { at = Date.now(), windowDays = 7 } = {}) {
  const from = at - windowDays * DAY;
  const vals = samples
    .filter(s => s.type === type)
    .map(s => ({ t: new Date(s.recorded_at || s.timestamp).getTime(), v: Number(s.value) }))
    .filter(s => Number.isFinite(s.t) && Number.isFinite(s.v) && s.t >= from && s.t <= at)
    .map(s => s.v);
  return vals.length ? mean(vals) : null;
}

/**
 * A strength index from logged sets.
 *
 * Deliberately crude — total volume (sets x reps x load) across resistance
 * sessions. It is not a 1RM estimate and does not pretend to be. Its value is
 * that it moves within DAYS of starting, long before anything visible changes,
 * which makes it the honest thing to show someone in week three.
 *
 * Bodyweight work counts as load 1 so it still registers progression by reps.
 */
export function strengthIndex(workouts = [], { at = Date.now(), windowDays = 14 } = {}) {
  const from = at - windowDays * DAY;
  let volume = 0;
  let sessions = 0;

  for (const w of workouts) {
    const t = new Date(w.startedAt).getTime();
    if (!Number.isFinite(t) || t < from || t > at) continue;
    if (w.modality !== 'resistance') continue;
    sessions++;
    for (const sets of Object.values(w.completed || {})) {
      for (const s of sets) {
        const reps = Number(s.reps) || 10;
        const load = Number(s.weight) || 1;
        volume += reps * load;
      }
    }
  }

  return { volume: Math.round(volume), sessions, perSession: sessions ? Math.round(volume / sessions) : 0 };
}

/** Point-in-time snapshot across every stream su94r holds. */
export function snapshot({ samples = [], workouts = [], postureScans = [], at = Date.now() } = {}) {
  const latestScan = [...postureScans]
    .filter(s => new Date(s.assessedAt).getTime() <= at)
    .sort((a, b) => new Date(b.assessedAt) - new Date(a.assessedAt))[0] || null;

  return {
    at,
    weightKg: windowAverage(samples, 'bodyMass', { at }),
    bodyFatPct: windowAverage(samples, 'bodyFatPercentage', { at }),
    muscleKg: windowAverage(samples, 'muscleMass', { at }),
    visceralFat: windowAverage(samples, 'visceralFat', { at }),
    strength: strengthIndex(workouts, { at }),
    posture: latestScan
      ? { assessedAt: latestScan.assessedAt, markers: latestScan.findings?.map(f => f.key) || [] }
      : null,
  };
}

/** Change between two snapshots, with direction interpreted per metric. */
export function compare(now, before) {
  const delta = (a, b) => (a != null && b != null ? a - b : null);
  const fatKgNow = now.weightKg != null && now.bodyFatPct != null ? (now.weightKg * now.bodyFatPct) / 100 : null;
  const fatKgBefore = before.weightKg != null && before.bodyFatPct != null
    ? (before.weightKg * before.bodyFatPct) / 100 : null;

  return {
    days: Math.round((now.at - before.at) / DAY),
    weightKg: delta(now.weightKg, before.weightKg),
    bodyFatPct: delta(now.bodyFatPct, before.bodyFatPct),
    muscleKg: delta(now.muscleKg, before.muscleKg),
    // The number that shows recomposition: fat mass can fall while scale weight
    // holds, and that is a success the scale alone reports as failure.
    fatMassKg: delta(fatKgNow, fatKgBefore),
    visceralFat: delta(now.visceralFat, before.visceralFat),
    strengthVolume: delta(now.strength?.volume, before.strength?.volume),
    posturesResolved: before.posture && now.posture
      ? before.posture.markers.filter(m => !now.posture.markers.includes(m))
      : [],
    posturesNew: before.posture && now.posture
      ? now.posture.markers.filter(m => !before.posture.markers.includes(m))
      : [],
  };
}

/**
 * What actually changed, ordered by how early each metric responds rather than
 * how much attention it usually gets. Strength first, scale weight last.
 */
export function progressNarrative(diff, { weightUnit = 'kg' } = {}) {
  const out = [];
  const w = v => (weightUnit === 'lbs' ? `${(Math.abs(v) * 2.20462).toFixed(1)} lb` : `${Math.abs(v).toFixed(1)} kg`);

  if (diff.strengthVolume > 0) {
    out.push({
      tone: 'good',
      metric: 'strength',
      text: `Training volume is up ${Math.round(diff.strengthVolume).toLocaleString()} over ${diff.days} days. This moves first — before anything is visible.`,
    });
  }

  if (diff.posturesResolved.length) {
    const names = diff.posturesResolved.map(k => POSTURE_MARKERS[k]?.label || k);
    out.push({ tone: 'good', metric: 'posture', text: `No longer showing: ${names.join(', ')}.` });
  }

  if (diff.muscleKg > 0.3) {
    out.push({ tone: 'good', metric: 'muscle', text: `Muscle mass up ${w(diff.muscleKg)}.` });
  }

  if (diff.fatMassKg < -0.3) {
    out.push({ tone: 'good', metric: 'fat', text: `Fat mass down ${w(diff.fatMassKg)}.` });
  }

  if (diff.visceralFat < -0.4) {
    out.push({
      tone: 'good',
      metric: 'visceral',
      text: 'Visceral fat down — the measure that tracks insulin resistance more closely than BMI.',
    });
  }

  // Scale weight last, and only with context. Flat weight alongside rising
  // muscle and falling fat is the textbook picture of it working.
  if (diff.weightKg != null) {
    const recomposing = diff.muscleKg > 0.2 && diff.fatMassKg < -0.2;
    if (Math.abs(diff.weightKg) < 0.5 && recomposing) {
      out.push({
        tone: 'good',
        metric: 'weight',
        text: 'Scale weight is flat while muscle rose and fat fell. That is the change working, not stalling.',
      });
    } else if (diff.weightKg < 0) {
      out.push({ tone: 'good', metric: 'weight', text: `Weight down ${w(diff.weightKg)}.` });
    } else if (diff.weightKg > 0.5 && diff.muscleKg > 0.2) {
      out.push({ tone: 'neutral', metric: 'weight', text: `Weight up ${w(diff.weightKg)}, but muscle accounts for part of it.` });
    }
  }

  if (diff.posturesNew.length) {
    const names = diff.posturesNew.map(k => POSTURE_MARKERS[k]?.label || k);
    out.push({ tone: 'watch', metric: 'posture', text: `Newly showing: ${names.join(', ')}.` });
  }

  if (!out.length) {
    out.push({
      tone: 'neutral',
      metric: 'none',
      text: 'Not enough logged yet to show a change. Strength volume is usually the first thing to move.',
    });
  }

  return out;
}

// ─── Avatar ─────────────────────────────────────────────────────────────────

/**
 * Avatar parameters, every one derived from measured data.
 *
 * Posture drives the figure's alignment. Composition drives only a mild torso
 * width, and is deliberately understated — a diagram that visibly exaggerates
 * someone's body is a body-image problem, not a progress tracker.
 */
export function avatarState(snap) {
  const markers = new Set(snap?.posture?.markers || []);
  const bf = snap?.bodyFatPct;

  return {
    headOffset: markers.has('forwardHead') ? 8 : 0,
    shoulderRound: markers.has('roundedShoulders') ? 7 : 0,
    pelvicTilt: markers.has('anteriorPelvicTilt') ? 8 : 0,
    lateralShift: markers.has('lateralShift') ? 4 : 0,
    thoracic: markers.has('thoracicStiffness') ? 5 : 0,
    // Narrow band on purpose. 15% and 35% body fat differ by six pixels here.
    torsoWidth: bf == null ? 26 : Math.max(22, Math.min(34, 22 + (bf - 12) * 0.32)),
    hasData: !!snap?.posture || bf != null,
    markerCount: markers.size,
  };
}

/**
 * Renders the avatar as an inline SVG string.
 *
 * Two figures can be rendered side by side to show change over time, which is
 * the actual point — a single figure tells you nothing.
 */
export function renderAvatarSvg(state, { accent = '#06b6d4', muted = '#64748b', label = '' } = {}) {
  const { headOffset: h, shoulderRound: s, pelvicTilt: p, lateralShift: l, torsoWidth: tw } = state;
  const cx = 60 + l;

  return `<svg viewBox="0 0 120 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Posture avatar${label ? ': ' + label : ''}">
  <line x1="60" y1="10" x2="60" y2="210" stroke="${muted}" stroke-width="1" stroke-dasharray="3 4" opacity="0.35"/>
  <circle cx="${cx + h}" cy="26" r="13" fill="none" stroke="${accent}" stroke-width="3"/>
  <line x1="${cx + h}" y1="39" x2="${cx}" y2="58" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <path d="M ${cx - tw} ${58 + s} Q ${cx} ${52 + s * 1.4} ${cx + tw} ${58 + s}"
        fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <path d="M ${cx - tw + 4} ${58 + s} Q ${cx - tw - 2} ${100} ${cx - tw + 6} ${132}"
        fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <path d="M ${cx + tw - 4} ${58 + s} Q ${cx + tw + 2} ${100} ${cx + tw - 6} ${132}"
        fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <path d="M ${cx} 58 Q ${cx + p * 0.5} 100 ${cx - p * 0.4} ${134}"
        fill="none" stroke="${accent}" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="${cx - p * 0.4 - 12}" y1="${134}" x2="${cx - p * 0.4 + 12}" y2="${134}"
        stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <line x1="${cx - p * 0.4 - 10}" y1="136" x2="${cx - 14}" y2="204" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <line x1="${cx - p * 0.4 + 10}" y1="136" x2="${cx + 14}" y2="204" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}

export const PROGRESS_NOTE =
  'The avatar is a diagram, not a picture of you, and every part of it comes ' +
  'from something measured — posture from your scans, torso width from your ' +
  'scale. Nothing here is generated or imagined. Strength is listed first ' +
  'because it responds within days, while scale weight can sit still for weeks ' +
  'during exactly the period your body is changing most.';
