// ═══════════════════════════════════════════════════════════════════════════
// Insulin catalog.
//
// Curated rather than fetched. Only about twenty insulins matter clinically,
// and the two things that matter most for this app — action profile and
// CONCENTRATION — are either absent from drug APIs or buried in label prose.
//
// Concentration is the safety-critical field. U-200, U-300 and especially
// U-500 deliver the same number of units in a smaller volume, and U-500 in
// particular is a well-documented source of serious dosing errors. su94r
// therefore always shows the concentration next to the name and never lets a
// concentrated insulin be selected silently.
//
// `category` drives real behaviour: iob.js excludes basal entirely, because
// summing long-acting insulin into a bolus IOB curve would wildly overstate
// active insulin and could lead someone to skip a correction they needed.
//
// Peak and duration are the manufacturers' published figures for adults. They
// vary between people, which is why settings allow overrides.
// ═══════════════════════════════════════════════════════════════════════════

export const CATEGORY = {
  RAPID: 'rapid',
  SHORT: 'short',
  INTERMEDIATE: 'intermediate',
  BASAL: 'basal',
  MIX: 'mix',
};

export const CATEGORY_LABEL = {
  rapid: 'Rapid-acting (mealtime)',
  short: 'Short-acting (regular)',
  intermediate: 'Intermediate (NPH)',
  basal: 'Long-acting (basal)',
  mix: 'Pre-mixed',
};

/**
 * peakMin / durationMin are used by the IOB curve and are meaningful only for
 * bolus insulins. Basal entries carry nominal duration for display and are
 * never fed to the curve.
 */
export const INSULINS = [
  // ── Rapid-acting ─────────────────────────────────────────────────────────
  { id: 'lyumjev', brand: 'Lyumjev', generic: 'insulin lispro-aabc', category: CATEGORY.RAPID, concentrations: ['U-100', 'U-200'], peakMin: 45, durationMin: 300 },
  { id: 'fiasp', brand: 'Fiasp', generic: 'insulin aspart (faster)', category: CATEGORY.RAPID, concentrations: ['U-100'], peakMin: 55, durationMin: 300 },
  { id: 'novorapid', brand: 'NovoRapid / NovoLog', generic: 'insulin aspart', category: CATEGORY.RAPID, concentrations: ['U-100'], peakMin: 75, durationMin: 360 },
  { id: 'humalog', brand: 'Humalog', generic: 'insulin lispro', category: CATEGORY.RAPID, concentrations: ['U-100', 'U-200'], peakMin: 75, durationMin: 360 },
  { id: 'admelog', brand: 'Admelog / Lyumjev biosimilar', generic: 'insulin lispro', category: CATEGORY.RAPID, concentrations: ['U-100'], peakMin: 75, durationMin: 360 },
  { id: 'apidra', brand: 'Apidra', generic: 'insulin glulisine', category: CATEGORY.RAPID, concentrations: ['U-100'], peakMin: 70, durationMin: 330 },
  { id: 'afrezza', brand: 'Afrezza', generic: 'insulin human (inhaled)', category: CATEGORY.RAPID, concentrations: ['4u', '8u', '12u cartridges'], peakMin: 15, durationMin: 160, note: 'Inhaled. Dosed in cartridges, not syringe units — they are not interchangeable.' },

  // ── Short-acting ─────────────────────────────────────────────────────────
  { id: 'regular', brand: 'Humulin R / Actrapid', generic: 'regular human insulin', category: CATEGORY.SHORT, concentrations: ['U-100'], peakMin: 150, durationMin: 480 },
  { id: 'regular-u500', brand: 'Humulin R U-500', generic: 'regular human insulin, concentrated', category: CATEGORY.SHORT, concentrations: ['U-500'], peakMin: 240, durationMin: 1440, warn: 'Five times concentrated. A well-documented source of serious dosing errors — confirm the syringe type and units with your prescriber.' },

  // ── Intermediate ─────────────────────────────────────────────────────────
  { id: 'nph', brand: 'Humulin N / Insulatard', generic: 'NPH insulin', category: CATEGORY.INTERMEDIATE, concentrations: ['U-100'], peakMin: 360, durationMin: 720 },

  // ── Long-acting / basal ──────────────────────────────────────────────────
  { id: 'lantus', brand: 'Lantus', generic: 'insulin glargine', category: CATEGORY.BASAL, concentrations: ['U-100'], durationMin: 1440 },
  { id: 'basaglar', brand: 'Basaglar / Semglee', generic: 'insulin glargine biosimilar', category: CATEGORY.BASAL, concentrations: ['U-100'], durationMin: 1440 },
  { id: 'toujeo', brand: 'Toujeo', generic: 'insulin glargine', category: CATEGORY.BASAL, concentrations: ['U-300'], durationMin: 2160, warn: 'Three times concentrated. Units are not interchangeable by volume with U-100 glargine.' },
  { id: 'levemir', brand: 'Levemir', generic: 'insulin detemir', category: CATEGORY.BASAL, concentrations: ['U-100'], durationMin: 1200 },
  { id: 'tresiba', brand: 'Tresiba', generic: 'insulin degludec', category: CATEGORY.BASAL, concentrations: ['U-100', 'U-200'], durationMin: 2520 },
  { id: 'awiqli', brand: 'Awiqli', generic: 'insulin icodec', category: CATEGORY.BASAL, concentrations: ['U-700'], durationMin: 10080, note: 'Once weekly. Not available in all markets.' },

  // ── Pre-mixed ────────────────────────────────────────────────────────────
  { id: 'novomix30', brand: 'NovoMix 30 / NovoLog Mix 70/30', generic: 'aspart protamine mix', category: CATEGORY.MIX, concentrations: ['U-100'], peakMin: 120, durationMin: 900 },
  { id: 'humalogmix25', brand: 'Humalog Mix25 / Mix50', generic: 'lispro protamine mix', category: CATEGORY.MIX, concentrations: ['U-100'], peakMin: 120, durationMin: 900 },
  { id: 'humulin7030', brand: 'Humulin 70/30', generic: 'human insulin mix', category: CATEGORY.MIX, concentrations: ['U-100'], peakMin: 180, durationMin: 1080 },
];

export const findInsulin = id => INSULINS.find(i => i.id === id) || null;

export function insulinsByCategory() {
  return Object.values(CATEGORY).map(cat => ({
    category: cat,
    label: CATEGORY_LABEL[cat],
    items: INSULINS.filter(i => i.category === cat),
  })).filter(g => g.items.length);
}

/** Bolus insulins are the only ones the IOB curve should ever see. */
export function isBolus(id) {
  const i = findInsulin(id);
  return !!i && (i.category === CATEGORY.RAPID || i.category === CATEGORY.SHORT || i.category === CATEGORY.MIX);
}

/**
 * Anything the user should be told before logging this insulin — concentration
 * hazards and dosing quirks. Surfaced at entry time, not buried in settings.
 */
export function insulinWarnings(id, concentration) {
  const i = findInsulin(id);
  if (!i) return [];
  const out = [];
  if (i.warn) out.push(i.warn);
  if (i.note) out.push(i.note);
  if (concentration && concentration !== 'U-100' && !i.warn) {
    out.push(`${concentration} is more concentrated than standard U-100. Check your pen or syringe matches.`);
  }
  return out;
}

/** Profile for the IOB curve. Null for basal, which the curve must not model. */
export function actionProfile(id) {
  const i = findInsulin(id);
  if (!i || !isBolus(id) || !i.peakMin || !i.durationMin) return null;
  return { peakMin: i.peakMin, durationMin: i.durationMin, label: i.brand };
}
