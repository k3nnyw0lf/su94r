// The learner: from one person's own readings, markers and health-vault data it works out
// how much, and when, each kind of insulin lowers their glucose, how much carbs raise it,
// what exercise, walking, a raised heart rate and short sleep do, and how glucose drifts at
// each time of day. Then it draws the estimate line forward.
//
// Model, per 15-minute step:
//   change = − Σ ISF[kind] · units used + CSF · grams absorbed − EX · exercise minutes
//            − ST · thousands of steps − HR · minutes of raised heart rate
//            + SL · hours of sleep lost last night + drift[time of day] + noise
// "Units used" follows the standard exponential insulin curve (insulin.js); each kind's peak
// time and the carb absorption time are chosen by trying a few and keeping the best fit.
// Weights come from robust Bayesian regression: starting values (priors) keep it sensible
// with little data, and odd readings (compression lows, unlogged meals) count for less.
// A factor joins only when there is data for it. Before its line is shown, the learner is
// checked against what really happened on data it did not learn from.
//
// It describes what has happened before. It is never a dosing instruction.
// Pure functions: no chrome APIs, so the same code runs in tests.

import { activeFraction } from './insulin.js';

const STEP = 15;                       // minutes per learning step
const MIN = 60e3;
export const LEARN_DAYS = 30;

// Insulin groups that are learned. Long-acting insulin is nearly flat, so its effect cannot
// be told apart from the background drift; it is part of the drift.
export const GROUPS = ['rapid', 'short', 'intermediate'];
const GROUP_OF = {
  rapid: [['rapid', 1]],
  short: [['short', 1]],
  intermediate: [['intermediate', 1]],
  // Pre-mixed: roughly 30% fast part, 70% NPH part.
  mix: [['short', 0.3], ['intermediate', 0.7]],
  basal: [],
};
const groupsFor = (kind) => GROUP_OF[kind || 'rapid'] || GROUP_OF.rapid;

// Peak times tried per group (minutes); duration follows from the peak.
const PEAKS = { rapid: [45, 60, 75, 95, 120], short: [90, 120, 150, 190, 240], intermediate: [240, 360, 480, 600] };
const durationFor = (group, peak) => ({
  rapid: Math.min(480, Math.max(300, peak * 4.8)),
  short: Math.min(660, Math.max(360, peak * 3.2)),
  intermediate: Math.min(1200, Math.max(720, peak * 2.5)),
}[group]);
const ABSORB = [120, 180, 240, 300];   // carb absorption times tried (minutes)

// Every factor the learner knows. Adding a data source is one entry here plus its column in
// featuresFor. `prior` is [starting value, how unsure], in mg/dL per `per` (drift: per
// 15-minute step). `positive` factors can only push one way, so their weight is a size.
export const FACTORS = {
  rapid: { prior: [40, 30], positive: true, min: 4, label: 'rapid insulin', per: 'unit' },
  short: { prior: [40, 30], positive: true, min: 4, label: 'regular insulin', per: 'unit' },
  intermediate: { prior: [25, 25], positive: true, min: 4, label: 'NPH insulin', per: 'unit' },
  carbs: { prior: [4, 3], positive: true, min: 4, label: 'carbs', per: 'gram' },
  exercise: { prior: [0.7, 1], positive: true, min: 3, label: 'exercise', per: 'minute' },
  steps: { prior: [3, 5], min: 2, label: 'walking', per: '1,000 steps' },
  heartUp: { prior: [0.3, 0.6], min: 2, label: 'raised heart rate', per: 'minute' },
  shortSleep: { prior: [0, 2], min: 4, label: 'short sleep', per: 'hour of sleep lost, per 15 minutes the next day' },
  heat: { prior: [0, 0.5], min: 3, label: 'heat', per: '°C above 28 °C (82 °F) outside, per 15 minutes' },
  night: { prior: [0, 6], drift: true, label: 'midnight to 6 AM' },
  morning: { prior: [0, 6], drift: true, label: '6 AM to noon' },
  afternoon: { prior: [0, 6], drift: true, label: 'noon to 6 PM' },
  evening: { prior: [0, 6], drift: true, label: '6 PM to midnight' },
};
export const DRIFT = ['night', 'morning', 'afternoon', 'evening'];
const MIN_ROWS = 96;                   // a day of steps

const bucketOf = (t, hourOf) => Math.floor(hourOf(t) / 6); // 0 night, 1 morning, 2 afternoon, 3 evening
const localHour = (t) => new Date(t).getHours();

/** Fraction of a dose not yet used `m` minutes after it was given (1 before it is given). */
const remaining = (m, curve) => (m < 0 ? 1 : activeFraction(m, curve));

