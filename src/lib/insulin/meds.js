// ═══════════════════════════════════════════════════════════════════════════
// Medication lookup and logging.
//
// Two free, keyless government APIs, both verified live:
//
//   RxNorm (NIH / NLM)  — the canonical US drug terminology. Best for search
//                         and autocomplete; returns normalised names and RxCUIs.
//   openFDA             — label text, warnings and interactions. Already used
//                         by src/lib/apis/health.js searchDrug().
//
// Not HealthSherpa. That is an ACA insurance-enrolment API — plans, quotes and
// county FIPS codes. It has no drug database and cannot answer any question
// this module asks.
//
// SCOPE: this records what the user takes and surfaces the label. It does not
// advise on dose, timing, or whether to take anything. Interaction text is
// reproduced from the FDA label and pointed at the prescriber, not summarised
// into advice.
// ═══════════════════════════════════════════════════════════════════════════

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const OPENFDA = 'https://api.fda.gov/drug/label.json';

/**
 * Searches RxNorm for a drug by name.
 * Returns normalised candidates so the user picks a real product rather than
 * free-typing a name that later cannot be looked up.
 */
export async function searchMedication(query, { signal } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const res = await fetch(`${RXNAV}/drugs.json?name=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`RxNorm lookup failed (${res.status})`);
  const body = await res.json();

  const groups = body?.drugGroup?.conceptGroup || [];
  const seen = new Set();
  const out = [];

  for (const g of groups) {
    for (const c of g.conceptProperties || []) {
      const key = c.rxcui;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        rxcui: c.rxcui,
        name: c.name,
        synonym: c.synonym || '',
        // TTY tells you what KIND of concept this is. SBD/SCD are dispensable
        // products; IN is a bare ingredient. Showing them undifferentiated
        // makes users pick ingredients that have no strength attached.
        termType: c.tty,
        isProduct: ['SBD', 'SCD', 'BPCK', 'GPCK'].includes(c.tty),
      });
    }
  }

  // Dispensable products first — they carry strength and form.
  const ranked = out
    .map(c => ({ ...c, ...parseStrength(c.name) }))
    .sort((a, b) => Number(b.isProduct) - Number(a.isProduct))
    .slice(0, 25);

  // A misspelt drug name returning nothing is worse than useless — the user
  // types it again slightly differently and gives up. "humulog" is one
  // character from "humalog", and they are not the same product.
  if (!ranked.length) {
    const suggestions = await spellingSuggestions(q, { signal });
    if (suggestions.length) {
      const err = new Error(`No match for "${q}". Did you mean: ${suggestions.slice(0, 3).join(', ')}?`);
      err.suggestions = suggestions;
      throw err;
    }
  }

  return ranked;
}

/** RxNorm's own spell-check. Used only when a search comes back empty. */
export async function spellingSuggestions(query, { signal } = {}) {
  try {
    const res = await fetch(
      `${RXNAV}/spellingsuggestions.json?name=${encodeURIComponent(query)}`, { signal }
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body?.suggestionGroup?.suggestionList?.suggestion || [];
  } catch {
    return [];
  }
}

/**
 * Pulls strength out of an RxNorm name, e.g.
 *   "3 ML insulin glargine 100 UNT/ML Pen Injector [Lantus]" → U-100, pen.
 *
 * Concentration is the field most worth surfacing: U-100 and U-300 glargine
 * are both "glargine", and confusing them is a dosing hazard.
 */
export function parseStrength(name = '') {
  const unt = name.match(/(\d+)\s*UNT\/ML/i);
  const mgml = name.match(/([\d.]+)\s*MG\/ML/i);
  const form =
    /pen injector/i.test(name) ? 'pen'
    : /injectable solution|injection/i.test(name) ? 'vial'
    : /tablet/i.test(name) ? 'tablet'
    : /capsule/i.test(name) ? 'capsule'
    : null;

  return {
    concentration: unt ? `U-${unt[1]}` : null,
    strength: mgml ? `${mgml[1]} mg/mL` : null,
    form,
    isInsulin: /insulin/i.test(name),
  };
}

/** Label detail from openFDA. Returns null when the drug has no label on file. */
export async function medicationLabel(name, { signal } = {}) {
  const res = await fetch(
    `${OPENFDA}?search=openfda.generic_name:"${encodeURIComponent(name)}"&limit=1`,
    { signal }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`openFDA lookup failed (${res.status})`);

  const body = await res.json();
  const r = body?.results?.[0];
  if (!r) return null;

  const first = f => (Array.isArray(r[f]) ? r[f][0] : r[f]) || null;
  const trim = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);

  return {
    brandName: r.openfda?.brand_name?.[0] || null,
    genericName: r.openfda?.generic_name?.[0] || null,
    manufacturer: r.openfda?.manufacturer_name?.[0] || null,
    // Deliberately kept as label text rather than summarised. Paraphrasing a
    // drug warning is how meaning gets lost.
    warnings: trim(first('warnings') || first('warnings_and_cautions'), 1200),
    interactions: trim(first('drug_interactions'), 1200),
    hypoglycemia: trim(first('hypoglycemia'), 800),
  };
}

// ─── Logging ────────────────────────────────────────────────────────────────

export const DOSE_CONTEXT = {
  MEAL: 'meal',
  CORRECTION: 'correction',
  BASAL: 'basal',
  EXERCISE: 'exercise',
  OTHER: 'other',
};

export const DOSE_CONTEXT_LABEL = {
  meal: 'With food',
  correction: 'Correction',
  basal: 'Basal',
  exercise: 'Around exercise',
  other: 'Other',
};

/**
 * Builds a validated insulin dose entry.
 *
 * Validation is strict on purpose. A mistyped dose is the single most dangerous
 * piece of bad data this app can hold: it corrupts IOB, which is the number
 * that stops people stacking.
 */
export function buildDoseEntry({
  units, insulinType, concentration = 'U-100',
  context = DOSE_CONTEXT.MEAL, takenAt = new Date().toISOString(),
  carbsGrams = null, note = '', mealId = null,
}) {
  const u = Number(units);
  if (!Number.isFinite(u) || u <= 0) throw new Error('Enter a dose greater than zero.');
  // Not a clinical limit — a typo guard. 100u in one entry is far more likely
  // to be a slipped decimal than a real bolus, and it should be confirmed.
  if (u > 100) throw new Error('That dose looks unusually large. Check it and re-enter if correct.');
  if (!insulinType) throw new Error('Choose which insulin this was.');

  const t = new Date(takenAt).getTime();
  if (!Number.isFinite(t)) throw new Error('Unreadable time.');
  if (t > Date.now() + 60_000) throw new Error('Time is in the future.');

  return {
    id: `d_${t}_${Math.round(u * 100)}`,
    units: Math.round(u * 100) / 100,
    insulinType,
    concentration,
    category: context === DOSE_CONTEXT.BASAL ? 'basal' : 'bolus',
    context,
    takenAt: new Date(t).toISOString(),
    carbsGrams: Number.isFinite(Number(carbsGrams)) ? Number(carbsGrams) : null,
    mealId,
    note: String(note || '').slice(0, 280),
  };
}

export const MEDS_DISCLAIMER =
  'Label text is reproduced from the FDA and is not tailored to you. su94r ' +
  'records what you take and shows what the label says — it does not advise on ' +
  'dose, timing, or interactions. Those are questions for your prescriber.';
