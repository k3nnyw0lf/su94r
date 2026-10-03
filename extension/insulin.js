// Insulin memory: what was logged, what is still working, and a guard against
// taking the same dose twice.
//
// Like su94r's src/lib/insulin/iob.js (whose curve this mirrors exactly), this
// module describes the PAST — doses the user logged. It never computes a dose.
// A dose recommendation is a regulated device function, and a wrong one causes
// harm within minutes; showing active insulin and catching a repeated dose
// prevents stacking, the most common way people end up low.

/** Rapid-acting profiles, minutes (manufacturers' published adult figures). */
export const RAPID_PROFILES = {
  lyumjev: { label: 'Lyumjev', peakMin: 45, durationMin: 300 },
  fiasp: { label: 'Fiasp', peakMin: 55, durationMin: 300 },
  novorapid: { label: 'NovoRapid / NovoLog', peakMin: 75, durationMin: 360 },
  humalog: { label: 'Humalog / Admelog', peakMin: 75, durationMin: 360 },
  apidra: { label: 'Apidra', peakMin: 70, durationMin: 330 },
};
export const REGULAR_PROFILE = { label: 'Regular / Actrapid', peakMin: 150, durationMin: 480 };

/** Kinds counted in active insulin. Basal, NPH and pre-mixed are not modelled by this curve. */
export const BOLUS_KINDS = new Set(['rapid', 'short']);

// Another computer's clock can run a few minutes ahead; a dose stamped up to this far in
// the future is treated as "now" rather than ignored.
const CLOCK_SLACK_MS = 10 * 60e3;

/**
 * Fraction of a dose still active `minutesSince` after it was given.
 * Standard exponential model (published pharmacokinetics), identical to su94r iob.js.
 */
