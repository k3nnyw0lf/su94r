// Medicine lookup for logging what someone takes. Same sources and scope as
// su94r's src/lib/insulin/meds.js: RxNorm (NIH / NLM), free and keyless, so the
// person picks a real product (with strength and form) instead of free-typing.
// This records what was taken; it never advises on dose, timing or whether to
// take anything.

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';

export async function spellingSuggestions(query) {
  try {
    const res = await fetch(`${RXNAV}/spellingsuggestions.json?name=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    return (await res.json())?.suggestionGroup?.suggestionList?.suggestion || [];
  } catch {
    return [];
  }
}

/** Candidates for a name, dispensable products (with strength and form) first. */
export async function searchMedication(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { results: [], suggestions: [] };
  const res = await fetch(`${RXNAV}/drugs.json?name=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`The medicine database did not answer (${res.status}).`);
  const groups = (await res.json())?.drugGroup?.conceptGroup || [];
  const seen = new Set();
  const results = [];
  for (const g of groups) {
    for (const c of g.conceptProperties || []) {
      if (!c.rxcui || seen.has(c.rxcui)) continue;
      seen.add(c.rxcui);
      results.push({
        rxcui: c.rxcui,
        name: c.name,
        display: prettyName(c.synonym || c.name),
        isProduct: ['SBD', 'SCD', 'BPCK', 'GPCK'].includes(c.tty),
        ...parseStrength(c.name),
      });
    }
  }
  // Products first; then names that start with what was typed; single-ingredient before combinations.
  const ql = q.toLowerCase();
  const score = (r) => (r.isProduct ? 4 : 0)
    + (r.name.toLowerCase().startsWith(ql) || r.display.toLowerCase().startsWith(ql) ? 2 : 0)
    - (r.name.includes('/') ? 1 : 0);
  results.sort((a, b) => score(b) - score(a) || a.display.localeCompare(b.display, undefined, { numeric: true }));
  return {
    results: results.slice(0, 25),
    suggestions: results.length ? [] : await spellingSuggestions(q),
  };
}

/** "metformin hydrochloride 500 MG Oral Tablet [Glucophage]" → "Glucophage (metformin hydrochloride 500 mg oral tablet)". */
export function prettyName(name = '') {
  const brand = name.match(/\[([^\]]+)\]\s*$/)?.[1];
  const body = name.replace(/\s*\[[^\]]+\]\s*$/, '')
    .replace(/\b(MG|ML|UNT|MCG|GM|ACTUAT|HR)\b/g, (m) => m.toLowerCase())
    .replace(/\b(Oral|Tablet|Capsule|Injectable|Solution|Pen|Injector|Extended|Release|Delayed|Chewable|Topical|Inhalation|Powder|Suspension|Patch)\b/g, (m) => m.toLowerCase());
  return brand ? `${brand} (${body})` : body;
}

export function parseStrength(name = '') {
  const unt = name.match(/(\d+)\s*UNT\/ML/i);
  const form =
    /pen injector/i.test(name) ? 'pen'
    : /injectable solution|injection/i.test(name) ? 'vial'
    : /tablet/i.test(name) ? 'tablet'
    : /capsule/i.test(name) ? 'capsule'
    : /inhal/i.test(name) ? 'inhaler'
    : /patch|transdermal/i.test(name) ? 'patch'
    : null;
  return { concentration: unt ? `U-${unt[1]}` : null, form, isInsulin: /insulin/i.test(name) };
}

/** Sensible default unit to log a dose in, from the product form. */
export function defaultUnit(med) {
  if (med.isInsulin) return 'units';
  return { tablet: 'tablet', capsule: 'capsule', inhaler: 'puff', patch: 'patch' }[med.form] || 'dose';
}

/**
 * Insulin products logged from the medicine list are stored as insulin, so active
 * insulin and the double-dose guard include them. Category from the ingredient.
 */
export function insulinKindFromName(name = '') {
  const n = name.toLowerCase();
  // Pre-mixed: named as a mix, or two different insulins in one product (RxNorm lists 70/30
  // as "insulin isophane, human 70 UNT/ML / insulin regular, human 30 UNT/ML"). A pack of
  // one insulin in several strengths (Afrezza cartridges) is not a mix.
  const parts = new Set((n.match(/isophane|regular|lispro|aspart|glulisine|glargine|degludec|detemir|protamine/g) || []));
  if (/70\/30|75\/25|50\/50|mix|protamine/.test(n) || parts.size >= 2) return 'mix';
  if (/glargine|degludec|detemir|icodec|lantus|basaglar|toujeo|semglee|rezvoglar|abasaglar|tresiba|levemir|awiqli/.test(n)) return 'basal';
  if (/isophane|\bnph\b|humulin n\b|novolin n\b|insulatard|protaphane/.test(n)) return 'intermediate';
  if (/lispro|aspart|glulisine|humalog|admelog|lyumjev|novolog|novorapid|fiasp|apidra|afrezza/.test(n)) return 'rapid';
  if (/regular|human insulin|humulin r\b|novolin r\b|actrapid/.test(n)) return 'short';
  return 'rapid';
}

export const MED_UNITS = ['tablet', 'capsule', 'mg', 'mL', 'puff', 'drop', 'units', 'patch', 'dose'];
