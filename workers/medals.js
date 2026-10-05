// Medals: small celebrations of habits, worked out from what su94r already keeps: the daily
// summaries (daily.js), logged exercise, weight and meter checks (checks.js), logged carbs
// (doses.js) and sensor starts (night.js state). Once earned a medal is kept
// (su94r_night.medals, migration 20261005b), so data ageing out of a query never takes one back.
// They celebrate; they never judge a number or advise anything.
//
// The app names them (workers/app/client.js MEDAL_INFO), in English or Spanish. A shared picture
// carries only the medal's name, never a reading, a percentage or a weight.
//
//   range3/7/14/30   days in a row at the time-in-range goal (days with 8+ hours of readings;
//                    a shorter day neither counts nor breaks the run, as in daily.js streaks)
//   nolow7/30        days in a row with no low (same days)
//   week150          150 logged active minutes in one week, Monday to Sunday (counted each time)
//   active3/7/30     calendar days in a row with 10+ logged active minutes
//   down1/2/5/10     at or below 1%, 2.5%, 5%, 10% under the first logged weight
//   held             still 2.5%+ down at a weigh-in 4 weeks after first reaching it
//   meals7           calendar days in a row with 2+ meals (carbs) logged
//   sensorcheck      a meter check in a sensor's first 24 hours (counted each time)
//   days30           30 days with readings

import { FULL_DAY_READINGS, dayIn } from './daily.js';

const DAY = 864e5;

export const MEDALS = [
  { id: 'range3', family: 'range', need: 3 }, { id: 'range7', family: 'range', need: 7 },
  { id: 'range14', family: 'range', need: 14 }, { id: 'range30', family: 'range', need: 30 },
  { id: 'nolow7', family: 'nolow', need: 7 }, { id: 'nolow30', family: 'nolow', need: 30 },
  { id: 'week150', family: 'exercise', need: 150, repeat: true },
  { id: 'active3', family: 'exercise', need: 3 }, { id: 'active7', family: 'exercise', need: 7 }, { id: 'active30', family: 'exercise', need: 30 },
  { id: 'down1', family: 'weight', need: 1 }, { id: 'down2', family: 'weight', need: 2.5 },
  { id: 'down5', family: 'weight', need: 5 }, { id: 'down10', family: 'weight', need: 10 },
  { id: 'held', family: 'weight', need: 28 },
  { id: 'meals7', family: 'logging', need: 7 }, { id: 'sensorcheck', family: 'logging', need: 1, repeat: true },
  { id: 'days30', family: 'logging', need: 30 },
];
const BY_ID = Object.fromEntries(MEDALS.map((m) => [m.id, m]));

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mondayOf = (day) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

/** Runs over saved days (oldest first, 8+ hours of readings): the day each length was first reached, and the run now. */
function fullDayRun(full, ok, needs) {
  const at = {};
  let cur = 0;
  for (const d of full) {
    cur = ok(d) ? cur + 1 : 0;
    for (const n of needs) if (cur >= n && !at[n]) at[n] = d.day;
  }
  return { at, current: cur };
}

/** Runs over calendar days ('YYYY-MM-DD'): the day each length was first reached, and the run still going (last day today or yesterday). */
function calendarRun(daySet, needs, today) {
  const at = {};
  let cur = 0, prev = null;
  for (const d of [...daySet].sort()) {
    cur = prev && addDays(prev, 1) === d ? cur + 1 : 1;
    prev = d;
    for (const n of needs) if (cur >= n && !at[n]) at[n] = d;
  }
  return { at, current: prev && (prev === today || addDays(prev, 1) === today) ? cur : 0 };
}

/**
 * The medals earned (kept ones merged in) and the next one of each family with how far it is.
 * Returns { earned: [{ id, family, on, count? }], next: [{ id, family, have, need }], kept, changed }.
 */
