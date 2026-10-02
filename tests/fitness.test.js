// Tests for the fitness analytics and safety logic.
//
// The cases that matter most here are the REFUSALS — the sedentary nudge
// staying silent when the user is low, the carb estimator declining to
// personalise noisy data, the post-exercise threshold never moving downward.
// Those are the paths where a regression is dangerous rather than merely wrong,
// so each has an explicit test.

import { describe, it, expect } from 'vitest';
import { estimateCarbs } from '../src/lib/fitness/carbs.js';
import {
  dailyGlucoseStats, timeInRangeByDayType, trainingEffect,
} from '../src/lib/fitness/analytics.js';
import { evaluateSedentary, currentSitStreak, NUDGE } from '../src/lib/fitness/sedentary.js';
import { adjustedLowThreshold } from '../src/lib/fitness/safety.js';
import { buildReport, renderReportHtml } from '../src/lib/fitness/report.js';

const NOW = Date.UTC(2026, 7, 3, 14, 0, 0);

/** 10 days of CGM data where even days (training) run tighter than odd (rest). */
function syntheticHistory() {
  const out = [];
  for (let d = 0; d < 10; d++) {
    for (let i = 0; i < 96; i++) {
      out.push({
        timestamp: new Date(NOW - d * 86400000 - i * 900000).toISOString(),
        value: (d % 2 === 0 ? 120 : 165) + (i % 7) * 6,
      });
    }
  }
  return out;
}

function syntheticWorkouts() {
  const out = [];
  for (let d = 0; d < 10; d += 2) {
    const start = NOW - d * 86400000 - 3600000;
    out.push({
      id: `w${d}`,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(start + 2400000).toISOString(),
      modality: 'resistance',
    });
  }
  return out;
}

const consistentCardio = Array.from({ length: 6 }, (_, i) => ({
  modality: 'cardio', deltaDuring: -58 - (i % 3), durationMin: 30, endedHour: 18,
}));

describe('dailyGlucoseStats', () => {
  it('reports TIR as a fraction and computes CV', () => {
    const daily = dailyGlucoseStats(syntheticHistory(), {});
    expect(daily.length).toBeGreaterThanOrEqual(9);
    expect(daily.every(d => d.tir >= 0 && d.tir <= 1)).toBe(true);
    expect(daily.every(d => d.cv != null)).toBe(true);
  });

  it('drops days with too little coverage rather than reporting them as complete', () => {
    const sparse = [{ timestamp: new Date(NOW).toISOString(), value: 120 }];
    expect(dailyGlucoseStats(sparse, {})).toHaveLength(0);
  });
});

describe('timeInRangeByDayType', () => {
  it('separates training days from rest days and quantifies the difference', () => {
    const byType = timeInRangeByDayType(syntheticWorkouts(), syntheticHistory(), {});
    expect(byType.length).toBeGreaterThanOrEqual(2);

    const effect = trainingEffect(byType);
    expect(effect).not.toBeNull();
    expect(effect.deltaPts).toBeGreaterThan(0);
  });

  it('returns no effect when one side has too few days to compare honestly', () => {
    const byType = timeInRangeByDayType([], syntheticHistory(), {});
    expect(trainingEffect(byType)).toBeNull();
  });
});

describe('estimateCarbs', () => {
  it('falls back to published guidance without enough history', () => {
    const est = estimateCarbs({ reading: { value: 120 }, modality: 'resistance', analyses: [] });
    expect(est.personalised).toBe(false);
    expect(est.grams).toBeNull();
  });

  it('personalises once the response is consistent, rounding up to 5g', () => {
    const est = estimateCarbs({
      reading: { value: 115 }, modality: 'cardio', analyses: consistentCardio, durationMin: 30,
    });
    expect(est.personalised).toBe(true);
    expect(est.grams).toBeGreaterThan(0);
    expect(est.grams % 5).toBe(0);
  });

  // A confident number from noisy data is worse than an honest range.
  it('refuses to personalise when the response varies wildly', () => {
    const noisy = [-5, -90, -12, -75, -30, -88].map(d => ({
      modality: 'cardio', deltaDuring: d, durationMin: 30, endedHour: 18,
    }));
    const est = estimateCarbs({ reading: { value: 115 }, modality: 'cardio', analyses: noisy });
    expect(est.personalised).toBe(false);
    expect(est.detail).toMatch(/vary too much/i);
  });

  it('defers to treat-first when already below the starting threshold', () => {
    const est = estimateCarbs({ reading: { value: 80 }, modality: 'cardio', analyses: consistentCardio });
    expect(est.grams).toBe(20);
    expect(est.personalised).toBe(false);
  });

  it('adds a margin when the arrow is falling', () => {
    const steady = estimateCarbs({ reading: { value: 115 }, modality: 'cardio', analyses: consistentCardio });
    const falling = estimateCarbs({
      reading: { value: 115, trend: 'Falling' }, modality: 'cardio', analyses: consistentCardio,
    });
    expect(falling.grams).toBeGreaterThanOrEqual(steady.grams);
  });
});

describe('evaluateSedentary', () => {
  const sitting = [{ recorded_at: new Date(NOW - 70 * 60000).toISOString(), value: 70 }];
  const rising = Array.from({ length: 8 }, (_, i) => ({
    timestamp: new Date(NOW - (7 - i) * 300000).toISOString(), value: 130 + i * 8,
  }));

  it('nudges when sitting and glucose is climbing', () => {
    const n = evaluateSedentary({
      sedentarySamples: sitting, glucoseHistory: rising,
      currentReading: { value: 186 }, now: NOW,
    });
    expect(n.kind).toBe(NUDGE.MOVE);
  });

  // Never send someone who is low out for a walk.
  it('stays silent when the user is low', () => {
    const n = evaluateSedentary({
      sedentarySamples: sitting, glucoseHistory: rising,
      currentReading: { value: 78 }, lowThreshold: 70, now: NOW,
    });
    expect(n.kind).toBe(NUDGE.NONE);
  });

  it('stays silent during quiet hours', () => {
    const n = evaluateSedentary({
      sedentarySamples: sitting, glucoseHistory: rising,
      currentReading: { value: 186 }, now: Date.UTC(2026, 7, 3, 23, 0, 0),
    });
    expect(n.kind).toBe(NUDGE.NONE);
  });

  it('respects the cooldown between nudges', () => {
    const n = evaluateSedentary({
      sedentarySamples: sitting, glucoseHistory: rising, currentReading: { value: 186 },
      lastNudgeAt: new Date(NOW - 10 * 60000).toISOString(), now: NOW,
    });
    expect(n.kind).toBe(NUDGE.NONE);
  });

  it('treats a stale sitting block as "not sitting now"', () => {
    const streak = currentSitStreak(
      [{ recorded_at: new Date(NOW - 5 * 3600000).toISOString(), value: 60 }], { now: NOW }
    );
    expect(streak).toBe(0);
  });
});

