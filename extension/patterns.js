// Pattern finder: plain sentences about what repeats in the last 14 days. Shared by the server
// (the report, the doctor's link, the phone app's History, Alexa's "patterns") and su94r Mini's
// Sunday summary. It describes what happened; it never advises.
//
// Needs at least 5 days with readings for at least 12 hours each. Looks for:
//   lows that recur in the same two hours of the day (on 3 or more days),
//   highs above 250 that recur in the same three hours (on 4 or more days),
//   a rise before waking (3 to 7 AM, median of 5 or more nights, 25 mg/dL or more),
//   how much glucose rises after each meal time (logged carbs or rapid insulin, 3 or more each),
//   weekdays against weekends (10 points of time in range apart),
//   the steadiest and the hardest part of the day (15 points apart),
//   what follows a note's tag (the phone app's notes): a low, or a high above 250, within 6 hours
//   of at least half of 3 or more notes with that tag.

const MIN = 60e3, DAY = 864e5;

/** The tags a note can have (workers/notes.js), and their words. */
export const NOTE_TAGS = ['exercise', 'stress', 'sick', 'alcohol', 'period', 'travel', 'eating-out'];
export const TAG_WORDS = {
  en: { exercise: 'exercise', stress: 'stress', sick: 'sick', alcohol: 'alcohol', period: 'period', travel: 'travel', 'eating-out': 'eating out' },
  es: { exercise: 'ejercicio', stress: 'estrés', sick: 'enfermedad', alcohol: 'alcohol', period: 'menstruación', travel: 'viaje', 'eating-out': 'comer fuera' },
};

function partsIn(tz) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let dtf;
  try { dtf = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }); } catch { dtf = new Intl.DateTimeFormat('en-US', opts); }
  return (t) => {
    const o = {};
    for (const p of dtf.formatToParts(new Date(t))) o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, minute: (Number(o.hour) % 24) * 60 + Number(o.minute) };
  };
}
const hourLabel = (h) => (h % 24 === 0 ? 'midnight' : h === 12 ? 'noon' : `${h % 12} ${h < 12 ? 'AM' : 'PM'}`);
// Spanish: "entre la 1 AM y las 3 AM", "la medianoche", "el mediodía".
const horaEs = (h) => (h % 24 === 0 ? 'la medianoche' : h === 12 ? 'el mediodía' : `${h % 12 === 1 ? 'la' : 'las'} ${h % 12} ${h < 12 ? 'AM' : 'PM'}`);
const SLOT_ES = { breakfast: 'el desayuno', lunch: 'el almuerzo', dinner: 'la cena' };
const PART_ES = { night: 'la madrugada', morning: 'la mañana', afternoon: 'la tarde', evening: 'la noche' };
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (x) => `${Math.round(x * 100)}%`;
const SLOTS = [['breakfast', 300, 630], ['lunch', 660, 900], ['dinner', 1020, 1290]];