export function medalsFor({ days = [], checks = [], carbs = [], sensorStarts = [], goal = 70, tz = 'America/New_York', now = Date.now(), kept = {} } = {}) {
  const today = dayIn(now, tz);
  const found = {};
  const next = [];
  const earn = (id, on, count) => { found[id] = count ? { on, count } : { on }; };
  const nextOf = (ids, have) => { const m = ids.map((id) => BY_ID[id]).find((x) => !found[x.id] && !kept[x.id]); if (m) next.push({ id: m.id, family: m.family, have, need: m.need }); };

  // Time in range and no lows: the saved days.
  const full = days.filter((d) => d.readings >= FULL_DAY_READINGS);
  const range = fullDayRun(full, (d) => d.inRange * 100 >= goal, [3, 7, 14, 30]);
  for (const n of [3, 7, 14, 30]) if (range.at[n]) earn(`range${n}`, range.at[n]);
  nextOf(['range3', 'range7', 'range14', 'range30'], range.current);
  const nolow = fullDayRun(full, (d) => d.lows === 0, [7, 30]);
  for (const n of [7, 30]) if (nolow.at[n]) earn(`nolow${n}`, nolow.at[n]);
  nextOf(['nolow7', 'nolow30'], nolow.current);

  // Exercise: minutes by day and by week.
  const exercise = checks.filter((c) => c.kind === 'exercise' && Number(c.value) > 0).sort((a, b) => a.t - b.t);
  const perDay = new Map();
  for (const c of exercise) { const d = dayIn(c.t, tz); perDay.set(d, (perDay.get(d) || 0) + Number(c.value)); }
  const weeks = new Map();
  let weeksMet = 0, firstWeek = null;
  for (const c of exercise) {
    const d = dayIn(c.t, tz), w = mondayOf(d);
    const before = weeks.get(w) || 0, after = before + Number(c.value);
    weeks.set(w, after);
    if (before < 150 && after >= 150) { weeksMet += 1; if (!firstWeek) firstWeek = d; }
  }
  if (weeksMet) earn('week150', firstWeek, weeksMet);
  const active = calendarRun(new Set([...perDay].filter(([, m]) => m >= 10).map(([d]) => d)), [3, 7, 30], today);
  for (const n of [3, 7, 30]) if (active.at[n]) earn(`active${n}`, active.at[n]);
  nextOf(['active3', 'active7', 'active30'], active.current);
  next.push({ id: 'week150', family: 'exercise', have: Math.round(weeks.get(mondayOf(today)) || 0), need: 150 });

  // Weight: against the first weigh-in.
  const weighed = checks.filter((c) => c.kind === 'weight' && Number(c.value) > 0).sort((a, b) => a.t - b.t);
  if (weighed.length) {
    const start = Number(weighed[0].value);
    const down = (c) => ((start - Number(c.value)) / start) * 100;
    const reached = {};
    for (const c of weighed.slice(1)) for (const [id, p] of [['down1', 1], ['down2', 2.5], ['down5', 5], ['down10', 10]]) if (!reached[id] && down(c) >= p) reached[id] = c.t;
    for (const id of Object.keys(reached)) earn(id, dayIn(reached[id], tz));
    const t2 = reached.down2 ?? (kept.down2 ? Date.parse(`${kept.down2.on}T12:00:00Z`) : null);
    if (t2 != null) {
      const held = weighed.find((c) => c.t >= t2 + 28 * DAY && down(c) >= 2.5);
      if (held) earn('held', dayIn(held.t, tz));
    }
    const latest = weighed[weighed.length - 1];
    nextOf(['down1', 'down2', 'down5', 'down10'], Math.max(0, Math.round(down(latest) * 10) / 10));
    if (t2 != null && !found.held && !kept.held) next.push({ id: 'held', family: 'weight', have: Math.min(28, Math.max(0, Math.floor((now - t2) / DAY))), need: 28 });
  }

  // Logging habits.
  const mealsByDay = new Map();
  for (const c of carbs) { const d = dayIn(c.t, tz); mealsByDay.set(d, (mealsByDay.get(d) || 0) + 1); }
  const meals = calendarRun(new Set([...mealsByDay].filter(([, n]) => n >= 2).map(([d]) => d)), [7], today);
  if (meals.at[7]) earn('meals7', meals.at[7]);
  nextOf(['meals7'], meals.current);
  const meters = checks.filter((c) => c.kind === 'meter');
  const checked = [...new Set(sensorStarts)].filter(Number.isFinite).sort((a, b) => a - b)
    .map((s) => meters.find((c) => c.t >= s && c.t <= s + DAY)).filter(Boolean);
  if (checked.length) earn('sensorcheck', dayIn(checked[0].t, tz), checked.length);
  const withReadings = days.filter((d) => d.readings > 0);
  if (withReadings.length >= 30) earn('days30', withReadings[29].day);
  nextOf(['days30'], withReadings.length);

  // Merge with the kept ones: the earliest day, the highest count.
  const merged = { ...kept };
  let changed = false;
  for (const [id, f] of Object.entries(found)) {
    const k = merged[id];
    const m = { on: k && k.on < f.on ? k.on : f.on, ...(f.count || k?.count ? { count: Math.max(f.count || 0, k?.count || 0) } : {}) };
    if (!k || k.on !== m.on || (k.count || 0) !== (m.count || 0)) changed = true;
    merged[id] = m;
  }
  const earned = MEDALS.filter((m) => merged[m.id]).map((m) => ({ id: m.id, family: m.family, ...merged[m.id] }));
  return { earned, next, kept: merged, changed };
}