describe('adjustedLowThreshold', () => {
  it('raises the threshold inside the post-exercise window', () => {
    const adj = adjustedLowThreshold(70, {
      endedAt: new Date(NOW - 3600000).toISOString(), modality: 'resistance',
    }, { now: NOW });
    expect(adj.raised).toBe(true);
    expect(adj.threshold).toBeGreaterThan(70);
  });

  // A bug here must never make the app quieter about lows than the user asked.
  it('never returns a threshold below the configured value', () => {
    for (const hoursAgo of [0.5, 4, 11, 20, 48]) {
      const adj = adjustedLowThreshold(70, {
        endedAt: new Date(NOW - hoursAgo * 3600000).toISOString(), modality: 'resistance',
      }, { now: NOW });
      expect(adj.threshold).toBeGreaterThanOrEqual(70);
    }
  });

  it('returns to normal once the window closes', () => {
    const adj = adjustedLowThreshold(70, {
      endedAt: new Date(NOW - 40 * 3600000).toISOString(), modality: 'resistance',
    }, { now: NOW });
    expect(adj.raised).toBe(false);
    expect(adj.threshold).toBe(70);
  });

  it('is a no-op with no prior session', () => {
    expect(adjustedLowThreshold(70, null, { now: NOW }).raised).toBe(false);
  });
});

describe('buildReport', () => {
  it('summarises glucose and exercise over the window', () => {
    const rep = buildReport({ history: syntheticHistory(), workouts: syntheticWorkouts(), days: 30, now: NOW });
    expect(rep.glucose.tir).toBeGreaterThan(0);
    expect(rep.exercise.sessions).toBe(syntheticWorkouts().length);
    expect(rep.glucose.hypoByHour).toHaveLength(24);
  });

  it('renders printable HTML that states its own limits', () => {
    const html = renderReportHtml(
      buildReport({ history: syntheticHistory(), workouts: syntheticWorkouts(), days: 30 })
    );
    expect(html).toContain('time in range');
    expect(html).toContain('not a medical device');
  });
});

// ── CGM validation, sensor age, GMI ────────────────────────────────────────
// These exist because a sentinel error code read as glucose is the most
// dangerous single failure this app can have: it invents a severe hypo.

import { validateReading, validateSeries, REJECT } from '../src/lib/cgm/validate.js';
import { sensorStatus, wasInWarmup, excludeWarmup, SENSOR_STATE } from '../src/lib/cgm/sensor.js';
import { glucoseManagementIndicator } from '../src/lib/fitness/analytics.js';
import { summarise } from '../src/lib/nutrition/mealScan.js';

describe('CGM validation', () => {
  const at = ms => new Date(NOW - ms).toISOString();

  it('rejects Dexcom sentinel codes rather than reading them as glucose', () => {
    // 5 means SENSOR_NOT_CALIBRATED. Treated as 5 mg/dL it is a severe hypo.
    const v = validateReading({ value: 5, timestamp: at(0) }, { now: NOW });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe(REJECT.ERROR_CODE);
    expect(v.detail).toMatch(/not calibrated/i);
  });

  it('rejects every documented sentinel code', () => {
    for (const code of [0, 1, 2, 3, 5, 6, 9, 10, 12]) {
      expect(validateReading({ value: code, timestamp: at(0) }, { now: NOW }).valid).toBe(false);
    }
  });

  it('accepts a normal reading', () => {
    expect(validateReading({ value: 112, timestamp: at(0) }, { now: NOW }).valid).toBe(true);
  });

  it('accepts but flags readings at the reporting ceiling', () => {
    const v = validateReading({ value: 400, timestamp: at(0) }, { now: NOW });
    expect(v.valid).toBe(true);
    expect(v.capped).toBe(true);
  });

  it('rejects timestamps in the future', () => {
    expect(validateReading({ value: 110, timestamp: new Date(NOW + 3600000).toISOString() }, { now: NOW }).reason)
      .toBe(REJECT.FUTURE);
  });

  // Regression guard: an age cutoff here once reduced 14 days of history to
  // one day and broke TIR, GMI and the day-type comparison simultaneously.
  // Freshness is safety.js's concern, not this module's.
  it('accepts old readings — history is old by definition', () => {
    expect(validateReading({ value: 110, timestamp: at(30 * 86400000) }, { now: NOW }).valid).toBe(true);
  });

  it('audits what it dropped instead of silently shrinking the series', () => {
    const series = [
      { value: 110, timestamp: at(0) },
      { value: 5, timestamp: at(300000) },
      { value: 120, timestamp: at(600000) },
      { value: 3, timestamp: at(900000) },
    ];
    const r = validateSeries(series, { now: NOW });
    expect(r.valid).toHaveLength(2);
    expect(r.rejected).toHaveLength(2);
    expect(r.total).toBe(4);
    expect(r.degraded).toBe(true);
  });
});

