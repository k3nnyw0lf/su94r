// Pens, vials and sensors: how much is left, when an opened pen should be thrown away, and
// when to reorder. Units used come from the insulin markers logged since the pen was opened,
// plus the units primed before each injection. Pure functions; the settings page and the
// background worker use them.
//
// settings.supplies = {
//   pens: [{ id, name, kind, units, days, openedAt, prime }],   one per pen or vial in use
//   sensorsLeft: number | null,   unopened sensors at home
//   reorderAt: number,            warn when this many (or fewer) are left
// }

// Common pens and vials: units in one, and days it may be used once opened (from the
// product leaflets; storage below 86 °F / 30 °C). Check your own leaflet: the days can be changed.
export const PRESETS = [
  { name: 'Humulin R vial (10 mL)', kind: 'short', units: 1000, days: 31 },
  { name: 'Novolin R vial (10 mL)', kind: 'short', units: 1000, days: 42 },
  { name: 'Humulin R U-500 KwikPen', kind: 'short', units: 1500, days: 28 },
  { name: 'Humalog KwikPen', kind: 'rapid', units: 300, days: 28 },
  { name: 'NovoLog FlexPen', kind: 'rapid', units: 300, days: 28 },
  { name: 'Fiasp FlexTouch', kind: 'rapid', units: 300, days: 28 },
  { name: 'Lyumjev KwikPen', kind: 'rapid', units: 300, days: 28 },
  { name: 'Admelog SoloStar', kind: 'rapid', units: 300, days: 28 },
  { name: 'Rapid insulin vial (10 mL)', kind: 'rapid', units: 1000, days: 28 },
  { name: 'Lantus SoloStar', kind: 'basal', units: 300, days: 28 },
  { name: 'Basaglar KwikPen', kind: 'basal', units: 300, days: 28 },
  { name: 'Semglee pen', kind: 'basal', units: 300, days: 28 },
  { name: 'Toujeo SoloStar', kind: 'basal', units: 450, days: 56 },
  { name: 'Tresiba FlexTouch U-100', kind: 'basal', units: 300, days: 56 },
  { name: 'Tresiba FlexTouch U-200', kind: 'basal', units: 600, days: 56 },
  { name: 'Levemir FlexPen', kind: 'basal', units: 300, days: 42 },
  { name: 'Humulin N KwikPen', kind: 'intermediate', units: 300, days: 14 },
  { name: 'Humulin 70/30 KwikPen', kind: 'mix', units: 300, days: 10 },
];

export const DEFAULT_SUPPLIES = { pens: [], sensorsLeft: null, reorderAt: 1 };
const DAY = 864e5;

/** Insulin markers that count against a pen: same person, same kind, since it was opened. */
function dosesFor(pen, events, pid) {
  return (events || []).filter((e) => e.type === 'insulin' && e.p === pid && (e.kind || 'rapid') === pen.kind && e.t >= pen.openedAt && Number(e.amount) > 0);
}

/**
 * One pen or vial: units left, how fast it is being used, and when it runs out or expires.
 * status: 'ok', 'soon' (within 3 days) or 'now'; `why` says which comes first.
 */
export function penStatus(pen, events, pid, now = Date.now()) {
  const doses = dosesFor(pen, events, pid);
  const prime = Number.isFinite(pen.prime) ? pen.prime : (pen.units >= 1000 ? 0 : 2);   // vials are not primed
  const used = doses.reduce((a, d) => a + Number(d.amount) + prime, 0);
  const left = Math.max(0, pen.units - used);
  // Pace: units a day over the last 7 days (or since opening, if sooner).
  const since = Math.max(pen.openedAt, now - 7 * DAY);
  const recent = doses.filter((d) => d.t >= since).reduce((a, d) => a + Number(d.amount) + prime, 0);
  const perDay = recent / Math.max(1, (now - since) / DAY);
  const expiresAt = pen.openedAt + pen.days * DAY;
  const emptyAt = perDay > 0 ? now + (left / perDay) * DAY : null;
  const endsAt = emptyAt ? Math.min(emptyAt, expiresAt) : expiresAt;
  const why = left <= 0 ? 'empty' : emptyAt && emptyAt < expiresAt ? 'units' : 'date';
  const daysLeft = (endsAt - now) / DAY;
  return {
    id: pen.id, name: pen.name, kind: pen.kind, used, left, perDay, expiresAt, emptyAt, endsAt, why, daysLeft,
    status: left <= 0 || daysLeft <= 0 ? 'now' : daysLeft <= 3 ? 'soon' : 'ok',
  };
}

/** Plain words for a pen's status. */
export function penLine(s, fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) {
  const left = `${Math.round(s.left)} units left`;
  if (s.why === 'empty') return `${s.name}: empty by the doses logged. Open a new one and add it here.`;
  if (s.status === 'now') return `${s.name}: its time since opening ended ${fmtDate(s.expiresAt)}. Throw it away and open a new one.`;
  const pace = s.perDay > 0 ? `, about ${Math.round(s.perDay)} a day` : '';
  const end = s.why === 'units' ? `runs out around ${fmtDate(s.emptyAt)}` : `use by ${fmtDate(s.expiresAt)} (days since opening)`;
  return `${s.name}: ${left}${pace}; ${end}.`;
}

/** Everything to warn about now: pens ending within 3 days, sensors running low. */
export function supplyWarnings(supplies, events, pid, now = Date.now()) {
  const s = { ...DEFAULT_SUPPLIES, ...(supplies || {}) };
  const out = [];
  for (const pen of s.pens || []) {
    const st = penStatus(pen, events, pid, now);
    if (st.status !== 'ok') out.push({ id: `pen|${pen.id}|${st.status}`, kind: 'pen', status: st.status, text: penLine(st) });
  }
  if (Number.isFinite(s.sensorsLeft) && s.sensorsLeft <= s.reorderAt) {
    out.push({
      id: `sensors|${s.sensorsLeft}`, kind: 'sensors', status: s.sensorsLeft === 0 ? 'now' : 'soon',
      text: s.sensorsLeft === 0 ? 'No spare sensors at home. Reorder now; delivery can take a week.' : `${s.sensorsLeft} spare sensor${s.sensorsLeft === 1 ? '' : 's'} at home. Time to reorder.`,
    });
  }
  return out;
}

/** A new sensor was put on: one fewer spare. */
export const sensorUsed = (supplies) => ({ ...DEFAULT_SUPPLIES, ...supplies, sensorsLeft: Number.isFinite(supplies?.sensorsLeft) ? Math.max(0, supplies.sensorsLeft - 1) : null });
