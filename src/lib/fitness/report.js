// ═══════════════════════════════════════════════════════════════════════════
// Endocrinologist visit export.
//
// This is su94r's purpose made concrete. The app does not advise on insulin —
// it gives your care team better inputs so they can. Turning "I've been
// exercising more" into a page of evidence is the most useful thing it does
// with the data it holds.
//
// Contents follow what clinicians actually look at in a CGM review: time in
// range, variability (CV), hypo count and timing, then the exercise context
// that a standard CGM report cannot show.
//
// Every number is measured or plainly derived. Nothing is modelled, projected
// or inferred — a clinician has to be able to trust the page at a glance, and
// a single invented figure would poison the whole thing.
// ═══════════════════════════════════════════════════════════════════════════

import { dailyGlucoseStats, timeInRangeByDayType, trainingEffect, sleepVsNextDay } from './analytics.js';
import { analyzeAll, summarizeByModality } from './correlate.js';

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));

/**
 * Assembles the report. Pure — takes store data, returns a plain object.
 *
 * @param {object} opts
 * @param {Array}  opts.history    glucose.history
 * @param {Array}  opts.workouts   metrics.workouts
 * @param {Array}  [opts.sleep]    health_samples rows, type 'sleepAnalysis'
 * @param {Array}  [opts.weight]   metrics.weight
 * @param {number} [opts.days]     Reporting window.
 */
export function buildReport({
  history = [],
  workouts = [],
  sleep = [],
  weight = [],
  days = 90,
  unit = 'mgdl',
  thresholds = {},
  now = Date.now(),
} = {}) {
  const { low = 70, high = 180, veryLow = 55 } = thresholds;
  const since = now - days * 86_400_000;

  const windowHistory = history.filter(r => new Date(r.timestamp).getTime() >= since);
  const windowWorkouts = workouts.filter(w => new Date(w.startedAt).getTime() >= since);

  const statsOpts = { unit, low, high, veryLow };
  const daily = dailyGlucoseStats(windowHistory, statsOpts);
  const byType = timeInRangeByDayType(windowWorkouts, windowHistory, statsOpts);
  const effect = trainingEffect(byType);

  const analyses = analyzeAll(windowWorkouts, windowHistory, { unit, lowThreshold: low });
  const summaries = summarizeByModality(analyses);
  const sleepFinding = sleepVsNextDay(sleep, windowHistory, statsOpts);

  const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  // Hypos grouped by hour, so a clinician can see WHEN they cluster. Overnight
  // lows and post-lunch lows have completely different causes.
  const hypoHours = new Array(24).fill(0);
  for (const r of windowHistory) {
    const v = unit === 'mmol' ? r.value * 18 : r.value;
    if (v < low) hypoHours[new Date(r.timestamp).getHours()]++;
  }

  const weights = weight
    .filter(w => new Date(w.timestamp || w.date).getTime() >= since)
    .map(w => Number(w.value))
    .filter(Number.isFinite);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    unit,
    thresholds: { low, high, veryLow },

    glucose: {
      daysWithData: daily.length,
      tir: avg(daily.map(d => d.tir)),
      below: avg(daily.map(d => d.below)),
      above: avg(daily.map(d => d.above)),
      meanGlucose: avg(daily.map(d => d.mean)),
      cv: avg(daily.map(d => d.cv).filter(v => v != null)),
      severeLowReadings: daily.reduce((n, d) => n + d.veryLowEvents, 0),
      hypoByHour: hypoHours,
    },

    exercise: {
      sessions: windowWorkouts.length,
      withGlucoseCoverage: analyses.length,
      byModality: summaries,
      // The clinically interesting one: sessions followed by a low.
      sessionsFollowedByLow: analyses.filter(a => a.hypoDuring || a.hypoAfter2h).length,
      eveningSessions: analyses.filter(a => a.endedHour >= 16).length,
      eveningFollowedByOvernightLow: analyses.filter(a => a.endedHour >= 16 && a.hypoOvernight).length,
    },

    dayType: byType,
    trainingEffect: effect,
    sleep: sleepFinding,

    body: weights.length
      ? { first: weights[weights.length - 1], last: weights[0], samples: weights.length }
      : null,
  };
}

/**
 * Renders the report as a self-contained printable HTML document.
 *
 * Deliberately plain: black on white, system fonts, no colour coding beyond a
 * single accent. It gets printed or handed over on a phone screen in a short
 * appointment, and su94r's dark cyberpunk styling would actively hurt there.
 */