describe('sensor age', () => {
  it('reports warm-up in the first hour of a Libre 3', () => {
    const s = sensorStatus({ startedAt: new Date(NOW - 20 * 60000).toISOString(), type: 'libre3' }, { now: NOW });
    expect(s.state).toBe(SENSOR_STATE.WARMUP);
    expect(s.inWarmup).toBe(true);
  });

  it('becomes active after warm-up and expires after wear time', () => {
    const active = sensorStatus({ startedAt: new Date(NOW - 3 * 86400000).toISOString(), type: 'libre3' }, { now: NOW });
    expect(active.state).toBe(SENSOR_STATE.ACTIVE);

    const dead = sensorStatus({ startedAt: new Date(NOW - 20 * 86400000).toISOString(), type: 'libre3' }, { now: NOW });
    expect(dead.state).toBe(SENSOR_STATE.EXPIRED);
  });

  it('excludes historical warm-up readings from a series', () => {
    const sensors = [{ startedAt: new Date(NOW - 10 * 86400000).toISOString(), type: 'libre3' }];
    const readings = [
      { value: 300, timestamp: new Date(NOW - 10 * 86400000 + 10 * 60000).toISOString() }, // warm-up
      { value: 110, timestamp: new Date(NOW - 9 * 86400000).toISOString() },
    ];
    expect(wasInWarmup(readings[0].timestamp, sensors)).toBe(true);
    expect(excludeWarmup(readings, sensors)).toHaveLength(1);
  });
});

describe('GMI', () => {
  it('applies the published Bergenstal formula', () => {
    // mean 154 mg/dL -> 3.31 + 0.02392*154 = 6.99
    const history = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 96; i++) {
        history.push({ timestamp: new Date(NOW - d * 86400000 - i * 900000).toISOString(), value: 154 });
      }
    }
    const r = glucoseManagementIndicator(history, {});
    expect(r.gmi).toBeCloseTo(7.0, 1);
    expect(r.reliable).toBe(true);
  });

  it('flags itself unreliable on thin data', () => {
    const history = Array.from({ length: 96 }, (_, i) => ({
      timestamp: new Date(NOW - i * 900000).toISOString(), value: 140,
    }));
    expect(glucoseManagementIndicator(history, {}).reliable).toBe(false);
  });
});

describe('meal carb estimate', () => {
  it('sums items and reports the weakest confidence, not the average', () => {
    const r = summarise({
      items: [
        { name: 'rice', portionBasis: '1 cup', carbsGrams: 45, carbsLow: 40, carbsHigh: 50, confidence: 0.9 },
        { name: 'sauce', portionBasis: 'a ladle', carbsGrams: 10, carbsLow: 5, carbsHigh: 20, confidence: 0.3 },
      ],
      caveat: 'sauce may contain sugar',
    });
    expect(r.total).toBe(55);
    expect(r.confidence).toBe(0.3);
  });

  // An unsure guess with a tight range is the failure mode to avoid.
  it('widens the range when the model is unconfident', () => {
    const r = summarise({
      items: [{ name: 'stew', portionBasis: 'a bowl', carbsGrams: 40, carbsLow: 39, carbsHigh: 41, confidence: 0.2 }],
      caveat: 'depth of bowl unclear',
    });
    expect(r.high - r.low).toBeGreaterThan(2);
  });

  it('never returns a negative low bound', () => {
    const r = summarise({
      items: [{ name: 'salad', portionBasis: 'side', carbsGrams: 3, carbsLow: -5, carbsHigh: 8, confidence: 0.1 }],
      caveat: 'dressing unknown',
    });
    expect(r.low).toBeGreaterThanOrEqual(0);
  });
});

// ── Insulin: IOB, catalog, meal outcomes ───────────────────────────────────
// The dangerous direction here is UNDER-stating active insulin, which would let
// someone stack a correction on top of a bolus still working. Tests lean on
// that side.

import { activeFraction, insulinOnBoard, detectStacking, INSULIN_PROFILES } from '../src/lib/insulin/iob.js';
import { findInsulin, isBolus, actionProfile, insulinWarnings } from '../src/lib/insulin/catalog.js';
import { buildDoseEntry, parseStrength, DOSE_CONTEXT } from '../src/lib/insulin/meds.js';
import { analyzeMealDose, ratioReview, bandFor } from '../src/lib/insulin/outcomes.js';

