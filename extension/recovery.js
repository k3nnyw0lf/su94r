// What past lows teach: how long each low lasted, what was eaten for it, how long it took to
// get back above the low line, and whether it bounced high afterwards. Also spots likely
// "compression lows": a sudden overnight dip that springs back on its own, which usually means
// pressure on the sensor (lying on it), not a real low. Pure functions.
//
// It reports your own history. It never says how much to eat or dose; alarms always fire on
// every low, compression or not.

const MIN = 60e3;

/** Low episodes: below `low` for at least 10 minutes. */
export function lowEpisodes(points, { low = 70, minMinutes = 10 } = {}) {
  const pts = [...points].filter((p) => Number.isFinite(p.mg)).sort((a, b) => a.t - b.t);
  const out = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const gap = i && p.t - pts[i - 1].t > 30 * MIN;
    // A gap in the readings ends the episode where the readings stopped (kept, marked open).
    if (cur && gap) { close(cur, pts[i - 1]); if (cur.end - cur.start >= minMinutes * MIN) out.push(cur); cur = null; }
    if (p.mg < low) {
      if (!cur) cur = { start: p.t, nadir: p.mg, nadirAt: p.t, points: [] };
      cur.points.push(p);
      if (p.mg < cur.nadir) { cur.nadir = p.mg; cur.nadirAt = p.t; }
    } else if (cur) {
      cur.end = p.t;
      if (cur.end - cur.start >= minMinutes * MIN || cur.nadir < 54) out.push(cur);
      cur = null;
    }
  }
  if (cur) { close(cur, pts[pts.length - 1]); if (cur.end - cur.start >= minMinutes * MIN) out.push(cur); }
  return out.map(({ points: _p, ...e }) => ({ ...e, minutes: Math.round((e.end - e.start) / MIN) }));
  function close(c, last) { c.end = last.t; c.open = true; }
}

const hourOf = (t) => new Date(t).getHours();

/**
 * Likely compression lows: overnight (midnight–7 AM), a drop of 35+ mg/dL within 20 minutes
 * into a low, back up 30+ within 40 minutes, with nothing eaten. Returns [{ start, end, nadir }].
 */
export function compressionLows(points, events = [], pid = null, { low = 70, night = (t) => hourOf(t) < 7 } = {}) {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const eats = (events || []).filter((e) => e.type === 'meal' && (!pid || e.p === pid));
  const out = [];
  for (const ep of lowEpisodes(pts, { low, minMinutes: 0 })) {
    if (!night(ep.start) || ep.open) continue;
    const before = pts.filter((p) => p.t >= ep.start - 20 * MIN && p.t < ep.start);
    const after = pts.filter((p) => p.t > ep.nadirAt && p.t <= ep.nadirAt + 40 * MIN);
    if (!before.length || !after.length) continue;
    const drop = Math.max(...before.map((p) => p.mg)) - ep.nadir;
    const rise = Math.max(...after.map((p) => p.mg)) - ep.nadir;
    const ate = eats.some((e) => e.t >= ep.start - 15 * MIN && e.t <= ep.end);
    if (drop >= 35 && rise >= 30 && !ate && ep.minutes <= 60) out.push({ start: ep.start, end: ep.end, nadir: ep.nadir });
  }
  return out;
}

/**
 * Each real low with what was eaten for it (meal markers from 10 minutes before to 30 after it
 * started), minutes from eating to back above the line, and whether it went over `high`
 * within 2 hours after.
 */
export function lowRecoveries(points, events, pid, { low = 70, high = 180 } = {}) {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const compress = compressionLows(pts, events, pid, { low });
  const meals = (events || []).filter((e) => e.type === 'meal' && e.p === pid);
  return lowEpisodes(pts, { low })
    .filter((ep) => !ep.open && !compress.some((c) => c.start === ep.start))
    .map((ep) => {
      const ate = meals.filter((m) => m.t >= ep.start - 10 * MIN && m.t <= ep.start + 30 * MIN);
      const grams = ate.reduce((a, m) => a + (Number(m.amount) || 0), 0);
      const from = ate.length ? Math.min(...ate.map((m) => m.t)) : ep.start;
      const peakAfter = Math.max(0, ...pts.filter((p) => p.t > ep.end && p.t <= ep.end + 2 * 3600e3).map((p) => p.mg));
      return { ...ep, grams: ate.length ? grams : null, toRecover: Math.max(0, Math.round((ep.end - from) / MIN)), overshoot: peakAfter > high, peakAfter };
    });
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/** Plain-language lines from the last `n` lows. */
export function recoveryFindings(recs, fmt = (v) => `${Math.round(v)} mg/dL`, { n = 12 } = {}) {
  const last = recs.slice(-n);
  if (last.length < 2) return [];
  const out = [`Your last ${last.length} lows lasted about ${median(last.map((r) => r.minutes))} minutes (middle value); the lowest went to ${fmt(Math.min(...last.map((r) => r.nadir)))}.`];
  const treated = last.filter((r) => r.grams);
  const byGrams = new Map();
  for (const r of treated) {
    const g = r.grams <= 10 ? '10 g or less' : r.grams <= 20 ? 'about 15 g' : r.grams <= 35 ? 'about 30 g' : 'more than 35 g';
    byGrams.set(g, [...(byGrams.get(g) || []), r]);
  }
  for (const [g, rs] of byGrams) {
    if (rs.length < 2) continue;
    const over = rs.filter((r) => r.overshoot).length;
    out.push(`When you logged ${g}: back above the line in about ${median(rs.map((r) => r.toRecover))} minutes (${rs.length} times)${over ? `; ${over} of them went over the high line within 2 hours` : ''}.`);
  }
  const untreated = last.length - treated.length;
  if (untreated) out.push(`${untreated} of these lows have no food logged with them. Logging what you eat for a low lets su94r tell you what works for you.`);
  return out;
}