/** Share of a meal's carbs absorbed `m` minutes after it, over `T` minutes (rate rises, then falls). */
export function absorbed(m, T) {
  if (m <= 0) return 0;
  if (m >= T) return 1;
  const x = m / T;
  return x <= 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/**
 * Sleep samples merged into nights: { wake, lostHours } (lost = short of 7 hours). A sample's
 * value is the minutes actually asleep (time in bed minus awake), which is what counts.
 */
function nights(samples) {
  const spans = samples.map((h) => {
    const end = h.end > h.t ? h.end : h.t + h.value * MIN;
    return { t: h.t, end, asleep: Math.max(0, Math.min(h.value * MIN, end - h.t)) };
  }).sort((a, b) => a.t - b.t);
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.t - last.end < 3 * 3600e3) { last.end = Math.max(last.end, s.end); last.asleep += s.asleep; }
    else out.push({ t: s.t, end: s.end, asleep: s.asleep });
  }
  return out.filter((n) => n.asleep >= 2 * 3600e3).map((n) => ({ wake: n.end, lostHours: Math.max(0, 7 - n.asleep / 3600e3) }));
}

/**
 * Splits markers and health-vault samples ({ type, t, end?, value }) into what the learner uses.
 * Workouts from a watch count as exercise unless a marker already covers that time. With
 * `until`, only what was known by then is used (outdoor temperature, being a forecast, stays).
 */
export function inputsFrom(events, pid, health = [], { until = Infinity } = {}) {
  const mine = (events || []).filter((e) => e.p === pid && Number.isFinite(e.t) && e.t <= until);
  const of = (type) => (health || []).filter((h) => h.type === type && Number.isFinite(h.t) && Number.isFinite(h.value) && (h.t <= until || type === 'outdoorTemp'));
  const marked = mine.filter((e) => e.type === 'exercise' && Number(e.amount) > 0).map((e) => ({ t: e.t, end: e.t + Number(e.amount) * MIN }));
  const workouts = of('workout').map((w) => ({ t: w.t, end: w.end > w.t ? w.end : w.t + w.value * MIN }))
    .filter((w) => !marked.some((m) => m.t < w.end && w.t < m.end));
  const heart = of('heartRate').sort((a, b) => a.t - b.t);
  const resting = heart.length >= 30 ? quantile(heart.map((h) => h.value), 0.1) : null;
  return {
    doses: mine.filter((e) => e.type === 'insulin' && Number(e.amount) > 0).map((e) => ({ t: e.t, kind: e.kind || 'rapid', units: Number(e.amount) })),
    meals: mine.filter((e) => e.type === 'meal' && Number(e.amount) > 0).map((e) => ({ t: e.t, grams: Number(e.amount) })),
    exercise: [...marked, ...workouts].sort((a, b) => a.t - b.t),
    // Step counts are intervals; a count with no end is spread over the next 15 minutes.
    steps: of('steps').map((h) => ({ t: h.t, end: h.end > h.t ? h.end : h.t + STEP * MIN, count: h.value })).sort((a, b) => a.t - b.t),
    // Minutes with heart rate 30 beats or more over resting, merged into spans (a watch can
    // report every few seconds; each minute counts once).
    heartUp: resting == null ? [] : minuteSpans(heart.filter((h) => h.value >= resting + 30).map((h) => h.t)),
    sleep: nights(of('sleepAnalysis')),
    // Outdoor temperature above 28 °C (82 °F), hour by hour (weather.js).
    heat: of('outdoorTemp').map((h) => ({ t: h.t, end: h.end > h.t ? h.end : h.t + 3600e3, over: h.value - 28 })).filter((h) => h.over > 0).sort((a, b) => a.t - b.t),
  };
}

/** Times → one-minute spans, adjacent minutes merged. */
function minuteSpans(times) {
  const minutes = [...new Set(times.map((t) => Math.floor(t / MIN)))].sort((a, b) => a - b);
  const out = [];
  for (const m of minutes) {
    const last = out[out.length - 1];
    if (last && last.end === m * MIN) last.end += MIN;
    else out.push({ t: m * MIN, end: (m + 1) * MIN });
  }
  return out;
}

/** Only the inputs that can touch [from, to] (doses up to a day before, for slow insulin). */
function narrow(inp, from, to) {
  const span = (x) => x.end > from && x.t < to;
  return {
    doses: inp.doses.filter((d) => d.t > from - 24 * 3600e3 && d.t < to),
    meals: inp.meals.filter((m) => m.t > from - 6 * 3600e3 && m.t < to),
    exercise: inp.exercise.filter(span), steps: inp.steps.filter(span), heartUp: inp.heartUp.filter(span),
    sleep: inp.sleep.filter((n) => n.wake + 16 * 3600e3 > from && n.wake < to),
    heat: inp.heat.filter(span),
  };
}