describe('insulin action curve', () => {
  const p = INSULIN_PROFILES.novorapid;

  it('is fully active at injection and gone after duration', () => {
    expect(activeFraction(0, p)).toBeCloseTo(1, 2);
    expect(activeFraction(p.durationMin, p)).toBe(0);
    expect(activeFraction(p.durationMin + 60, p)).toBe(0);
  });

  it('decays monotonically', () => {
    let prev = 1.01;
    for (let t = 0; t <= p.durationMin; t += 15) {
      const f = activeFraction(t, p);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
  });

  it('still reports meaningful insulin at the peak', () => {
    expect(activeFraction(p.peakMin, p)).toBeGreaterThan(0.5);
  });
});

describe('insulin on board', () => {
  const t = min => new Date(NOW - min * 60000).toISOString();

  it('sums active insulin across doses', () => {
    const r = insulinOnBoard([
      { units: 6, takenAt: t(60), insulinType: 'novorapid' },
      { units: 4, takenAt: t(30), insulinType: 'novorapid' },
    ], { now: NOW });
    expect(r.units).toBeGreaterThan(0);
    expect(r.units).toBeLessThan(10);
    expect(r.contributions).toHaveLength(2);
  });

  // Long-acting insulin in a bolus IOB figure would massively overstate active
  // insulin and could lead someone to skip a correction they needed.
  it('excludes basal entirely', () => {
    const r = insulinOnBoard([
      { units: 24, takenAt: t(120), insulinType: 'tresiba', category: 'basal' },
    ], { now: NOW });
    expect(r.units).toBe(0);
  });

  it('ignores future-dated doses', () => {
    const r = insulinOnBoard([
      { units: 5, takenAt: new Date(NOW + 3600000).toISOString(), insulinType: 'novorapid' },
    ], { now: NOW });
    expect(r.units).toBe(0);
  });

  it('flags stacking when a dose lands on active insulin', () => {
    const events = detectStacking([
      { units: 8, takenAt: t(90), insulinType: 'novorapid' },
      { units: 4, takenAt: t(40), insulinType: 'novorapid' },
    ], { now: NOW });
    expect(events.length).toBe(1);
    expect(events[0].iobAtTime).toBeGreaterThan(1);
  });
});

describe('insulin catalog', () => {
  it('classifies basal and bolus correctly', () => {
    expect(isBolus('novorapid')).toBe(true);
    expect(isBolus('tresiba')).toBe(false);
    expect(actionProfile('tresiba')).toBeNull();
    expect(actionProfile('humalog')).toMatchObject({ peakMin: 75 });
  });

  it('warns loudly about concentrated insulins', () => {
    expect(insulinWarnings('regular-u500', 'U-500').join(' ')).toMatch(/concentrated/i);
    expect(insulinWarnings('toujeo', 'U-300').join(' ')).toMatch(/concentrated/i);
    expect(findInsulin('lantus').concentrations).toContain('U-100');
  });
});

describe('dose entry validation', () => {
  it('rejects zero, negative and non-numeric doses', () => {
    for (const bad of [0, -2, 'abc', null]) {
      expect(() => buildDoseEntry({ units: bad, insulinType: 'novorapid' })).toThrow();
    }
  });

  // A slipped decimal is far likelier than a real 100u bolus.
  it('rejects implausibly large doses as probable typos', () => {
    expect(() => buildDoseEntry({ units: 250, insulinType: 'novorapid' })).toThrow(/large/i);
  });

  it('requires an insulin to be chosen', () => {
    expect(() => buildDoseEntry({ units: 5 })).toThrow(/which insulin/i);
  });

  it('marks basal context so IOB will exclude it', () => {
    const e = buildDoseEntry({ units: 20, insulinType: 'tresiba', context: DOSE_CONTEXT.BASAL });
    expect(e.category).toBe('basal');
  });
});

describe('RxNorm strength parsing', () => {
  it('extracts concentration, which distinguishes U-100 from U-300 glargine', () => {
    expect(parseStrength('3 ML insulin glargine 100 UNT/ML Pen Injector [Lantus]'))
      .toMatchObject({ concentration: 'U-100', form: 'pen', isInsulin: true });
    expect(parseStrength('insulin glargine 300 UNT/ML [Toujeo]').concentration).toBe('U-300');
  });
});

describe('meal outcomes', () => {
  const mealHistory = (startVal, fourHourVal) => {
    const out = [];
    for (let m = -20; m <= 260; m += 5) {
      const frac = Math.max(0, Math.min(1, m / 240));
      out.push({
        timestamp: new Date(NOW + m * 60000).toISOString(),
        value: startVal + (fourHourVal - startVal) * frac,
      });
    }
    return out;
  };

  it('classifies a meal that finishes above target as high', () => {
    const dose = { id: 'd1', units: 5, carbsGrams: 70, takenAt: new Date(NOW).toISOString(), category: 'bolus' };
    const o = analyzeMealDose(dose, mealHistory(120, 240), {});
    expect(o.verdict).toBe('high');
    expect(o.band).toBe('large');
    expect(o.ratioUsed).toBe(14);
  });

  it('reports a pattern only once there are enough meals', () => {
    const few = Array.from({ length: 3 }, (_, i) => ({
      band: 'large', verdict: 'high', hypoInWindow: false, fourHour: 230, riseToPeak: 90, ratioUsed: 14,
    }));
    expect(ratioReview(few)[0].pattern).toBeNull();

    const many = Array.from({ length: 8 }, () => ({
      band: 'large', verdict: 'high', hypoInWindow: false, fourHour: 230, riseToPeak: 90, ratioUsed: 14,
    }));
    const r = ratioReview(many)[0];
    expect(r.pattern.tone).toBe('high');
    expect(r.pattern.text).toMatch(/care team/i);
  });

  // The module must never sound like a prescription.
  it('never proposes a ratio or a dose', () => {
    const many = Array.from({ length: 8 }, () => ({
      band: 'medium', verdict: 'high', hypoInWindow: false, fourHour: 220, riseToPeak: 80, ratioUsed: 12,
    }));
    const text = ratioReview(many).map(r => r.pattern?.text || '').join(' ');
    expect(text).not.toMatch(/take \d|increase your|decrease your|change your ratio to|units of/i);
  });

  it('bands carbs sensibly', () => {
    expect(bandFor(20).id).toBe('small');
    expect(bandFor(75).id).toBe('large');
    expect(bandFor(200).id).toBe('xlarge');
  });
});

// ── Care circle: escalation and competition ────────────────────────────────

import { evaluateEscalation, alertPayload, RUNG } from '../src/lib/care/escalation.js';
import { leaderboard, memberTotal, assertCompetable, FORBIDDEN_METRICS } from '../src/lib/care/challenge.js';

describe('nocturnal escalation', () => {
  const NIGHT = Date.UTC(2026, 7, 3, 3, 0, 0);   // 03:00
  const DAY = Date.UTC(2026, 7, 3, 14, 0, 0);
  const low = { value: 62 };
  const severe = { value: 48 };

  it('alerts the user first', () => {
    const d = evaluateEscalation({ reading: low, lowSince: NIGHT, circleSize: 1, now: NIGHT });
    expect(d.rung).toBe(RUNG.SELF);
  });

  it('escalates to the circle when the user does not acknowledge at night', () => {
    const d = evaluateEscalation({
      reading: low, lowSince: NIGHT - 10 * 60000, highestRungFired: RUNG.SELF,
      circleSize: 1, now: NIGHT,
    });
    expect([RUNG.CARE_PUSH, RUNG.CARE_SMS, RUNG.CARE_CALL]).toContain(d.rung);
  });

  // Severe lows must not sit out the acknowledgement window.
  it('does not wait for the ack window when the low is severe', () => {
    const d = evaluateEscalation({
      reading: severe, lowSince: NIGHT, highestRungFired: RUNG.SELF, circleSize: 1, now: NIGHT,
    });
    expect(d.rung).not.toBe(RUNG.NONE);
    expect(d.severe).toBe(true);
  });

  it('climbs to a phone call if nothing resolves it overnight', () => {
    const d = evaluateEscalation({
      reading: severe, lowSince: NIGHT - 30 * 60000, highestRungFired: RUNG.CARE_SMS,
      circleSize: 1, now: NIGHT,
    });
    expect(d.rung).toBe(RUNG.CARE_CALL);
  });

  // A sensor going silent mid-low is indistinguishable from someone collapsing.
  it('treats a data gap during a low as an emergency', () => {
    const d = evaluateEscalation({
      reading: { value: null }, lowSince: NIGHT - 20 * 60000,
      highestRungFired: RUNG.SELF, circleSize: 1, now: NIGHT,
    });
    expect(d.dataGap).toBe(true);
    expect(d.rung).not.toBe(RUNG.NONE);
  });

  it('stops climbing once the user acknowledges a non-severe low', () => {
    const d = evaluateEscalation({
      reading: low, lowSince: NIGHT - 30 * 60000, acknowledged: true,
      highestRungFired: RUNG.SELF, circleSize: 1, now: NIGHT,
    });
    expect(d.rung).toBe(RUNG.NONE);
  });

  it('does not wake a partner over a routine daytime low', () => {
    const d = evaluateEscalation({
      reading: low, lowSince: DAY, highestRungFired: RUNG.SELF, circleSize: 1, now: DAY,
    });
    expect(d.rung).not.toBe(RUNG.CARE_CALL);
  });

  it('keeps alerting the user when there is no one in the circle', () => {
    const d = evaluateEscalation({
      reading: severe, lowSince: NIGHT - 30 * 60000, highestRungFired: RUNG.SELF,
      circleSize: 0, now: NIGHT,
    });
    expect(d.rung).toBe(RUNG.NONE);
  });

  it('never fires the same rung twice', () => {
    const d = evaluateEscalation({
      reading: low, lowSince: NIGHT - 60 * 60000, highestRungFired: RUNG.CARE_CALL,
      circleSize: 1, now: NIGHT,
    });
    expect(d.rung).toBe(RUNG.NONE);
  });

  it('goes quiet once glucose recovers', () => {
    const d = evaluateEscalation({ reading: { value: 110 }, lowSince: NIGHT, circleSize: 1, now: NIGHT });
    expect(d.rung).toBe(RUNG.NONE);
    expect(d.resolved).toBe(true);
  });

  it('writes an actionable message for the caregiver', () => {
    const d = evaluateEscalation({
      reading: severe, lowSince: NIGHT, highestRungFired: RUNG.SELF, circleSize: 1, now: NIGHT,
    });
    const p = alertPayload(d, { name: 'Sam' });
    expect(p.title).toMatch(/Sam/);
    expect(p.body).toMatch(/check on them/i);
    expect(p.requireInteraction).toBe(true);
  });
});

describe('care circle competition', () => {
  // Midweek on purpose: with a Monday-start week, a Monday `now` makes
  // "earlier this week" impossible and the week window untestable.
  const now = Date.UTC(2026, 7, 5, 18, 0, 0); // Wednesday
  const sample = (type, value, hoursAgo) => ({
    type, value, recorded_at: new Date(now - hoursAgo * 3600000).toISOString(),
  });

  // The central guardrail: glucose is not effort and must never be ranked.
  it('refuses to rank anyone on glucose outcomes', () => {
    for (const m of FORBIDDEN_METRICS) {
      expect(() => assertCompetable(m)).toThrow(/health outcome/i);
    }
  });

  it('allows activity metrics', () => {
    expect(assertCompetable('activeEnergy')).toBe(true);
    expect(assertCompetable('steps')).toBe(true);
  });

  it('totals only samples inside the period', () => {
    const samples = [sample('activeEnergy', 300, 2), sample('activeEnergy', 500, 40)];
    expect(memberTotal('activeEnergy', { samples }, { period: 'today', now })).toBe(300);
    expect(memberTotal('activeEnergy', { samples }, { period: 'week', now })).toBe(800);
  });

  it('ranks members and reports the gap', () => {
    const board = leaderboard('activeEnergy', [
      { email: 'a@x.com', name: 'Sam', samples: [sample('activeEnergy', 600, 1)] },
      { email: 'b@x.com', name: 'Partner', samples: [sample('activeEnergy', 400, 1)] },
    ], { period: 'today', now });

    expect(board.leader.name).toBe('Sam');
    expect(board.rows[1].behindLeader).toBe(200);
    expect(board.contested).toBe(true);
  });

  // A prescribed rest day is not a loss.
  it('marks rest days as resting rather than last', () => {
    const board = leaderboard('steps', [
      { email: 'a@x.com', name: 'Sam', restDay: true, samples: [] },
      { email: 'b@x.com', name: 'Partner', samples: [sample('steps', 9000, 1)] },
    ], { period: 'today', now });

    const ken = board.rows.find(r => r.email === 'a@x.com');
    expect(ken.restDay).toBe(true);
    expect(ken.rank).toBeNull();
  });
});

// ── Home device alerts ─────────────────────────────────────────────────────
// The strongest rung, and the most disruptive. The tests lean hardest on it
// staying quiet when it should, and on reaching ANOTHER ROOM when it must —
// a hypo alert that only sounds in the bedroom of the person who cannot help
// themselves has missed the point entirely.

import { planHomeAlert, planHomeStandDown, spokenMessage, HOME_ACTION, ZONE } from '../src/lib/care/homeAlert.js';

describe('home device alerts', () => {
  const NIGHT = Date.UTC(2026, 7, 3, 3, 0, 0);
  const DAY = Date.UTC(2026, 7, 3, 14, 0, 0);
  const home = {
    patientName: 'Sam',
    patient: {
      lights: ['light.bedroom'],
      speakers: ['media_player.bedroom_echo'],
    },
    helpers: {
      lights: ['light.spare_bedroom'],
      speakers: ['media_player.kitchen_echo'],
      sirens: ['switch.hall_siren'],
      tvs: ['media_player.living_room_tv'],
    },
  };

  it('wakes only the patient gently on the first rung', () => {
    const p = planHomeAlert({ rung: 'self', severe: false }, home, { now: NIGHT });
    expect(p.zones).toEqual([ZONE.PATIENT]);
    expect(p.calls[0].body.brightness_pct).toBe(30);
  });

  // The whole point: someone in another room has to be woken and sent.
  it('reaches the helper room once help is actually needed', () => {
    const p = planHomeAlert({ rung: 'care-push', severe: true }, home, { now: NIGHT });
    expect(p.zones).toContain(ZONE.HELPERS);
    const spoken = p.calls.filter(c => c.path.includes('/tts/'));
    expect(spoken.length).toBe(2);
    expect(spoken.some(c => /go to sam now/i.test(c.body.message))).toBe(true);
  });

  it('tells the helper what to do, not just that something is wrong', () => {
    const msg = spokenMessage({ rung: 'care-push', severe: true }, ZONE.HELPERS, 'Sam');
    expect(msg).toMatch(/go to sam now/i);
    expect(msg).not.toMatch(/mg\/dL|trend|arrow/i);
  });

  it('tells the patient to treat, not to go anywhere', () => {
    const msg = spokenMessage({ rung: 'self', severe: true }, ZONE.PATIENT, 'Sam');
    expect(msg).toMatch(/treat now|fast sugar/i);
    expect(msg).not.toMatch(/go to/i);
  });

  it('adds siren and TV in helper rooms at the top of the ladder', () => {
    const p = planHomeAlert({ rung: 'care-call', severe: true }, home, { now: NIGHT });
    expect(p.actions).toContain(`helpers:${HOME_ACTION.SIREN}`);
    expect(p.actions).toContain(`helpers:${HOME_ACTION.TV_ON}`);
  });

  // Waking a household for a low the user is awake to treat kills the feature.
  it('stays quiet during the day for a non-severe low', () => {
    const p = planHomeAlert({ rung: 'care-push', severe: false }, home, { now: DAY });
    expect(p.actions).toHaveLength(0);
    expect(p.skipped).toMatch(/daytime/);
  });

  it('still fires in daytime when the low is severe', () => {
    expect(planHomeAlert({ rung: 'care-push', severe: true }, home, { now: DAY }).actions.length)
      .toBeGreaterThan(0);
  });

  it('does nothing without configured devices, or without an alert', () => {
    expect(planHomeAlert({ rung: 'care-call', severe: true }, {}, { now: NIGHT }).calls).toHaveLength(0);
    expect(planHomeAlert({ rung: 'none' }, home, { now: NIGHT }).calls).toHaveLength(0);
  });

  it('announces a sensor dropout during a low as an emergency', () => {
    const msg = spokenMessage({ rung: 'care-push', dataGap: true, severe: true }, ZONE.HELPERS, 'Sam');
    expect(msg).toMatch(/stopped working/i);
    expect(msg).toMatch(/go to sam/i);
  });

  // Turning the light off on someone treating a hypo in the dark is hostile.
  it('kills siren and TV on stand-down but leaves lights on', () => {
    const d = planHomeStandDown(home);
    expect(d.calls.some(c => c.path.includes('light'))).toBe(false);
    expect(d.calls.every(c => c.path.includes('turn_off'))).toBe(true);
  });
});

// ── Posture scan ───────────────────────────────────────────────────────────
// The important assertions are about restraint: no spot-reduction claims, no
// body-composition guessing from photos, and no corrective work prescribed off
// a low-confidence reading.

import {
  summarisePosture, correctiveWork, POSTURE_MARKERS,
  FAT_LOSS_NOTE, POSTURE_DISCLAIMER,
} from '../src/lib/fitness/postureScan.js';

describe('posture scan', () => {
  const marker = (present, confidence, severity = 'moderate') => ({
    present, confidence, severity, observation: 'observed',
  });

  it('reports markers the model is confident about', () => {
    const r = summarisePosture({
      markers: {
        roundedShoulders: marker(true, 0.9),
        anteriorPelvicTilt: marker(true, 0.8),
      },
      caveat: 'side view only',
    });
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].key).toBe('roundedShoulders');
    expect(r.clear).toBe(false);
  });

  // A false positive sends someone doing corrective work they do not need.
  it('discards low-confidence findings', () => {
    const r = summarisePosture({
      markers: { forwardHead: marker(true, 0.2) },
      caveat: 'blurry',
    });
    expect(r.findings).toHaveLength(0);
    expect(r.clear).toBe(true);
  });

  it('ignores markers reported as absent', () => {
    const r = summarisePosture({
      markers: { forwardHead: marker(false, 0.95) },
      caveat: 'ok',
    });
    expect(r.findings).toHaveLength(0);
  });

  // Stretching the already-overstretched upper back is how people make rounded
  // shoulders worse. Tight and weak must never be the same list.
  it('separates what to lengthen from what to strengthen', () => {
    for (const def of Object.values(POSTURE_MARKERS)) {
      expect(def.tight.some(t => def.weak.includes(t))).toBe(false);
    }
    const rs = POSTURE_MARKERS.roundedShoulders;
    expect(rs.tight).toContain('pectorals');
    expect(rs.weak).toContain('rhomboids');
  });

  it('maps findings onto real catalog exercises', () => {
    const catalog = [
      { name: 'Doorway chest stretch' },
      { name: 'Cable face pull' },
      { name: 'Barbell bench press' },
    ];
    const work = correctiveWork(
      summarisePosture({ markers: { roundedShoulders: marker(true, 0.9) }, caveat: '' }).findings,
      catalog
    );
    expect(work[0].stretch.map(e => e.name)).toContain('Doorway chest stretch');
    expect(work[0].strengthen.map(e => e.name)).toContain('Cable face pull');
    expect(work[0].note).toMatch(/Lengthen.*Strengthen/);
  });

  // The central honesty check for this feature.
  it('states plainly that spot reduction is not real', () => {
    expect(FAT_LOSS_NOTE).toMatch(/spot reduction is not a real/i);
    expect(FAT_LOSS_NOTE).toMatch(/whole-body/i);
  });

  it('promises photos are not stored, and defers pain to a clinician', () => {
    expect(POSTURE_DISCLAIMER).toMatch(/keeps no copy/i);
    expect(POSTURE_DISCLAIMER).toMatch(/Gemini/);
    expect(POSTURE_DISCLAIMER).toMatch(/physiotherapist/i);
  });
});