export function activeFraction(minutesSince, { peakMin, durationMin }) {
  const t = Number(minutesSince);
  const td = Number(durationMin);
  const tp = Number(peakMin);
  if (!Number.isFinite(t) || t < 0) return 0;
  if (t >= td) return 0;
  if (!(td > 0) || !(tp > 0) || tp >= td / 2) return Math.max(0, 1 - t / td);
  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  const iob = 1 - S * (1 - a) * (((t * t) / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);
  return Math.min(1, Math.max(0, iob));
}

export function profileFor(kind, settings = {}) {
  if (kind === 'short') return REGULAR_PROFILE;
  return RAPID_PROFILES[settings.rapidInsulin] || RAPID_PROFILES.novorapid;
}

/** Logged insulin for one person. With needAmount false, doses logged without an amount are included. */
const insulinDoses = (events, pid, { needAmount = true } = {}) =>
  (events || []).filter((e) => e.type === 'insulin' && e.p === pid && (!needAmount || Number(e.amount) > 0));

/** Units of bolus insulin still working. Doses with no type are treated as rapid. */
export function insulinOnBoard(events, pid, settings = {}, now = Date.now()) {
  let units = 0;
  for (const d of insulinDoses(events, pid)) {
    const kind = d.kind || 'rapid';
    if (!BOLUS_KINDS.has(kind) || d.t > now + CLOCK_SLACK_MS) continue;
    units += Number(d.amount) * activeFraction(Math.max(0, now - d.t) / 60e3, profileFor(kind, settings));
  }
  return Math.round(units * 10) / 10;
}

/** Most recent logged dose matching `kinds` (a Set), or of any kind when omitted. Includes doses with no amount. */
export function lastDose(events, pid, kinds = null, now = Date.now()) {
  return insulinDoses(events, pid, { needAmount: false })
    .filter((d) => d.t <= now + CLOCK_SLACK_MS && (!kinds || kinds.has(d.kind || 'rapid')))
    .sort((a, b) => b.t - a.t)[0] || null;
}

// Which earlier doses a new one is checked against, and how far apart (hours).
// Pre-mixed insulin holds a rapid part and an NPH part, so it is checked both ways.
const GUARD = {
  rapid: [[['rapid', 'short', 'mix'], 3]],
  short: [[['rapid', 'short', 'mix'], 3]],
  basal: [[['basal'], 16]],
  intermediate: [[['intermediate', 'mix'], 8]],
  mix: [[['mix', 'intermediate'], 8], [['rapid', 'short'], 3]],
};

/**
 * Warning before logging a dose that may repeat one already taken, or null.
 * Looks both ways in time, because a dose can be logged after the fact:
 * rapid or regular — another rapid, regular or pre-mixed dose within 3 hours;
 * long-acting — another long-acting dose within 16 hours (the classic "did I take
 * my Lantus?" double dose); NPH and pre-mixed — each other within 8 hours, and
 * pre-mixed also against rapid doses within 3 hours. Doses logged without an
 * amount count too.
 */
export function doubleDoseWarning(events, pid, candidate, settings = {}, now = Date.now(), lang = 'en') {
  const rules = GUARD[candidate.kind || 'rapid'];
  if (!rules) return null;
  const near = insulinDoses(events, pid, { needAmount: false })
    .filter((d) => d.id !== candidate.id && rules.some(([kinds, hours]) => kinds.includes(d.kind || 'rapid') && Math.abs(candidate.t - d.t) < hours * 3600e3))
    .sort((a, b) => Math.abs(candidate.t - a.t) - Math.abs(candidate.t - b.t))[0];
  if (!near) return null;
  const group = BOLUS_KINDS.has(near.kind || 'rapid') ? BOLUS_KINDS : null;
  const mins = Math.round(Math.abs(candidate.t - near.t) / 60e3);
  const gap = mins < 1 ? 'less than a minute' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  const isNow = Math.abs(now - candidate.t) < 2 * 60e3;
  const rel = isNow ? `${gap} ago` : near.t <= candidate.t ? `${gap} before this time` : `${gap} after this time`;
  const active = group === BOLUS_KINDS && near.t <= candidate.t ? insulinOnBoard(events, pid, settings, candidate.t) : 0;
  if (lang === 'es') {
    const kindEs = { rapid: 'rápida', short: 'regular', intermediate: 'NPH', basal: 'de acción prolongada', mix: 'premezclada' }[near.kind || 'rapid'] || near.kind;
    const gapEs = mins < 1 ? 'menos de un minuto' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
    const relEs = isNow ? `hace ${gapEs}` : near.t <= candidate.t ? `${gapEs} antes de esa hora` : `${gapEs} después de esa hora`;
    const queEs = Number(near.amount) > 0 ? `${near.amount} u de insulina ${kindEs}` : `una dosis de insulina ${kindEs} (sin cantidad anotada)`;
    return `Ya registraste ${queEs} ${relEs}` + (active > 0 ? ` (${active} u ${isNow ? 'aún activas' : 'activas a esa hora'})` : '') + '.';
  }
  const what = Number(near.amount) > 0 ? `${near.amount} u ${kindWord(near.kind)}` : `a ${kindWord(near.kind)} dose (amount not logged)`;
  return `You already logged ${what} ${rel}`
    + (active > 0 ? ` (${active} u ${isNow ? 'still active' : 'active then'})` : '') + '.';
}

export function kindWord(kind) {
  return { rapid: 'rapid', short: 'regular', intermediate: 'NPH', basal: 'long-acting', mix: 'pre-mixed' }[kind || 'rapid'] || kind;
}

/** Same medicine (by RxNorm id or name) logged within 4 hours of this time, or null. */
export function medDuplicateWarning(events, pid, candidate, now = Date.now()) {
  const same = (events || []).filter((e) => e.p === pid && e.type === 'med'
    && (e.medId && e.medId === candidate.medId || e.medName === candidate.medName)
    && Math.abs(candidate.t - e.t) < 4 * 3600e3)
    .sort((a, b) => Math.abs(candidate.t - a.t) - Math.abs(candidate.t - b.t))[0];
  if (!same) return null;
  const mins = Math.round(Math.abs(candidate.t - same.t) / 60e3);
  const gap = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  const rel = Math.abs(now - candidate.t) < 2 * 60e3 ? `${gap} ago` : same.t <= candidate.t ? `${gap} before this time` : `${gap} after this time`;
  return `You already logged ${same.medName}${same.amount != null ? ` ${same.amount} ${same.unit || ''}`.trimEnd() : ''} ${rel}.`;
}