/** What was known at `t`: nothing logged later (outdoor temperature, a forecast, stays). */
function knownAt(inp, t) {
  return {
    ...inp,
    doses: inp.doses.filter((d) => d.t <= t), meals: inp.meals.filter((m) => m.t <= t),
    exercise: inp.exercise.filter((x) => x.t <= t), steps: inp.steps.filter((x) => x.t <= t),
    heartUp: inp.heartUp.filter((x) => x.t <= t), sleep: inp.sleep.filter((n) => n.wake <= t),
  };
}

// ---- features over a time span ----

function insulinUsed(doses, group, s, e, curve) {
  let u = 0;
  for (const d of doses) {
    if (d.t > e) continue;
    for (const [g, frac] of groupsFor(d.kind)) {
      if (g !== group) continue;
      const ms = (s - d.t) / MIN, me = (e - d.t) / MIN;
      if (ms >= curve.durationMin) continue;
      u += d.units * frac * (remaining(ms, curve) - remaining(me, curve));
    }
  }
  return u;
}

function carbsAbsorbed(meals, s, e, T) {
  let g = 0;
  for (const m of meals) {
    if (m.t > e || (s - m.t) / MIN >= T) continue;
    g += m.grams * (absorbed((e - m.t) / MIN, T) - absorbed((s - m.t) / MIN, T));
  }
  return g;
}

/** Minutes of [s, e] covered by spans. */
function overlapMinutes(spans, s, e) {
  let min = 0;
  for (const x of spans) if (x.t < e && x.end > s) min += (Math.min(e, x.end) - Math.max(s, x.t)) / MIN;
  return min;
}

/** Thousands of steps in [s, e], each interval's count spread evenly over it. */
function stepsIn(spans, s, e) {
  let n = 0;
  for (const x of spans) if (x.t < e && x.end > s) n += (x.count * (Math.min(e, x.end) - Math.max(s, x.t))) / (x.end - x.t);
  return n / 1000;
}

/** Hours of sleep lost last night, over the 16 waking hours after it, per 15-minute step. */
function sleepDebt(sleep, s, e) {
  let v = 0;
  for (const n of sleep) {
    if (!n.lostHours || s >= n.wake + 16 * 3600e3 || e <= n.wake) continue;
    v += (n.lostHours * (Math.min(e, n.wake + 16 * 3600e3) - Math.max(s, n.wake))) / (STEP * MIN);
  }
  return v;
}

/** The feature vector for [s, e]: one entry per factor in `keys` (signs make weights sizes). */
function featuresFor(inp, s, e, timing, hourOf, keys) {
  const v = new Array(keys.length).fill(0);
  keys.forEach((k, i) => {
    if (GROUPS.includes(k)) v[i] = -insulinUsed(inp.doses, k, s, e, timing[k]);
    else if (k === 'carbs') v[i] = carbsAbsorbed(inp.meals, s, e, timing.absorbMin);
    else if (k === 'exercise') v[i] = -overlapMinutes(inp.exercise, s, e);
    else if (k === 'steps') v[i] = -stepsIn(inp.steps, s, e);
    else if (k === 'heartUp') v[i] = -overlapMinutes(inp.heartUp, s, e);
    else if (k === 'shortSleep') v[i] = sleepDebt(inp.sleep, s, e);
    else if (k === 'heat') v[i] = inp.heat.reduce((a, h) => a + (h.t < e && h.end > s ? (h.over * (Math.min(e, h.end) - Math.max(s, h.t))) / (STEP * MIN) : 0), 0);
  });
  // Drift: 15-minute steps spent in each part of the day.
  for (let t = s; t < e - 1; t += STEP * MIN) {
    const i = keys.indexOf(DRIFT[bucketOf(t, hourOf)]);
    if (i >= 0) v[i] += Math.min(STEP * MIN, e - t) / (STEP * MIN);
  }
  return v;
}

// ---- readings on a 15-minute grid ----

/** Readings snapped to a 15-minute grid (closest reading within 8 minutes), as rows of change. */
export function gridRows(points, from = -Infinity, to = Infinity) {
  const pts = points.filter((p) => p.t >= from - STEP * MIN && p.t <= to + STEP * MIN && p.mg >= 40 && p.mg <= 400).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return [];
  const start = Math.ceil(pts[0].t / (STEP * MIN)) * STEP * MIN;
  const grid = new Map();
  let j = 0;
  for (let g = start; g <= pts[pts.length - 1].t; g += STEP * MIN) {
    while (j + 1 < pts.length && Math.abs(pts[j + 1].t - g) <= Math.abs(pts[j].t - g)) j++;
    if (Math.abs(pts[j].t - g) <= 8 * MIN) grid.set(g, pts[j].mg);
  }
  const rows = [];
  for (const [g, mg] of grid) {
    const next = grid.get(g + STEP * MIN);
    if (next == null || g < from || g >= to) continue;
    const dy = next - mg;
    if (Math.abs(dy) > 60) continue;  // a jump no body makes in 15 minutes: sensor trouble
    rows.push({ s: g, e: g + STEP * MIN, y: dy });
  }
  return rows;
}