// ── Progress: narrative ordering and avatar ────────────────────────────────
// The point of these tests is the ORDER. Scale weight is the metric everyone
// checks and the last one to move; leading with it during the period the body
// is changing most is how people conclude it isn't working and stop.

import {
  snapshot, compare, progressNarrative, avatarState, renderAvatarSvg, strengthIndex,
} from '../src/lib/progress/progress.js';
import { POSE_GUIDE, CAPTURE_RULES, ALBUM_PRIVACY_NOTE } from '../src/lib/progress/photoAlbum.js';

describe('progress narrative', () => {
  const base = { at: NOW - 60 * 86400000, weightKg: 92, bodyFatPct: 30, muscleKg: 60,
                 visceralFat: 12, strength: { volume: 1000 }, posture: { markers: ['roundedShoulders'] } };

  it('leads with strength, because it moves first', () => {
    const now = { ...base, at: NOW, strength: { volume: 4000 } };
    const lines = progressNarrative(compare(now, base));
    expect(lines[0].metric).toBe('strength');
  });

  // The failure this whole ordering exists to prevent.
  it('reads flat weight with rising muscle as success, not a stall', () => {
    const now = { ...base, at: NOW, weightKg: 91.9, bodyFatPct: 27.5, muscleKg: 61.2,
                  strength: { volume: 3000 } };
    const lines = progressNarrative(compare(now, base));
    const weight = lines.find(l => l.metric === 'weight');
    expect(weight.tone).toBe('good');
    expect(weight.text).toMatch(/working, not stalling/i);
    // And it must not be the headline.
    expect(lines[0].metric).not.toBe('weight');
  });

  it('reports fat mass falling even when the scale barely moves', () => {
    const now = { ...base, at: NOW, weightKg: 91.5, bodyFatPct: 27, strength: { volume: 1000 } };
    const lines = progressNarrative(compare(now, base));
    expect(lines.some(l => l.metric === 'fat')).toBe(true);
  });

  it('credits resolved posture markers', () => {
    const now = { ...base, at: NOW, posture: { markers: [] } };
    const lines = progressNarrative(compare(now, base));
    expect(lines.some(l => l.metric === 'posture' && /No longer showing/.test(l.text))).toBe(true);
  });

  it('says so plainly when there is nothing yet', () => {
    const now = { ...base, at: NOW };
    const lines = progressNarrative(compare(now, base));
    expect(lines[0].text).toMatch(/not enough logged/i);
  });
});

