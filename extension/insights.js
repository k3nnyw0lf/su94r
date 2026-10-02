// What a person's own history shows about insulin timing.
//
// Observations, not advice: for each logged rapid dose with clean data around
// it, when glucose started falling, when it fell fastest and when it levelled
// off. It reports minutes, never units — how much to take is for the person and
// their care team (see insulin.js for why there is no dose calculator).
//
// A dose is "clean" when no other insulin was taken from 2 h before to 5 h
// after, the CGM has no gap longer than 20 min over that window, and (for the
// timing of insulin itself) no food was logged from 1 h before to 5 h after.
// Doses with food at the same time are summarised separately: how long after
// the dose glucose peaked and came back down. Exercise speeds insulin up and a
// day of sitting slows it down, so doses with exercise logged nearby are
// reported apart from the rest when there are enough of both.

const MIN = 60e3;
// How long after a dose the analysis looks, and so how long it must be free of other
// insulin, food and data gaps.
const LOOK_MS = 5 * 3600e3;
const MIN_DOSES = 3;

function bucket5(points) {
  const out = [];
  let cur = null;
  for (const p of points) {
    const k = Math.floor(p.t / (5 * MIN));
    if (!cur || cur.k !== k) {
      cur = { k, t: k * 5 * MIN + 2.5 * MIN, sum: p.mg, n: 1 };
      out.push(cur);
    } else {
      cur.sum += p.mg;
      cur.n++;
    }
  }
  return out.map((c) => ({ t: c.t, mg: c.sum / c.n }));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const within = (list, from, to) => list.some((e) => e.t >= from && e.t <= to);

function windowOk(series, start, end) {
  if (!series.length || series[0].t > start + 10 * MIN || series[series.length - 1].t < end - 10 * MIN) return false;
  for (let i = 1; i < series.length; i++) if (series[i].t - series[i - 1].t > 20 * MIN) return false;
  return true;
}

// Centered moving average over five 5-minute points (25 minutes) to calm sensor noise.
function smooth(series, k = 2) {
  return series.map((p, i) => {
    const w = series.slice(Math.max(0, i - k), i + k + 1);
    return { t: p.t, mg: w.reduce((sum, q) => sum + q.mg, 0) / w.length };
  });
}

// Slope in mg/dL per minute over 20 minutes, at each point.
function rates(series) {
  return series.map((p, i) => {
    const a = series[Math.max(0, i - 2)];
    const b = series[Math.min(series.length - 1, i + 2)];
    return { t: p.t, mg: p.mg, rate: b.t === a.t ? 0 : (b.mg - a.mg) / ((b.t - a.t) / MIN) };
  });
}

// Timing from the shape of the fall: starts = 10 % of the total drop reached,
// hardest = steepest fall, mostly done = 90 % of the drop reached. Fractions of
// the drop are far steadier on real CGM data than slope thresholds.
function correctionTiming(series, d) {
  const s = smooth(series);
  const start = s.find((p) => p.t >= d.t - 10 * MIN);
  const after = s.filter((p) => p.t >= d.t && p.t <= d.t + LOOK_MS);
  if (!start || after.length < 12) return null;
  const nadir = after.reduce((x, y) => (y.mg < x.mg ? y : x));
  const drop = start.mg - nadir.mg;
  if (drop < 20) return null;   // too small a fall to time reliably
  const reach = (frac) => after.find((p) => start.mg - p.mg >= frac * drop);
  const onset = reach(0.1);
  const end = reach(0.9);
  const r = rates(after).filter((p) => p.t >= onset.t && p.t <= end.t);
  const peak = r.length ? r.reduce((x, y) => (y.rate < x.rate ? y : x)) : onset;
  return { onset: (onset.t - d.t) / MIN, peak: (peak.t - d.t) / MIN, end: (end.t - d.t) / MIN };
}

function mealTiming(series, d) {
  const win = series.filter((p) => p.t >= d.t - 10 * MIN && p.t <= d.t + LOOK_MS);
  const start = win.find((p) => p.t >= d.t - 10 * MIN);
  const early = win.filter((p) => p.t <= d.t + 3 * 3600e3);
  if (!start || !early.length) return null;
  const top = early.reduce((a, b) => (b.mg > a.mg ? b : a));
  if (top.mg - start.mg < 15) return { peakAfter: null, backAfter: null };
  const back = win.find((p) => p.t > top.t && p.mg <= start.mg + 20);
  return { peakAfter: (top.t - d.t) / MIN, backAfter: back ? (back.t - d.t) / MIN : null };
}

function summarise(list) {
  return {
    n: list.length,
    onset: median(list.map((x) => x.onset)),
    peak: median(list.map((x) => x.peak)),
    end: median(list.map((x) => x.end)),
  };
}

/**
 * @param {Array<{t:number, mg:number}>} points  glucose, sorted
 * @param {Array} events                          markers ({p, t, type, amount, kind})
 * @param {string} pid
 * @returns observations and counts of what was left out, so nothing is silently dropped
 */
export function insulinTiming(points, events, pid, { now = Date.now() } = {}) {
  const mine = (events || []).filter((e) => e.p === pid);
  // Every logged insulin counts as "other insulin nearby", with or without an amount;
  // only rapid doses with an amount are analysed themselves.
  const insulin = mine.filter((e) => e.type === 'insulin');
  const rapid = insulin.filter((e) => Number(e.amount) > 0 && (e.kind || 'rapid') === 'rapid').sort((a, b) => a.t - b.t);
  const meals = mine.filter((e) => e.type === 'meal');
  const exercise = mine.filter((e) => e.type === 'exercise');
  const series = bucket5(points);

  const skipped = { tooRecent: 0, stacked: 0, foodNearby: 0, gaps: 0, unclear: 0 };
  const corrections = [];
  const withMeals = [];

  for (const d of rapid) {
    if (now - d.t < LOOK_MS) { skipped.tooRecent++; continue; }
    if (insulin.some((o) => o !== d && o.t > d.t - 2 * 3600e3 && o.t < d.t + LOOK_MS)) { skipped.stacked++; continue; }
    const win = series.filter((p) => p.t >= d.t - 15 * MIN && p.t <= d.t + LOOK_MS);
    if (!windowOk(win, d.t, d.t + LOOK_MS)) { skipped.gaps++; continue; }
    const active = within(exercise, d.t - 2 * 3600e3, d.t + LOOK_MS);
    const mealNow = within(meals, d.t - 30 * MIN, d.t + 30 * MIN);
    if (mealNow) {
      if (within(meals.filter((m) => Math.abs(m.t - d.t) > 30 * MIN), d.t - 60 * MIN, d.t + LOOK_MS)) { skipped.foodNearby++; continue; }
      const m = mealTiming(win, d);
      if (m && m.peakAfter != null) withMeals.push({ ...m, active });
      else skipped.unclear++;
      continue;
    }
    if (within(meals, d.t - 60 * MIN, d.t + LOOK_MS)) { skipped.foodNearby++; continue; }
    const c = correctionTiming(win, d);
    if (c) corrections.push({ ...c, active, area: String(d.site || '').split('-')[0] || null });
    else skipped.unclear++;
  }

  // Absorption differs by area (belly is usually quickest), so compare areas with enough doses.
  const bySite = {};
  for (const area of new Set(corrections.map((c) => c.area).filter(Boolean))) {
    const list = corrections.filter((c) => c.area === area);
    if (list.length >= MIN_DOSES) bySite[area] = summarise(list);
  }
  const sitting = corrections.filter((c) => !c.active);
  const moving = corrections.filter((c) => c.active);
  return {
    enough: corrections.length >= MIN_DOSES,
    minDoses: MIN_DOSES,
    correction: summarise(corrections),
    split: sitting.length >= MIN_DOSES && moving.length >= MIN_DOSES
      ? { withExercise: summarise(moving), withoutExercise: summarise(sitting) }
      : null,
    bySite: Object.keys(bySite).length >= 2 ? bySite : null,
    meals: withMeals.length >= MIN_DOSES
      ? { n: withMeals.length, peakAfter: median(withMeals.map((m) => m.peakAfter)), backAfter: median(withMeals.map((m) => m.backAfter).filter((x) => x != null)) }
      : { n: withMeals.length },
    usable: corrections.length + withMeals.length,
    total: rapid.length,
    skipped,
  };
}