// ---- small linear algebra ----

function cholesky(A) {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(sum, 1e-12));
      else L[i][j] = sum / L[j][j];
    }
  }
  return L;
}

function cholSolve(L, b) {
  const n = L.length, y = new Array(n), x = new Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

function inverse(L) {
  const n = L.length;
  return Array.from({ length: n }, (_, i) => cholSolve(L, Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Robust Bayesian linear regression: Gaussian priors from FACTORS, Huber weights (IRLS).
 * Returns { w, cov, sigma, loss }; loss is the Huber loss at a fixed `scale` when given.
 */
function fitWeights(X, y, keys, scale = null) {
  const p = keys.length;
  const mean = keys.map((k) => FACTORS[k].prior[0]);
  const sdv = keys.map((k) => FACTORS[k].prior[1]);
  let wts = new Array(y.length).fill(1);
  let w = [...mean], sigma = 10, cov = null;
  for (let iter = 0; iter < 5; iter++) {
    const A = sdv.map((sd, i) => { const row = new Array(p).fill(0); row[i] = 1 / (sd * sd); return row; });
    const b = mean.map((m, i) => m / (sdv[i] ** 2));
    const s2 = sigma * sigma;
    for (let r = 0; r < X.length; r++) {
      const x = X[r], k = wts[r] / s2;
      for (let i = 0; i < p; i++) {
        if (!x[i]) continue;
        b[i] += k * x[i] * y[r];
        for (let j = 0; j <= i; j++) A[i][j] += k * x[i] * x[j];
      }
    }
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) A[i][j] = A[j][i];
    const L = cholesky(A);
    w = cholSolve(L, b);
    cov = inverse(L);
    const res = X.map((x, r) => y[r] - dot(x, w));
    const s = 1.4826 * median(res.map(Math.abs)) || 1;
    wts = res.map((v) => Math.min(1, (1.5 * s) / Math.max(Math.abs(v), 1e-9)));
    const sw = wts.reduce((a, v) => a + v, 0);
    sigma = Math.max(1, Math.sqrt(res.reduce((a, v, r) => a + wts[r] * v * v, 0) / Math.max(sw, 1)));
  }
  const c = scale ?? sigma;
  const loss = X.reduce((a, x, r) => {
    const v = Math.abs(y[r] - dot(x, w));
    return a + (v <= 1.5 * c ? 0.5 * v * v : 1.5 * c * (v - 0.75 * c));
  }, 0);
  return { w, cov, sigma, loss };
}

// ---- learning ----

const defaultTiming = (rapidPeak = 75) => ({
  rapid: { peakMin: rapidPeak, durationMin: durationFor('rapid', rapidPeak) },
  short: { peakMin: 150, durationMin: durationFor('short', 150) },
  intermediate: { peakMin: 360, durationMin: durationFor('intermediate', 360) },
  absorbMin: 180,
});

// ---- the design matrix, built column by column ----
// Rows are 15-minute steps on a fixed grid. Columns that do not depend on insulin or carb
// timing are built once per fit by sweeping each span over the steps it touches; only the
// insulin and carb columns are rebuilt when a timing is tried. This keeps a month with a
// watch reporting every few seconds well under a second.

const STEP_MS = STEP * MIN;

function staticColumns(inp, rows, keys, hourOf) {
  const index = new Map(rows.map((r, i) => [r.s, i]));
  const spanCol = (spans, weight) => {
    const c = new Float64Array(rows.length);
    for (const x of spans) {
      for (let g = Math.floor(x.t / STEP_MS) * STEP_MS; g < x.end; g += STEP_MS) {
        const i = index.get(g);
        if (i == null) continue;
        const ov = Math.min(g + STEP_MS, x.end) - Math.max(g, x.t);
        if (ov > 0) c[i] += weight(x, ov);
      }
    }
    return c;
  };
  const cols = {};
  for (const k of keys) {
    if (k === 'exercise') cols[k] = spanCol(inp.exercise, (x, ov) => -ov / MIN);
    else if (k === 'heartUp') cols[k] = spanCol(inp.heartUp, (x, ov) => -ov / MIN);
    else if (k === 'steps') cols[k] = spanCol(inp.steps, (x, ov) => -(x.count * ov) / (x.end - x.t) / 1000);
    else if (k === 'heat') cols[k] = spanCol(inp.heat, (x, ov) => (x.over * ov) / STEP_MS);
    else if (k === 'shortSleep') cols[k] = spanCol(inp.sleep.filter((n) => n.lostHours).map((n) => ({ t: n.wake, end: n.wake + 16 * 3600e3, lost: n.lostHours })), (x, ov) => (x.lost * ov) / STEP_MS);
    else if (FACTORS[k].drift) { const b = DRIFT.indexOf(k); cols[k] = Float64Array.from(rows, (r) => (bucketOf(r.s, hourOf) === b ? 1 : 0)); }
  }
  return cols;
}

/** One insulin group's column: units used in each step (negative), for a given curve. */
function insulinColumn(inp, rows, group, curve) {
  const doses = inp.doses.map((d) => ({ d, frac: groupsFor(d.kind).find(([g]) => g === group)?.[1] })).filter((x) => x.frac).sort((a, b) => a.d.t - b.d.t);
  const c = new Float64Array(rows.length);
  let lo = 0;
  for (let i = 0; i < rows.length; i++) {
    const { s, e } = rows[i];
    while (lo < doses.length && doses[lo].d.t < s - curve.durationMin * MIN) lo++;
    for (let j = lo; j < doses.length && doses[j].d.t <= e; j++) {
      const { d, frac } = doses[j];
      c[i] -= d.units * frac * (remaining((s - d.t) / MIN, curve) - remaining((e - d.t) / MIN, curve));
    }
  }
  return c;
}

/** The carb column: grams absorbed in each step, for an absorption time. */
function carbColumn(inp, rows, T) {
  const meals = [...inp.meals].sort((a, b) => a.t - b.t);
  const c = new Float64Array(rows.length);
  let lo = 0;
  for (let i = 0; i < rows.length; i++) {
    const { s, e } = rows[i];
    while (lo < meals.length && meals[lo].t < s - T * MIN) lo++;
    for (let j = lo; j < meals.length && meals[j].t <= e; j++) c[i] += meals[j].grams * (absorbed((e - meals[j].t) / MIN, T) - absorbed((s - meals[j].t) / MIN, T));
  }
  return c;
}

const assemble = (cols, keys, n) => Array.from({ length: n }, (_, i) => keys.map((k) => cols[k][i]));
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Fits weights for the rows, choosing each kind's timing (and carb absorption) by best fit. */
async function fitWithTiming(inp, rows, { hourOf, rapidPeak, counts, keys }) {
  const y = rows.map((r) => r.y);
  const timing = defaultTiming(rapidPeak);
  const cols = staticColumns(inp, rows, keys, hourOf);
  for (const g of GROUPS) if (keys.includes(g)) cols[g] = insulinColumn(inp, rows, g, timing[g]);
  if (keys.includes('carbs')) cols.carbs = carbColumn(inp, rows, timing.absorbMin);
  const scale = fitWeights(assemble(cols, keys, rows.length), y, keys).sigma;
  let best = fitWeights(assemble(cols, keys, rows.length), y, keys, scale);
  const tryColumn = async (key, col, apply) => {
    const trial = { ...cols, [key]: col };
    const f = fitWeights(assemble(trial, keys, rows.length), y, keys, scale);
    if (f.loss < best.loss) { best = f; cols[key] = col; apply(); }
    await tick();   // let alarms and alerts run between trials
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const g of GROUPS) {
      if (!keys.includes(g) || (counts[g] || 0) < FACTORS[g].min) continue;
      for (const peak of PEAKS[g]) {
        if (peak === timing[g].peakMin) continue;
        const curve = { peakMin: peak, durationMin: durationFor(g, peak) };
        await tryColumn(g, insulinColumn(inp, rows, g, curve), () => { timing[g] = curve; });
      }
    }
    if (keys.includes('carbs') && (counts.carbs || 0) >= FACTORS.carbs.min) {
      for (const T of ABSORB) if (T !== timing.absorbMin) await tryColumn('carbs', carbColumn(inp, rows, T), () => { timing.absorbMin = T; });
    }
  }
  return { ...best, timing: JSON.parse(JSON.stringify(timing)) };
}

/** How many doses, meals, sessions, days and nights fall where there are readings to learn from. */
function countInputs(inp, rows) {
  const starts = rows.map((r) => r.s);
  const coveredShare = (t, hours) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] < t) lo = m + 1; else hi = m; }
    let n = 0;
    for (let i = lo; i < starts.length && starts[i] < t + hours * 3600e3; i++) n++;
    return n / ((hours * 60) / STEP);
  };
  const covered = (t, hours) => coveredShare(t, hours) >= 0.6;
  const counts = { rapid: 0, short: 0, intermediate: 0 };
  for (const d of inp.doses) {
    if (!covered(d.t, 4)) continue;
    for (const [g] of groupsFor(d.kind)) counts[g]++;
  }
  counts.carbs = inp.meals.filter((m) => covered(m.t, 3)).length;
  counts.exercise = inp.exercise.filter((x) => covered(x.t, 1)).length;
  const days = (spans) => new Set(spans.filter((x) => covered(x.t, 0.25)).map((x) => Math.floor(x.t / 864e5))).size;
  counts.steps = days(inp.steps);
  counts.heartUp = days(inp.heartUp);
  counts.shortSleep = inp.sleep.filter((n) => covered(n.wake, 8)).length;
  counts.heat = days(inp.heat);
  return counts;
}