describe('strength index', () => {
  it('counts bodyweight sets so progression still registers', () => {
    const workouts = [{
      startedAt: new Date(NOW - 86400000).toISOString(), modality: 'resistance',
      completed: { 0: [{ reps: 12 }, { reps: 12 }] },
    }];
    expect(strengthIndex(workouts, { at: NOW }).volume).toBe(24);
  });

  it('ignores cardio and anything outside the window', () => {
    const workouts = [
      { startedAt: new Date(NOW - 86400000).toISOString(), modality: 'cardio', completed: { 0: [{ reps: 50 }] } },
      { startedAt: new Date(NOW - 60 * 86400000).toISOString(), modality: 'resistance', completed: { 0: [{ reps: 10 }] } },
    ];
    expect(strengthIndex(workouts, { at: NOW }).volume).toBe(0);
  });
});

describe('avatar', () => {
  it('is driven by measured posture markers', () => {
    const s = avatarState({ posture: { markers: ['forwardHead', 'anteriorPelvicTilt'] }, bodyFatPct: 25 });
    expect(s.headOffset).toBeGreaterThan(0);
    expect(s.pelvicTilt).toBeGreaterThan(0);
    expect(s.shoulderRound).toBe(0);
  });

  // A diagram that visibly exaggerates someone's body is a body-image problem,
  // not a progress tracker.
  it('keeps torso width in a deliberately narrow band', () => {
    const lean = avatarState({ bodyFatPct: 12 });
    const heavy = avatarState({ bodyFatPct: 40 });
    expect(heavy.torsoWidth - lean.torsoWidth).toBeLessThanOrEqual(12);
  });

  it('renders valid standalone SVG', () => {
    const svg = renderAvatarSvg(avatarState({ posture: { markers: [] }, bodyFatPct: 22 }));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    expect(svg).toContain('role="img"');
  });

  it('knows when it has nothing to draw from', () => {
    expect(avatarState({}).hasData).toBe(false);
  });
});