/** { patterns: [{ kind, text }], days, note } — at most 5 patterns, the most useful first. */
export function findPatterns(points, events = [], { now = Date.now(), tz = 'America/New_York', low = 70, high = 180, fmt = (mg) => `${Math.round(mg)}`, unit = 'mg/dL', lang = 'en', notes = [] } = {}) {
  const es = lang === 'es';
  const localParts = partsIn(tz);
  const pts = points.filter((p) => p.t > now - 14 * DAY && p.t <= now && Number.isFinite(p.mg)).sort((a, b) => a.t - b.t)
    .map((p) => ({ ...p, ...localParts(p.t) }));
  const byDate = new Map();
  for (const p of pts) byDate.set(p.date, [...(byDate.get(p.date) || []), p]);
  const days = [...byDate.entries()].filter(([, l]) => new Set(l.map((x) => Math.floor(x.minute / 15))).size >= 48);
  if (days.length < 5) return { patterns: [], days: days.length, note: es ? `Los patrones necesitan al menos 5 días de lecturas; ${days.length === 1 ? 'hay 1' : `hay ${days.length}`} hasta ahora.` : `Patterns need at least 5 days of readings; there ${days.length === 1 ? 'is 1' : `are ${days.length}`} so far.` };
  const good = new Set(days.map(([d]) => d));
  const use = pts.filter((p) => good.has(p.date));
  const n = days.length;
  const out = [];
  const amount = (mg) => `${fmt(mg)} ${unit}`.trim();

  // Lows that come back at the same time of day.
  const lowDays = Array.from({ length: 12 }, () => new Set());
  for (const [date, l] of days) {
    let inLow = false;
    for (const x of l) {
      if (x.mg < low && !inLow) { lowDays[Math.floor(x.minute / 120)].add(date); inLow = true; } else if (x.mg >= low) inLow = false;
    }
  }
  const lowWins = lowDays.map((s, i) => ({ i, k: s.size })).filter((w) => w.k >= 3).sort((a, b) => b.k - a.k);
  const taken = new Set();
  for (const w of lowWins) {
    if (taken.has(w.i - 1) || taken.has(w.i + 1) || taken.size >= 2) continue;
    taken.add(w.i);
    out.push({ kind: 'lows', w: 100 + w.k, text: es ? `Bajas en ${w.k} de los últimos ${n} días entre ${horaEs(w.i * 2)} y ${horaEs(w.i * 2 + 2)}.` : `Lows on ${w.k} of the last ${n} days between ${hourLabel(w.i * 2)} and ${hourLabel(w.i * 2 + 2)}.` });
  }

  // Highs above 250 at the same time of day.
  const hiDays = Array.from({ length: 8 }, () => new Set());
  for (const x of use) if (x.mg > 250) hiDays[Math.floor(x.minute / 180)].add(x.date);
  const hi = hiDays.map((s, i) => ({ i, k: s.size })).filter((w) => w.k >= 4).sort((a, b) => b.k - a.k)[0];
  if (hi) out.push({ kind: 'highs', w: 80 + hi.k, text: es ? `Por encima de ${amount(250)} en ${hi.k} de los últimos ${n} días entre ${horaEs(hi.i * 3)} y ${horaEs(hi.i * 3 + 3)}.` : `Above ${amount(250)} on ${hi.k} of the last ${n} days between ${hourLabel(hi.i * 3)} and ${hourLabel(hi.i * 3 + 3)}.` });

  // A rise before waking.
  const near = (l, minute) => l.filter((x) => Math.abs(x.minute - minute) <= 20).sort((a, b) => Math.abs(a.minute - minute) - Math.abs(b.minute - minute))[0];
  const rises = days.map(([, l]) => { const a = near(l, 180), b = near(l, 420); return a && b ? b.mg - a.mg : null; }).filter((x) => x != null);
  const dawn = rises.length >= 5 ? median(rises) : null;
  if (dawn != null && dawn >= 25) out.push({ kind: 'dawn', w: 70, text: es ? `Casi todas las mañanas la glucosa sube unos ${amount(dawn)} entre las 3 y las 7 AM, antes del desayuno.` : `On most mornings glucose rises about ${amount(dawn)} between 3 and 7 AM, before breakfast.` });

  // After meals: from logged carbs or rapid insulin (one per meal), by meal time.
  const anchors = events.filter((e) => e.type === 'meal' || (e.type === 'insulin' && ['rapid', 'short', 'mix'].includes(e.kind || 'rapid')))
    .filter((e) => e.t > now - 14 * DAY && e.t < now - 3 * 60 * MIN).sort((a, b) => a.t - b.t)
    .filter((e, i, a) => i === 0 || e.t - a[i - 1].t > 45 * MIN);
  const bySlot = {};
  for (const e of anchors) {
    const { minute } = localParts(e.t);
    const slot = SLOTS.find(([, a, b]) => minute >= a && minute < b);
    if (!slot) continue;
    const base = use.filter((x) => Math.abs(x.t - e.t) <= 20 * MIN).sort((a, b) => Math.abs(a.t - e.t) - Math.abs(b.t - e.t))[0];
    const after = use.filter((x) => x.t > e.t && x.t <= e.t + 3 * 60 * MIN);
    if (!base || after.length < 4) continue;
    const peak = after.reduce((a, b) => (b.mg > a.mg ? b : a));
    (bySlot[slot[0]] = bySlot[slot[0]] || []).push({ rise: peak.mg - base.mg, mins: (peak.t - e.t) / MIN });
  }
  const meals = Object.entries(bySlot).filter(([, l]) => l.length >= 3).map(([slot, l]) => ({ slot, rise: median(l.map((x) => x.rise)), mins: median(l.map((x) => x.mins)), k: l.length }));
  meals.sort((a, b) => b.rise - a.rise);
  if (meals.length && meals[0].rise >= 50) {
    const m = meals[0];
    const when = m.mins >= 60 ? `${Math.floor(m.mins / 60)} h ${Math.round(m.mins % 60)} min` : `${Math.round(m.mins)} min`;
    const last = meals[meals.length - 1];
    const less = meals.length > 1 && m.rise - last.rise >= 30;
    const other = less ? (es ? ` Sube menos después de ${SLOT_ES[last.slot]} (unos ${amount(last.rise)}).` : ` Less after ${last.slot} (about ${amount(last.rise)}).`) : '';
    out.push({ kind: 'meals', w: 60, text: es ? `Después de ${SLOT_ES[m.slot]}, la glucosa sube unos ${amount(m.rise)} (la mediana de ${m.k} comidas), con el pico unos ${when} después.${other}` : `After ${m.slot}, glucose rises about ${amount(m.rise)} (the middle of ${m.k} meals), peaking about ${when} later.${other}` });
  }

  // What follows a note's tag: only notes whose 6 hours are over count.
  const byTag = {};
  for (const nt of notes) {
    if (!(nt.t > now - 14 * DAY && nt.t <= now - 6 * 60 * MIN)) continue;
    for (const tag of nt.tags || []) if (NOTE_TAGS.includes(tag)) (byTag[tag] = byTag[tag] || []).push(nt.t);
  }
  for (const [tag, ts] of Object.entries(byTag)) {
    if (ts.length < 3) continue;
    const after = (t) => use.filter((x) => x.t > t && x.t <= t + 6 * 60 * MIN);
    const lows = ts.filter((t) => after(t).some((x) => x.mg < low)).length;
    const highs = ts.filter((t) => after(t).some((x) => x.mg > 250)).length;
    const word = TAG_WORDS[es ? 'es' : 'en'][tag];
    if (lows >= 2 && lows / ts.length >= 0.5) out.push({ kind: 'tag-low', w: 90 + lows, text: es ? `Después de las notas de “${word}”, hubo una baja en las 6 horas siguientes ${lows} de ${ts.length} veces.` : `After “${word}” notes, a low followed within 6 hours ${lows} of ${ts.length} times.` });
    else if (highs >= 2 && highs / ts.length >= 0.5) out.push({ kind: 'tag-high', w: 75 + highs, text: es ? `Después de las notas de “${word}”, la glucosa pasó de ${amount(250)} en las 6 horas siguientes ${highs} de ${ts.length} veces.` : `After “${word}” notes, glucose went above ${amount(250)} within 6 hours ${highs} of ${ts.length} times.` });
  }

  // Weekdays and weekends.
  const tir = (l) => (l.length ? l.filter((x) => x.mg >= low && x.mg <= high).length / l.length : null);
  const weekend = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const wkDays = days.filter(([d]) => !weekend(d)), weDays = days.filter(([d]) => weekend(d));
  if (wkDays.length >= 3 && weDays.length >= 2) {
    const a = tir(wkDays.flatMap(([, l]) => l)), b = tir(weDays.flatMap(([, l]) => l));
    if (Math.abs(a - b) >= 0.1) out.push({ kind: 'weekend', w: 50, text: es ? `El tiempo en rango es ${pct(a)} entre semana y ${pct(b)} los fines de semana.` : `Time in range is ${pct(a)} on weekdays and ${pct(b)} on weekends.` });
  }

  // The steadiest and the hardest part of the day.
  const parts = [['night', 0, 360], ['morning', 360, 720], ['afternoon', 720, 1080], ['evening', 1080, 1440]]
    .map(([name, a, b]) => { const l = use.filter((x) => x.minute >= a && x.minute < b); return { name, v: tir(l), k: new Set(l.map((x) => x.date)).size }; })
    .filter((p) => p.v != null && p.k >= 3).sort((x, y) => y.v - x.v);
  if (parts.length >= 2 && parts[0].v - parts[parts.length - 1].v >= 0.15) {
    const best = parts[0], worst = parts[parts.length - 1];
    out.push({ kind: 'parts', w: 40, text: es ? `Tu momento más estable es ${PART_ES[best.name]} (${pct(best.v)} en rango); el más difícil es ${PART_ES[worst.name]} (${pct(worst.v)}).` : `Your steadiest time is the ${best.name} (${pct(best.v)} in range); the hardest is the ${worst.name} (${pct(worst.v)}).` });
  }

  out.sort((a, b) => b.w - a.w);
  return { patterns: out.slice(0, 5).map(({ kind, text }) => ({ kind, text })), days: n, note: out.length ? null : es ? `No hay patrones claros en los últimos ${n} días.` : `No clear patterns in the last ${n} days.` };
}