/** Factors with any data join the fit; priors keep thin ones near their starting value. */
const keysFor = (counts) => [...Object.keys(FACTORS).filter((k) => !FACTORS[k].drift && counts[k] > 0), ...DRIFT];

function packModel(fit, counts, rows, keys, extra = {}) {
  // A one-way factor whose weight came out the wrong way: the data does not show it yet,
  // so it is held at a small size.
  const w = fit.w.map((v, i) => (FACTORS[keys[i]].positive ? Math.max(GROUPS.includes(keys[i]) ? 1 : 0.1, v) : v));
  const sd = (i) => Math.sqrt(Math.max(0, fit.cov[i][i]));
  const at = (k) => keys.indexOf(k);
  const kinds = {};
  for (const g of GROUPS) {
    const i = at(g);
    kinds[g] = {
      isf: i >= 0 ? w[i] : FACTORS[g].prior[0], isfSd: i >= 0 ? sd(i) : FACTORS[g].prior[1],
      peakMin: fit.timing[g].peakMin, durationMin: fit.timing[g].durationMin,
      doses: counts[g] || 0, learned: (counts[g] || 0) >= FACTORS[g].min,
    };
  }
  const effects = {};
  keys.forEach((k, i) => {
    effects[k] = { size: w[i], sd: sd(i), count: FACTORS[k].drift ? null : counts[k] || 0, learned: Boolean(FACTORS[k].drift) || (counts[k] || 0) >= FACTORS[k].min };
  });
  return {
    version: 2,
    from: rows[0]?.s ?? null,
    to: rows[rows.length - 1]?.e ?? null,
    rows: rows.length,
    sigma: fit.sigma,
    keys,
    kinds,
    carbs: { absorbMin: fit.timing.absorbMin },
    effects,
    w,
    cov: fit.cov,
    ...extra,
  };
}