describe('photo album guidance', () => {
  it('specifies relaxed, not flexed', () => {
    expect(POSE_GUIDE.front.instruction).toMatch(/not flexed/i);
    expect(CAPTURE_RULES.join(' ')).toMatch(/never flexed/i);
  });

  it('promises photos stay on the device and strips metadata', () => {
    expect(ALBUM_PRIVACY_NOTE).toMatch(/never uploaded/i);
    expect(ALBUM_PRIVACY_NOTE).toMatch(/metadata are stripped/i);
  });
});

// ── Local day boundaries ───────────────────────────────────────────────────
// The bug: UTC day keys filed every Miami evening reading under the next day,
// silently corrupting TIR, day-type comparison, sleep pairing and night windows.

import { localDayKey, localHour, addDays, detectZoneShifts } from '../src/lib/util/localDay.js';

describe('local day boundaries', () => {
  const MIAMI = 'America/New_York';

  it('files a late-evening reading under the correct local day', () => {
    // 20:30 on Aug 3 in Miami is 00:30 UTC on Aug 4.
    const evening = new Date('2026-08-04T00:30:00Z');
    expect(localDayKey(evening, MIAMI)).toBe('2026-08-03');
    expect(evening.toISOString().slice(0, 10)).toBe('2026-08-04'); // the old, wrong answer
  });

  it('returns local hour, which night windows depend on', () => {
    expect(localHour(new Date('2026-08-04T03:00:00Z'), MIAMI)).toBe(23);
    expect(localHour(new Date('2026-08-04T03:00:00Z'), 'UTC')).toBe(3);
  });

  it('handles unusable input without throwing', () => {
    expect(localDayKey('nonsense', MIAMI)).toBe('');
    expect(localHour(undefined, MIAMI)).toBeNull();
  });

  it('adds days without drifting', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('flags travel, which makes a day an unusual length', () => {
    const readings = [
      { timestamp: '2026-03-07T18:00:00Z' },
      { timestamp: '2026-03-09T18:00:00Z' }, // US DST change weekend
    ];
    expect(Array.isArray(detectZoneShifts(readings, MIAMI))).toBe(true);
  });
});

// ── Ketones and sick day ───────────────────────────────────────────────────

import {
  shouldCheckKetones, assessKetones, sickDayState, ketoneBandFor, KETONE_LEVEL,
} from '../src/lib/cgm/ketones.js';

describe('ketones', () => {
  const highSeries = Array.from({ length: 30 }, (_, i) => ({
    timestamp: new Date(NOW - (29 - i) * 4 * 60000).toISOString(), value: 280,
  }));

  it('prompts a test after sustained high glucose', () => {
    const r = shouldCheckKetones({ history: highSeries, now: NOW });
    expect(r.check).toBe(true);
    expect(r.urgency).toBe('prompt');
  });

  it('does not nag when tested recently', () => {
    const r = shouldCheckKetones({
      history: highSeries, lastKetoneAt: new Date(NOW - 30 * 60000).toISOString(), now: NOW,
    });
    expect(r.check).toBe(false);
  });

  it('prompts at lower glucose when unwell, because illness raises the risk', () => {
    const mild = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(NOW - (29 - i) * 4 * 60000).toISOString(), value: 200,
    }));
    expect(shouldCheckKetones({ history: mild, sickDay: true, now: NOW }).check).toBe(true);
  });

  it('treats high ketones as an emergency', () => {
    const a = assessKetones({ ketonesMmol: 3.4, glucoseMgdl: 320 });
    expect(a.emergency).toBe(true);
    expect(a.tone).toBe('emergency');
    expect(a.actions.join(' ')).toMatch(/emergency services|diabetes team/i);
  });

  // Euglycaemic DKA is the presentation most often missed.
  it('still escalates moderate ketones with near-normal glucose', () => {
    const a = assessKetones({ ketonesMmol: 2.0, glucoseMgdl: 150 });
    expect(a.emergency).toBe(true);
    expect(a.detail).toMatch(/SGLT2/i);
  });

  it('bands readings correctly', () => {
    expect(ketoneBandFor(0.2).level).toBe(KETONE_LEVEL.NEGATIVE);
    expect(ketoneBandFor(1.0).level).toBe(KETONE_LEVEL.TRACE);
    expect(ketoneBandFor(2.0).level).toBe(KETONE_LEVEL.MODERATE);
    expect(ketoneBandFor(4.0).level).toBe(KETONE_LEVEL.HIGH);
  });

  it('never suggests an insulin dose', () => {
    const texts = [1.0, 2.0, 3.5].map(k => JSON.stringify(assessKetones({ ketonesMmol: k }))).join(' ');
    expect(texts).not.toMatch(/units|take \d|increase your (insulin|dose)/i);
  });
});

