// Two looks back at the last 14 days, from the server's readings and the logged insulin and meals.
// They describe what happened; they never advise a dose or a change.
//
//   lowReview: how many lows, how long they lasted, how many were followed by a high above 250
//     within 3 hours (often a sign of eating more than needed while low), and the carbs logged in
//     the first half hour of each.
//   mealTiming: how much glucose rose after meals, grouped by when the rapid insulin was logged
//     against the meal (after it, at it, 10 to 19 minutes before, 20 or more before).

const MIN = 60e3, DAY = 864e5;
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Lows in the last 14 days: { count, medianMin, longestMin, rebounds, medianGrams, lines } */
export function lowReview(points, events = [], { now = Date.now(), low = 70, fmt = (mg) => `${Math.round(mg)}`, lang = 'en' } = {}) {
  const es = lang === 'es';
  const pts = points.filter((p) => p.t > now - 14 * DAY && p.t <= now).sort((a, b) => a.t - b.t);
  const eps = [];
  let cur = null;
  for (const p of pts) {
    if (p.mg < low && !cur) cur = { start: p.t, end: p.t, lowest: p.mg };
    else if (p.mg < low && cur) { cur.end = p.t; cur.lowest = Math.min(cur.lowest, p.mg); }
    else if (p.mg >= low && cur) { cur.end = p.t; eps.push(cur); cur = null; }
  }
  if (cur) eps.push(cur);
  const meals = events.filter((e) => e.type === 'meal');
  for (const ep of eps) {
    ep.min = Math.max(5, Math.round((ep.end - ep.start) / MIN));
    ep.rebound = pts.some((p) => p.t > ep.end && p.t <= ep.end + 3 * 60 * MIN && p.mg > 250);
    const g = meals.filter((m) => m.t >= ep.start - 5 * MIN && m.t <= ep.start + 30 * MIN).reduce((s, m) => s + (Number(m.amount) || 0), 0);
    ep.grams = g || null;
  }
  const count = eps.length;
  const out = { count, medianMin: median(eps.map((e) => e.min)), longestMin: count ? Math.max(...eps.map((e) => e.min)) : null, rebounds: eps.filter((e) => e.rebound).length, medianGrams: median(eps.filter((e) => e.grams).map((e) => e.grams)), lines: [] };
  if (!count) { out.lines.push(es ? 'Sin bajas en los últimos 14 días.' : 'No lows in the last 14 days.'); return out; }
  out.lines.push(es
    ? `${count === 1 ? 'Una baja' : `${count} bajas`} en 14 días; duraron unos ${out.medianMin} min (la mediana), la más larga ${out.longestMin} min.`
    : `${count === 1 ? 'One low' : `${count} lows`} in 14 days; they lasted about ${out.medianMin} min (the middle one), the longest ${out.longestMin} min.`);
  if (out.rebounds) out.lines.push(es
    ? `${out.rebounds} de ${count} fueron seguidas por más de ${fmt(250)} en 3 horas. Eso a menudo pasa al comer de más mientras estás bajo; tu plan para bajas dice cuánto tomar.`
    : `${out.rebounds} of ${count} were followed by more than ${fmt(250)} within 3 hours. That often comes from eating more than needed while low; your low plan says how much to take.`);
  if (out.medianGrams) out.lines.push(es ? `Carbohidratos registrados en la primera media hora: unos ${out.medianGrams} g (la mediana).` : `Carbs logged in the first half hour: about ${out.medianGrams} g (the middle one).`);
  return out;
}

const BUCKETS = [['after', -60, -2.0001], ['at', -2, 9.9999], ['10-19', 10, 19.9999], ['20+', 20, 60]];
const BUCKET_WORDS = {
  en: { after: 'Insulin after eating', at: 'Insulin at the meal (up to 9 min before)', '10-19': 'Insulin 10 to 19 min before eating', '20+': 'Insulin 20 or more min before eating' },
  es: { after: 'Insulina después de comer', at: 'Insulina con la comida (hasta 9 min antes)', '10-19': 'Insulina de 10 a 19 min antes de comer', '20+': 'Insulina 20 min o más antes de comer' },
};

/** Rise after meals by insulin timing, in the last 14 days: { groups: [{ key, n, rise }], lines } */
export function mealTiming(points, events = [], { now = Date.now(), fmt = (mg) => `${Math.round(mg)}`, lang = 'en' } = {}) {
  const es = lang === 'es';
  const pts = points.filter((p) => p.t > now - 14 * DAY - 3 * 60 * MIN && p.t <= now).sort((a, b) => a.t - b.t);
  const doses = events.filter((e) => e.type === 'insulin' && ['rapid', 'short', 'mix'].includes(e.kind || 'rapid'));
  const meals = events.filter((e) => e.type === 'meal' && e.t > now - 14 * DAY && e.t < now - 3 * 60 * MIN).sort((a, b) => a.t - b.t)
    .filter((e, i, a) => i === 0 || e.t - a[i - 1].t > 45 * MIN);
  const by = {};
  for (const m of meals) {
    const d = doses.filter((x) => x.t >= m.t - 60 * MIN && x.t <= m.t + 60 * MIN).sort((a, b) => Math.abs(a.t - m.t) - Math.abs(b.t - m.t))[0];
    if (!d) continue;
    const gap = (m.t - d.t) / MIN;                                    // positive: insulin before eating
    const bucket = BUCKETS.find(([, a, b]) => gap >= a && gap <= b);
    if (!bucket) continue;
    const base = pts.filter((p) => Math.abs(p.t - m.t) <= 15 * MIN).sort((a, b) => Math.abs(a.t - m.t) - Math.abs(b.t - m.t))[0];
    const after = pts.filter((p) => p.t > m.t && p.t <= m.t + 3 * 60 * MIN);
    if (!base || after.length < 6) continue;
    (by[bucket[0]] = by[bucket[0]] || []).push(Math.max(...after.map((p) => p.mg)) - base.mg);
  }
  const groups = BUCKETS.map(([key]) => ({ key, n: (by[key] || []).length, rise: median(by[key] || []) })).filter((g) => g.n >= 3);
  const words = BUCKET_WORDS[es ? 'es' : 'en'];
  const lines = groups.map((g) => (es ? `${words[g.key]}: subió unos ${fmt(g.rise)} (${g.n} comidas).` : `${words[g.key]}: rose about ${fmt(g.rise)} (${g.n} meals).`));
  if (!groups.length) lines.push(es ? 'Todavía no hay suficientes comidas con insulina registrada cerca (hacen falta 3 por grupo).' : 'Not enough meals with insulin logged near them yet (3 per group are needed).');
  else lines.push(es ? 'Describe tus propios registros; habla con tu médico antes de cambiar cuándo te pones la insulina.' : 'This describes your own logs; talk with your doctor before changing when you take insulin.');
  return { groups, lines };
}