export function renderReportHtml(report) {
  const u = report.unit === 'mmol' ? 'mmol/L' : 'mg/dL';
  const g = report.glucose;
  const e = report.exercise;

  const peakHypoHours = g.hypoByHour
    .map((count, hour) => ({ hour, count }))
    .filter(h => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(h => `${String(h.hour).padStart(2, '0')}:00`)
    .join(', ');

  const dayTypeRows = report.dayType
    .map(
      d => `<tr><td>${d.type}</td><td>${d.days}</td><td>${pct(d.tir)}</td>
             <td>${pct(d.below)}</td><td>${num(d.meanGlucose)}</td><td>${num(d.cv, 1)}%</td></tr>`
    )
    .join('');

  const modalityRows = report.exercise.byModality
    .map(
      m => `<tr><td>${m.modality}</td><td>${m.sessions}</td>
             <td>${m.medianDeltaDuring == null ? '—' : (m.medianDeltaDuring > 0 ? '+' : '') + Math.round(m.medianDeltaDuring)}</td>
             <td>${Math.round(m.hypoRate * 100)}%</td></tr>`
    )
    .join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>su94r — glucose and exercise summary</title>
<style>
  body { font: 14px/1.55 -apple-system, Segoe UI, Roboto, sans-serif; color:#111; max-width:760px; margin:32px auto; padding:0 20px; }
  h1 { font-size:20px; margin:0 0 2px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#666; margin:26px 0 8px; border-bottom:1px solid #ddd; padding-bottom:4px; }
  .sub { color:#666; font-size:12px; margin-bottom:4px; }
  table { border-collapse:collapse; width:100%; margin:6px 0 4px; }
  th, td { text-align:left; padding:5px 8px; border-bottom:1px solid #eee; font-variant-numeric:tabular-nums; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#666; }
  .kpis { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0; }
  .kpi { border:1px solid #ddd; border-radius:8px; padding:10px 14px; min-width:110px; }
  .kpi b { display:block; font-size:20px; font-variant-numeric:tabular-nums; }
  .kpi span { font-size:11px; color:#666; }
  .note { background:#f6f6f6; border-left:3px solid #888; padding:10px 12px; margin:10px 0; font-size:13px; }
  footer { margin-top:28px; padding-top:10px; border-top:1px solid #ddd; color:#666; font-size:11px; }
  @media print { body { margin:0; } .noprint { display:none; } }
</style>

<h1>Glucose and exercise summary</h1>
<div class="sub">${report.windowDays} days to ${new Date(report.generatedAt).toLocaleDateString()} ·
  ${g.daysWithData} days with CGM coverage · target ${report.thresholds.low}–${report.thresholds.high} ${u}</div>

<h2>Glucose control</h2>
<div class="kpis">
  <div class="kpi"><b>${pct(g.tir)}</b><span>time in range</span></div>
  <div class="kpi"><b>${pct(g.below)}</b><span>below range</span></div>
  <div class="kpi"><b>${pct(g.above)}</b><span>above range</span></div>
  <div class="kpi"><b>${num(g.meanGlucose)}</b><span>mean ${u}</span></div>
  <div class="kpi"><b>${num(g.cv, 1)}%</b><span>CV${g.cv != null && g.cv < 36 ? ' (≤36 target)' : ''}</span></div>
</div>
${peakHypoHours ? `<p class="sub">Low readings cluster around: <strong>${peakHypoHours}</strong>. Severe (&lt;${report.thresholds.veryLow}): ${g.severeLowReadings} readings.</p>` : ''}

<h2>Exercise</h2>
<div class="kpis">
  <div class="kpi"><b>${e.sessions}</b><span>sessions logged</span></div>
  <div class="kpi"><b>${e.withGlucoseCoverage}</b><span>with CGM coverage</span></div>
  <div class="kpi"><b>${e.sessionsFollowedByLow}</b><span>followed by a low</span></div>
  <div class="kpi"><b>${e.eveningFollowedByOvernightLow}/${e.eveningSessions}</b><span>evening → overnight low</span></div>
</div>
${modalityRows ? `<table><tr><th>Type</th><th>Sessions</th><th>Median change during (${u})</th><th>Low within 2h</th></tr>${modalityRows}</table>` : '<p class="sub">No sessions with glucose coverage yet.</p>'}

<h2>Control by day type</h2>
${dayTypeRows ? `<table><tr><th>Day</th><th>Days</th><th>TIR</th><th>Below</th><th>Mean</th><th>CV</th></tr>${dayTypeRows}</table>` : '<p class="sub">Not enough data yet.</p>'}
${report.trainingEffect ? `<div class="note">${report.trainingEffect.text}</div>` : ''}
${report.sleep?.enough ? `<div class="note">${report.sleep.text}</div>` : ''}

<footer>
  Generated by su94r from the wearer's own CGM and exercise logs. Figures are measured or
  directly derived — none are modelled or predicted. su94r does not recommend insulin doses
  and is not a medical device.
</footer>`;
}
