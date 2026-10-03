// Missed-dose reminders: when a usual dose has not been logged. The night check (night.js, every
// 5 minutes) learns each person's usual times from the doses on the server (the last 14 days)
// and says what is missing. It never says what or how much to take.
//
//   Long-acting (basal or NPH) logged on at least 4 of the last 14 days around the same time:
//   90 minutes after that time with none logged (none in 18 hours for a once-a-day dose), a
//   reminder "not logged yet".
//   Mealtime (rapid, regular or pre-mixed insulin, or carbs) on at least 5 of the last 14 days:
//   75 minutes after that time with nothing logged, and only when the glucose shows it (above the
//   high line, or up 40 mg/dL in the last hour or so). Not at night.
//   Each reminder at most once a day.

const MIN = 60e3, DAY = 864e5;
const BASAL = new Set(['basal', 'intermediate']);
const MEAL = new Set(['rapid', 'short', 'mix', 'carbs']);

/** Local date (YYYY-MM-DD) and minute of the day in a time zone. */
export function localParts(t, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  } catch { parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)); }
  const g = (k) => parts.find((x) => x.type === k).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minute: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

/** Groups times of day that sit within `gap` minutes of each other: [{ center, days }]. */
export function clusters(items, gap = 120) {
  const sorted = items.slice().sort((a, b) => a.minute - b.minute);
  const out = [];
  let cur = [];
  for (const it of sorted) {
    if (cur.length && it.minute - cur[cur.length - 1].minute > gap) { out.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out.map((c) => {
    const mins = c.map((x) => x.minute).sort((a, b) => a - b);
    return { center: mins[Math.floor(mins.length / 2)], days: new Set(c.map((x) => x.date)).size };
  });
}

const clock = (minute) => {
  const h = Math.floor(minute / 60) % 24, m = minute % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const slotEs = (minute) => (minute >= 300 && minute < 630 ? 'el desayuno' : minute >= 660 && minute < 900 ? 'el almuerzo' : minute >= 1020 && minute < 1290 ? 'la cena' : `alrededor de las ${clock(minute)}`);
const slotName = (minute) => (minute >= 300 && minute < 630 ? 'breakfast time' : minute >= 660 && minute < 900 ? 'lunch time' : minute >= 1020 && minute < 1290 ? 'dinner time' : `about ${clock(minute)}`);

/**
 * The reminders due now for one person. doses: [{ t, kind }] of the last 14 days (deleted left
 * out); person: snapshot person (latest, history [{ t, mg }], low, high); nudged: { key: date }
 * of reminders already given. Returns [{ key, title, message }] and the date to remember them by.
 */
export function missedDoseNudges({ person, doses, now = Date.now(), tz = 'America/New_York', nudged = {}, nightStart = 22, nightEnd = 7, fmt = (mg) => `${Math.round(mg)}` }) {
  const today = localParts(now, tz);
  const recent = doses.filter((d) => d.t > now - 14 * DAY && d.t <= now);
  const out = [];
  // Long-acting.
  const basal = recent.filter((d) => BASAL.has(d.kind));
  const bClusters = clusters(basal.map((d) => ({ ...localParts(d.t, tz) }))).filter((c) => c.days >= 4);
  for (const c of bClusters) {
    const key = `basal-${c.center}`;
    if (nudged[key] === today.date) continue;
    const late = today.minute - c.center;
    if (late < 90 || late > 360) continue;
    // Once a day: none in the last 18 hours. Twice a day or more: none since 4 hours before this one.
    const since = bClusters.length === 1 ? now - 18 * 60 * MIN : now - (late + 240) * MIN;
    if (basal.some((d) => d.t >= since)) continue;
    out.push({ key, title: 'Long-acting not logged yet', message: `You usually log it around ${clock(c.center)}. If you have taken it, log it so su94r, Alexa and the double-dose check know.`,
      es: { title: 'Insulina de acción prolongada sin registrar todavía', message: `Normalmente la registras alrededor de las ${clock(c.center)}. Si ya te la pusiste, regístrala para que su94r, Alexa y la revisión de doble dosis lo sepan.` } });
  }
  // Mealtimes: only when the glucose shows something was missed.
  const hour = Math.floor(today.minute / 60);
  const night = nightStart > nightEnd ? hour >= nightStart || hour < nightEnd : hour >= nightStart && hour < nightEnd;
  const l = person?.latest;
  if (!night && l && now - l.t <= 20 * MIN) {
    const past = (person.history || []).filter((q) => q.t >= l.t - 100 * MIN && q.t <= l.t - 50 * MIN);
    const rise = past.length ? l.mg - Math.min(...past.map((q) => q.mg)) : 0;
    const showing = l.mg > (person.high ?? 180) || rise >= 40;
    const meals = recent.filter((d) => MEAL.has(d.kind));
    for (const c of clusters(meals.map((d) => ({ ...localParts(d.t, tz) }))).filter((x) => x.days >= 5)) {
      const key = `meal-${c.center}`;
      if (nudged[key] === today.date || !showing) continue;
      const late = today.minute - c.center;
      if (late < 75 || late > 240) continue;
      if (meals.some((d) => d.t >= now - (late + 120) * MIN)) continue;
      const arrow = ['', '↓', '↘', '→', '↗', '↑'][l.trend] || '';
      out.push({ key, title: `Nothing logged since ${slotName(c.center)}`, message: `You usually log around ${clock(c.center)}, and glucose is ${fmt(l.mg)} ${arrow} now. If you ate or took insulin, log it.`.replace(/ {2,}/g, ' '),
        es: { title: `Nada registrado desde ${slotEs(c.center)}`, message: `Normalmente registras alrededor de las ${clock(c.center)} y la glucosa está en ${fmt(l.mg)} ${arrow}. Si comiste o te pusiste insulina, regístralo.`.replace(/ {2,}/g, ' ') } });
    }
  }
  return { nudges: out, date: today.date };
}