/**
 * Learns one person's model from their readings (points), markers (events) and health-vault
 * samples. Returns null with too little data. `check` reports how far its 1-hour estimates
 * were from what happened on the most recent quarter, next to two plain guesses.
 */
export async function learn(points, events, pid, { now = Date.now(), days = LEARN_DAYS, hourOf = localHour, rapidPeak = 75, health = [] } = {}) {
  const rows = gridRows(points, now - days * 864e5, now);
  if (rows.length < MIN_ROWS) return null;
  const inp = inputsFrom(events, pid, health);
  const counts = countInputs(inp, rows);
  const keys = keysFor(counts);
  let check = null;
  const cut = rows[Math.floor(rows.length * 0.75)].s;
  const train = rows.filter((r) => r.s < cut);
  if (train.length >= MIN_ROWS) {
    const trainCounts = countInputs(inp, train);
    const m = packModel(await fitWithTiming(inp, train, { hourOf, rapidPeak, counts: trainCounts, keys }), trainCounts, train, keys);
    check = evaluate(points, events, pid, m, cut, now, { hourOf, health });
    await tick();
  }
  const fit = await fitWithTiming(inp, rows, { hourOf, rapidPeak, counts, keys });
  return packModel(fit, counts, rows, keys, { fittedAt: now, check, rapidPeak });
}

/** mg/dL per minute over the last 20 minutes (least squares), limited to ±4. */
export function trendSlope(points, latest) {
  const win = points.filter((p) => p.t >= latest.t - 20 * MIN && p.t <= latest.t);
  if (win.length < 2) return 0;
  const xs = win.map((p) => (p.t - latest.t) / MIN), ys = win.map((p) => p.mg);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? Math.max(-4, Math.min(4, num / den)) : 0;
}

/**
 * Mean error of 1-hour estimates between `from` and `to`, next to "stays the same" and "keeps
 * its trend". Each estimate gets only what the live line would have had at that moment: markers
 * logged up to then, last night's sleep and the outdoor temperature, nothing from later. Also
 * returns `bandScale`, how much the band must widen to hold 8 of 10 real values.
 */
