// ═══════════════════════════════════════════════════════════════════════════
// Exercise catalog — search, filter, and lazy instruction loading.
//
// The index (~650KB) and the per-language step files are dynamically imported
// so none of this lands in the initial bundle. The Fitness tab is the only
// thing that pulls them in, and the service worker caches them after that.
// ═══════════════════════════════════════════════════════════════════════════

let indexPromise = null;
const stepsPromises = new Map();

/** Loads (once) the full exercise index. */
export function loadCatalog() {
  if (!indexPromise) {
    indexPromise = import('../../data/exercises.index.json').then(m => m.default);
  }
  return indexPromise;
}

/** Loads (once per language) the instruction steps, keyed by exercise id. */
export function loadSteps(lang = 'en') {
  const key = SUPPORTED_STEP_LANGS.includes(lang) ? lang : 'en';
  if (!stepsPromises.has(key)) {
    stepsPromises.set(
      key,
      import(`../../data/steps/${key}.json`)
        .then(m => m.default)
        // A missing translation should degrade to English, not break the page.
        .catch(() => (key === 'en' ? {} : loadSteps('en')))
    );
  }
  return stepsPromises.get(key);
}

export const SUPPORTED_STEP_LANGS = ['en', 'es', 'fr', 'zh', 'hi'];

// ─── Filtering ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} CatalogFilter
 * @property {string}   [query]        Free text over name, target, equipment.
 * @property {string[]} [bodyParts]
 * @property {string[]} [equipmentClass]  'none' | 'minimal' | 'gym' | 'other'
 * @property {string[]} [equipment]       Exact equipment names. Takes priority
 *                                        over equipmentClass when present —
 *                                        a scanned inventory is more precise
 *                                        than a coarse tier.
 * @property {string[]} [modality]        'resistance' | 'cardio' | 'mobility'
 * @property {boolean}  [deskRelevant]
 * @property {boolean}  [deskSnack]
 */

/** Applies a filter to an already-loaded index. Pure — easy to test. */
export function filterExercises(index, filter = {}) {
  const { query, bodyParts, equipment, equipmentClass, modality, deskRelevant, deskSnack } = filter;
  const q = query?.trim().toLowerCase();

  return index.filter(ex => {
    if (deskRelevant && !ex.deskRelevant) return false;
    if (deskSnack && !ex.deskSnack) return false;
    if (bodyParts?.length && !bodyParts.includes(ex.bodyPart)) return false;
    // An exact inventory beats a tier, so it wins when both are supplied.
    if (equipment?.length) {
      if (!equipment.includes(ex.equipment)) return false;
    } else if (equipmentClass?.length && !equipmentClass.includes(ex.equipmentClass)) {
      return false;
    }
    if (modality?.length && !modality.includes(ex.modality)) return false;
    if (q) {
      const haystack = `${ex.name} ${ex.target} ${ex.equipment} ${ex.muscleGroup}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Distinct values for building filter chips, derived rather than hardcoded. */
export function facets(index) {
  const uniq = key => [...new Set(index.map(e => e[key]))].filter(Boolean).sort();
  return {
    bodyParts: uniq('bodyPart'),
    equipment: uniq('equipment'),
    equipmentClasses: uniq('equipmentClass'),
    modalities: uniq('modality'),
  };
}

export function findById(index, id) {
  return index.find(e => e.id === id) || null;
}

// ─── Presentation helpers ───────────────────────────────────────────────────

export const EQUIPMENT_CLASS_LABEL = {
  none: 'No equipment',
  minimal: 'Home kit',
  gym: 'Gym required',
  other: 'Other',
};

export const MODALITY_LABEL = {
  resistance: 'Resistance',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

/**
 * How this exercise class typically moves glucose. Copy is deliberately
 * hedged — it describes a tendency, not a prediction for a given person.
 * Once the correlation engine has enough of the user's own sessions, the
 * Fitness UI shows their measured response instead of this.
 */
export const GLUCOSE_TENDENCY_NOTE = {
  lowers: 'Steady cardio usually pulls glucose down during the session.',
  'raises-then-lowers':
    'Hard resistance work often nudges glucose up during the set, then increases insulin sensitivity for hours afterward.',
  neutral: 'Mobility work usually has little immediate effect on glucose.',
};
