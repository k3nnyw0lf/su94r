// Daily summaries, kept for years: the readings themselves are kept 90 days (history.js), so one
// small row per person and local day (readings, average, time in ranges, lows) carries the long
// view: GMI by month next to lab A1c results, and goals and streaks.
//
// The night check (night.js tick) writes yesterday's row once a day, and on its first run every
// day the 90-day history still has.
//
// Table public.su94r_daily (migration 20261003d_su94r_insights.sql), service role only.

const MIN = 60e3, DAY = 864e5;
export const FULL_DAY_READINGS = 96;          // a day counts toward goals with 8+ hours of 5-minute readings

export function dailyStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_daily`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Daily summaries are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Daily store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    save: (rows) => (rows.length ? call('?on_conflict=pid,day', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) }) : Promise.resolve()),
    /** One person's days from a date (YYYY-MM-DD), oldest first. */
    async since(pid, day) {
      const rows = await call(`?select=day,readings,mean,in_range,below,above,lows&pid=eq.${q(pid)}&day=gte.${q(day)}&order=day.asc&limit=1000`);
      return rows.map((r) => ({ day: r.day, readings: r.readings, mean: Number(r.mean), inRange: Number(r.in_range), below: Number(r.below), above: Number(r.above), lows: r.lows }));
    },
    async last(pid) { return (await call(`?select=day&pid=eq.${q(pid)}&order=day.desc&limit=1`))[0]?.day || null; },
  };
}

/** 'YYYY-MM-DD' of a time in a time zone. */
export function dayIn(t, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t); } catch { return new Date(t).toISOString().slice(0, 10); }
}

/** One day's readings as its summary row (null with no readings). */
export function summarize(pid, day, pts, low = 70, high = 180) {
  if (!pts.length) return null;
  const n = pts.length;
  let lows = 0, inLow = false;
  for (const p of pts) { if (p.mg < low && !inLow) { lows += 1; inLow = true; } else if (p.mg >= low) inLow = false; }
  const share = (f) => Math.round((pts.filter(f).length / n) * 1000) / 1000;
  return {
    pid, day, readings: n, mean: Math.round((pts.reduce((s, p) => s + p.mg, 0) / n) * 10) / 10,
    in_range: share((p) => p.mg >= low && p.mg <= high), below: share((p) => p.mg < low), above: share((p) => p.mg > high), lows,
  };
}

/**
 * Writes the days that are over and not saved yet (at most the 90 days history keeps), for each
 * person. Returns how many rows were written.
 */
export async function updateDaily({ daily, history, people, tz = 'America/New_York', now = Date.now() }) {
  if (!daily?.ready || !history?.ready) return 0;
  const today = dayIn(now, tz);
  let written = 0;
  for (const p of people) {
    const last = await daily.last(p.pid);
    const from = last ? Date.parse(`${last}T00:00:00Z`) + DAY - 14 * 3600e3 : now - 90 * DAY;
    if (last && last >= dayIn(now - DAY, tz)) continue;                    // yesterday is saved
    const pts = await history.range(p.pid, Math.max(from, now - 90 * DAY), now);
    const byDay = new Map();
    for (const x of pts) { const d = dayIn(x.t, tz); if (d < today && (!last || d > last)) (byDay.get(d) || byDay.set(d, []).get(d)).push(x); }
    const rows = [...byDay].map(([d, l]) => summarize(p.pid, d, l, p.low ?? 70, p.high ?? 180)).filter(Boolean);
    await daily.save(rows);
    written += rows.length;
  }
  return written;
}

const gmiOf = (mean) => Math.round((3.31 + 0.02392 * mean) * 10) / 10;

/** Days grouped by month: [{ month: 'YYYY-MM', days, gmi, inRange }] (days with 8+ hours of readings). */
export function months(days) {
  const by = new Map();
  for (const d of days) {
    if (d.readings < FULL_DAY_READINGS) continue;
    const m = d.day.slice(0, 7);
    const a = by.get(m) || { month: m, days: 0, n: 0, sum: 0, inr: 0 };
    a.days += 1; a.n += d.readings; a.sum += d.mean * d.readings; a.inr += d.inRange * d.readings;
    by.set(m, a);
  }
  return [...by.values()].map((a) => ({ month: a.month, days: a.days, gmi: gmiOf(a.sum / a.n), inRange: Math.round((a.inr / a.n) * 1000) / 1000 }));
}

/**
 * Goals and streaks from the saved days (newest last) and today so far: days in a row at or above
 * the time-in-range goal, days in a row with no lows, and the last 7 days. A day with too few
 * readings neither counts nor breaks a streak.
 */
export function streaks(days, goal = 70, today = null) {
  const full = days.filter((d) => d.readings >= FULL_DAY_READINGS);
  const run = (ok) => { let k = 0; for (let i = full.length - 1; i >= 0 && ok(full[i]); i--) k += 1; return k; };
  const met = (d) => d.inRange * 100 >= goal;
  let best = 0, cur = 0;
  for (const d of full) { cur = met(d) ? cur + 1 : 0; best = Math.max(best, cur); }
  const week = full.slice(-7);
  return {
    goal, streak: run(met), best, noLowStreak: run((d) => d.lows === 0),
    week: { met: week.filter(met).length, of: week.length },
    today: today && today.readings >= 12 ? { inRange: today.in_range, onTrack: today.in_range * 100 >= goal, lows: today.lows } : null,
  };
}
