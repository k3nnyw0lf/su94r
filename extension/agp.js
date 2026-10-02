// The numbers of the glucose report (AGP), shared by the report page and the Sunday summary.
// International consensus on time in range (Battelino et al., Diabetes Care 2019): time
// below/in/above range, GMI, CV, percentiles by time of day. Pure: no page, no storage.

const DAY = 864e5;

/** Pure: everything the report shows, from readings and markers. */
export function agp(points, events, { from, to, low = 70, high = 180 } = {}) {
  const pts = points.filter((p) => p.t >= from && p.t < to).sort((a, b) => a.t - b.t);
  const n = pts.length;
  const share = (f) => (n ? pts.filter(f).length / n : 0);
  const mean = n ? pts.reduce((s, p) => s + p.mg, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(pts.reduce((s, p) => s + (p.mg - mean) ** 2, 0) / (n - 1)) : null;
  // Expected readings: one per 5 minutes over the period (15-minute history counts as 3).
  let covered = 0;
  for (let i = 1; i < pts.length; i++) covered += Math.min(pts[i].t - pts[i - 1].t, 15 * 60e3);
  const days = Math.max(1, Math.round((to - from) / DAY));

  // Percentiles by 15-minute slot of the day, smoothed over the neighbouring slots.
  const slots = Array.from({ length: 96 }, () => []);
  for (const p of pts) {
    const d = new Date(p.t);
    slots[Math.floor((d.getHours() * 60 + d.getMinutes()) / 15)].push(p.mg);
  }
  const q = (arr, f) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const i = (s.length - 1) * f;
    return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
  };
  const profile = slots.map((_, i) => {
    const near = [-2, -1, 0, 1, 2].flatMap((k) => slots[(i + k + 96) % 96]);
    return near.length >= 5 ? { slot: i, p5: q(near, 0.05), p25: q(near, 0.25), p50: q(near, 0.5), p75: q(near, 0.75), p95: q(near, 0.95) } : null;
  });

  const mine = events.filter((e) => e.t >= from && e.t < to);
  const insulin = {};
  for (const e of mine.filter((x) => x.type === 'insulin')) {
    const k = e.kind || 'rapid';
    insulin[k] = insulin[k] || { doses: 0, units: 0, withAmount: 0 };
    insulin[k].doses++;
    if (Number(e.amount) > 0) { insulin[k].units += Number(e.amount); insulin[k].withAmount++; }
  }
  const meals = mine.filter((e) => e.type === 'meal');
  return {
    from, to, days, n,
    coverage: Math.min(1, covered / (to - from)),
    mean,
    gmi: mean != null ? 3.31 + 0.02392 * mean : null,
    cv: mean && sd ? (sd / mean) * 100 : null,
    veryLow: share((p) => p.mg < 54),
    low: share((p) => p.mg >= 54 && p.mg < low),
    inRange: share((p) => p.mg >= low && p.mg <= high),
    high: share((p) => p.mg > high && p.mg <= 250),
    veryHigh: share((p) => p.mg > 250),
    profile,
    insulin,
    meals: { count: meals.length, carbs: meals.reduce((s, m) => s + (Number(m.amount) || 0), 0) },
  };
}

/** Separate dips under `low` (a new one after 30 minutes back above), with the local hour each began. */
export function lowEpisodes(points, { from, to, low = 70, hourOf = (t) => new Date(t).getHours() } = {}) {
  const pts = points.filter((p) => p.t >= from && p.t < to).sort((a, b) => a.t - b.t);
  const out = [];
  let inLow = false, aboveSince = null;
  for (const p of pts) {
    if (p.mg < low) {
      if (!inLow && (aboveSince == null || p.t - aboveSince >= 30 * 60e3 || !out.length)) out.push({ t: p.t, hour: hourOf(p.t), nadir: p.mg });
      else if (out.length) out[out.length - 1].nadir = Math.min(out[out.length - 1].nadir, p.mg);
      inLow = true; aboveSince = null;
    } else {
      if (inLow) aboveSince = p.t;
      inLow = false;
    }
  }
  return out;
}

const PARTS = [[0, 6, 'at night (midnight–6 AM)'], [6, 12, 'in the morning'], [12, 18, 'in the afternoon'], [18, 24, 'in the evening']];

/** The Sunday summary in plain words: this week against the week before. Describes, never advises. */
export function weeklyText(cur, prev, { lows = [], fmt = (mg) => `${Math.round(mg)} mg/dL` } = {}) {
  if (!cur.n) return 'No glucose readings this week, so there is nothing to sum up.';
  const pct = (x) => `${Math.round(x * 100)}%`;
  const delta = (a, b) => { if (b == null) return ''; const d = Math.round((a - b) * 100); return d === 0 ? ' (same as last week)' : ` (${d > 0 ? 'up' : 'down'} ${Math.abs(d)} points from ${pct(b)})`; };
  const below = cur.veryLow + cur.low;
  // Compare only with a week that had enough sensor data to mean something.
  const lines = [`In range: ${pct(cur.inRange)}${delta(cur.inRange, prev?.n && prev.coverage >= 0.3 ? prev.inRange : null)}.`];
  if (lows.length) {
    const byPart = PARTS.map(([a, b, words]) => ({ words, n: lows.filter((l) => l.hour >= a && l.hour < b).length })).sort((x, y) => y.n - x.n)[0];
    lines.push(`Below range: ${pct(below)}, ${lows.length} low${lows.length === 1 ? '' : 's'}${byPart.n > 1 ? `, most ${byPart.words}` : ''}; the lowest was ${fmt(Math.min(...lows.map((l) => l.nadir)))}.`);
  } else lines.push(`Below range: ${pct(below)}, no lows.`);
  lines.push(`Above range: ${pct(cur.high + cur.veryHigh)}.`);
  if (cur.mean != null) lines.push(`Average ${fmt(cur.mean)}, GMI ${cur.gmi.toFixed(1)}%, variability ${cur.cv != null ? `${cur.cv.toFixed(0)}%` : '—'}${cur.cv != null ? (cur.cv <= 36 ? ' (steady)' : ' (above the 36% steadiness target)') : ''}.`);
  if (cur.coverage < 0.7) lines.push(`Sensor data covered ${pct(cur.coverage)} of the week, so these numbers are rough.`);
  lines.push('The full report: su94r Mini → Glucose report.');
  return lines.join('\n');
}