export function evaluate(points, events, pid, model, from, to, { hourOf = localHour, horizonMin = 60, health = [] } = {}) {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const full = inputsFrom(events, pid, (health || []).filter((h) => h.type === 'sleepAnalysis' || h.type === 'outdoorTemp'));
  const z = [];
  let k = 0;
  const nearest = (t) => {
    while (k + 1 < sorted.length && sorted[k + 1].t <= t) k++;
    const cands = [sorted[k], sorted[k + 1]].filter((p) => p && Math.abs(p.t - t) <= 8 * MIN);
    return cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0] || null;
  };
  let n = 0, err = 0, errFlat = 0, errTrend = 0;
  for (let t = Math.ceil(from / (30 * MIN)) * 30 * MIN; t + horizonMin * MIN <= to; t += 30 * MIN) {
    const past = sorted.filter((p) => p.t <= t && p.t > t - 40 * MIN);
    if (past.length < 2 || t - past[past.length - 1].t > 8 * MIN) continue;
    const latest = past[past.length - 1];
    const truth = nearest(t + horizonMin * MIN);
    if (!truth) continue;
    const inputs = knownAt(narrow(full, t - 36 * 3600e3, t + horizonMin * MIN + 1), t);
    const f = forecast(past, null, pid, { ...model, check: null }, { latest, horizonMin, stepMin: horizonMin, hourOf, inputs });
    if (!f) continue;
    const slope = trendSlope(past, latest);
    const end = f.points[f.points.length - 1];
    if (end.sd > 0) z.push(Math.abs(end.mg - truth.mg) / end.sd);
    err += Math.abs(end.mg - truth.mg);
    errFlat += Math.abs(latest.mg - truth.mg);
    errTrend += Math.abs(Math.max(40, Math.min(400, latest.mg + slope * horizonMin)) - truth.mg);
    n++;
  }
  if (n < 12) return null;
  // Band widening: the 80th percentile of |error| / sd, against 1.28 for a normal error.
  const k80 = z.length ? [...z].sort((a, b) => a - b)[Math.floor(0.8 * (z.length - 1))] : 1.28;
  return { horizonMin, n, mae: err / n, flatMae: errFlat / n, trendMae: errTrend / n, bandScale: Math.max(1, k80 / 1.28) };
}

const timingOf = (model) => ({
  ...Object.fromEntries(GROUPS.map((g) => [g, { peakMin: model.kinds[g].peakMin, durationMin: model.kinds[g].durationMin }])),
  absorbMin: model.carbs.absorbMin,
});

/**
 * The estimate line from the latest reading: { from, points: [{ t, mg, lo, hi }] } every
 * `stepMin` for `horizonMin`, with an 80% band. Doses and meals still working are included,
 * and so is what the recent trend says beyond them, fading over about 20 minutes.
 */
export function forecast(points, events, pid, model, { latest = null, horizonMin = 60, stepMin = 5, hourOf = localHour, health = [], inputs = null } = {}) {
  if (!model?.w || !model.keys) return null;
  const last = latest || [...points].sort((a, b) => b.t - a.t)[0];
  if (!last) return null;
  const t0 = last.t;
  const inp = narrow(inputs || inputsFrom(events, pid, health), t0 - 36 * 3600e3, t0 + horizonMin * MIN + 1);
  const keys = model.keys;
  const timing = timingOf(model);
  const widen = model.check?.bandScale || 1;
  const observed = trendSlope(points, last);
  const explained = dot(featuresFor(inp, t0 - 15 * MIN, t0, timing, hourOf, keys), model.w) / 15;
  const extra = Math.max(-3, Math.min(3, observed - explained));
  const tau = 20;
  const out = [];
  for (let m = stepMin; m <= horizonMin; m += stepMin) {
    const x = featuresFor(inp, t0, t0 + m * MIN, timing, hourOf, keys);
    const change = dot(x, model.w) + extra * tau * (1 - Math.exp(-m / tau));
    const paramVar = dot(x, model.cov.map((row) => dot(row, x)));
    const sd = widen * Math.sqrt(Math.max(0, paramVar) + model.sigma * model.sigma * (m / STEP));
    const mg = Math.max(40, Math.min(400, last.mg + change));
    out.push({ t: t0 + m * MIN, mg, sd, lo: Math.max(40, mg - 1.28 * sd), hi: Math.min(400, mg + 1.28 * sd) });
  }
  return { from: t0, points: out };
}

/**
 * Whether the line is worth showing: checked on held-out days with only what was known at the
 * time, clearly better (5%) than both plain guesses, and learned within the last day.
 */