describe('sick-day mode', () => {
  it('suppresses training and marks data for exclusion', () => {
    const s = sickDayState({ enabled: true, startedAt: new Date(NOW - 3600000).toISOString(), now: NOW });
    expect(s.effects.suppressWorkoutPrompts).toBe(true);
    expect(s.effects.excludeFromAnalytics).toBe(true);
  });

  // The single most important sick-day instruction.
  it('says never to stop basal insulin', () => {
    const s = sickDayState({ enabled: true, now: NOW });
    expect(s.guidance.join(' ')).toMatch(/never stop your basal/i);
  });

  it('is inert when off', () => {
    expect(sickDayState({ enabled: false }).active).toBe(false);
  });
});

// ── Treatment effectiveness and missed basal ───────────────────────────────

import { analyzeTreatment, treatmentReview, basalPattern, checkMissedBasal } from '../src/lib/insulin/treatment.js';

describe('hypo treatment', () => {
  const series = (from, to) => {
    const out = [];
    for (let m = -10; m <= 45; m += 5) {
      const frac = Math.max(0, Math.min(1, m / 15));
      out.push({ timestamp: new Date(NOW + m * 60000).toISOString(), value: from + (to - from) * frac });
    }
    return out;
  };

  it('measures the rise per gram', () => {
    const r = analyzeTreatment({ takenAt: new Date(NOW).toISOString(), carbsGrams: 15 }, series(60, 105));
    expect(r.rise15).toBeGreaterThan(30);
    expect(r.perGram).toBeGreaterThan(2);
  });

  it('flags a treatment that left the user still low', () => {
    const r = analyzeTreatment({ takenAt: new Date(NOW).toISOString(), carbsGrams: 10 }, series(55, 66));
    expect(r.stillLow).toBe(true);
  });

  it('flags an over-treatment rebound', () => {
    const r = analyzeTreatment({ takenAt: new Date(NOW).toISOString(), carbsGrams: 45 }, series(62, 230));
    expect(r.rebound).toBe(true);
  });

  it('stays silent until there are enough treatments', () => {
    const few = [{ takenAt: new Date(NOW).toISOString(), carbsGrams: 15 }];
    expect(treatmentReview(few, series(60, 100)).enough).toBe(false);
  });
});

describe('missed basal', () => {
  const dose = (hoursAgo, hourLocal) => ({
    category: 'basal', units: 22,
    takenAt: new Date(Date.UTC(2026, 7, 4 - Math.ceil(hoursAgo / 24), hourLocal, 0, 0)).toISOString(),
  });

  it('needs an established pattern before it will ask', () => {
    expect(checkMissedBasal([dose(24, 22)], { now: NOW }).prompt).toBe(false);
  });

  it('learns the usual time from history', () => {
    const doses = [1, 2, 3, 4, 5, 6].map(d => ({
      category: 'basal', units: 22,
      takenAt: new Date(Date.UTC(2026, 7, 4 - d, 22, 0, 0)).toISOString(),
    }));
    const p = basalPattern(doses, { timeZone: 'UTC' });
    expect(p.known).toBe(true);
    expect(p.usualHour).toBe(22);
  });

  // Never tells anyone to take it — a double dose is its own emergency.
  it('never instructs a dose', () => {
    const doses = [1, 2, 3, 4, 5, 6].map(d => ({
      category: 'basal', units: 22,
      takenAt: new Date(Date.UTC(2026, 7, 4 - d, 10, 0, 0)).toISOString(),
    }));
    const r = checkMissedBasal(doses, { timeZone: 'UTC', now: Date.UTC(2026, 7, 4, 14, 0, 0) });
    if (r.prompt) {
      expect(r.guidance).toMatch(/do not simply double up/i);
      expect(r.guidance).not.toMatch(/take it now|inject now/i);
    }
  });
});