export function trustworthy(model, now = Date.now()) {
  const c = model?.check;
  return Boolean(c && c.n >= 12 && c.mae <= Math.min(c.flatMae, c.trendMae) * 0.95 && model.fittedAt && now - model.fittedAt < 24 * 3600e3);
}

/** How far ahead the line may be drawn: the horizon it was checked at. */
export const trustedHorizon = (model) => model?.check?.horizonMin || 60;

/**
 * What one dose does by the learned numbers: total mg/dL with an 80% range, when it is
 * strongest, when it is done, and how much is still to come at `now`.
 */
export function doseEffect(dose, model, now = Date.now()) {
  const units = Number(dose.amount ?? dose.units);
  const parts = groupsFor(dose.kind).filter(([g]) => model?.kinds?.[g]);
  if (!parts.length || !(units > 0)) return null;
  let total = 0, variance = 0, toCome = 0, peakMin = 0, durationMin = 0;
  for (const [g, frac] of parts) {
    const k = model.kinds[g];
    total += k.isf * units * frac;
    variance += (k.isfSd * units * frac) ** 2;
    toCome += k.isf * units * frac * remaining((now - dose.t) / MIN, k);
    if (frac >= 0.5 || !peakMin) peakMin = k.peakMin;
    durationMin = Math.max(durationMin, k.durationMin);
  }
  const sd = Math.sqrt(variance);
  return {
    total, low: Math.max(0, total - 1.28 * sd), high: total + 1.28 * sd,
    peakAt: dose.t + peakMin * MIN, endAt: dose.t + durationMin * MIN,
    toCome, learned: parts.every(([g]) => model.kinds[g].learned),
  };
}

/** Plain-language lines about what was learned (mg/dL; the caller converts units). */
export function findings(model, fmtMg = (v) => `${Math.round(v)} mg/dL`) {
  if (!model) return [];
  const out = [];
  const range = (size, sd) => `${fmtMg(Math.max(0, size - 1.28 * sd))}–${fmtMg(size + 1.28 * sd)}`;
  const hours = (m) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
  for (const g of GROUPS) {
    const k = model.kinds[g];
    if (!k.learned) continue;
    out.push({ key: g, text: `1 unit of ${FACTORS[g].label} lowers you about ${fmtMg(k.isf)} (likely ${range(k.isf, k.isfSd)}), strongest after ${hours(k.peakMin)}, done by about ${hours(Math.round(k.durationMin))}. From ${k.doses} doses.` });
  }
  const e = model.effects || {};
  if (e.carbs?.learned) out.push({ key: 'carbs', text: `10 g of carbs raise you about ${fmtMg(10 * e.carbs.size)}, mostly over ${hours(model.carbs.absorbMin)}. From ${e.carbs.count} meals.` });
  if (e.exercise?.learned) out.push({ key: 'exercise', text: `30 minutes of exercise lower you about ${fmtMg(30 * e.exercise.size)} while you do it. From ${e.exercise.count} sessions.` });
  if (e.steps?.learned && Math.abs(e.steps.size) > e.steps.sd) out.push({ key: 'steps', text: `Every 1,000 steps ${e.steps.size > 0 ? 'lower' : 'raise'} you about ${fmtMg(Math.abs(e.steps.size))}.` });
  if (e.heartUp?.learned && Math.abs(e.heartUp.size) > e.heartUp.sd) out.push({ key: 'heartUp', text: `10 minutes of raised heart rate ${e.heartUp.size > 0 ? 'lower' : 'raise'} you about ${fmtMg(Math.abs(10 * e.heartUp.size))}.` });
  if (e.shortSleep?.learned && Math.abs(e.shortSleep.size) > e.shortSleep.sd) out.push({ key: 'shortSleep', text: `After a short night, each hour of sleep lost moves you ${e.shortSleep.size > 0 ? 'up' : 'down'} about ${fmtMg(Math.abs(4 * e.shortSleep.size))} per hour the next day.` });
  if (e.heat?.learned && Math.abs(e.heat.size) > e.heat.sd) out.push({ key: 'heat', text: `On hot days, when it is 5 °C (9 °F) above 82 °F outside, you drift ${e.heat.size > 0 ? 'up' : 'down'} about ${fmtMg(Math.abs(20 * e.heat.size))} an hour.` });
  const drift = DRIFT.map((k) => ({ k, v: (e[k]?.size || 0) * 4 })).filter((d) => Math.abs(d.v) >= 5);
  for (const d of drift) out.push({ key: d.k, text: `From ${FACTORS[d.k].label}, with nothing else going on, you drift ${d.v > 0 ? 'up' : 'down'} about ${fmtMg(Math.abs(d.v))} an hour.` });
  return out;
}
