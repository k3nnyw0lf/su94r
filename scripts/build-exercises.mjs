#!/usr/bin/env node
/**
 * Builds su94r's exercise catalog from the upstream exercises-dataset.
 *
 * Upstream is ~17MB because it carries instructions in 10 languages. We split it:
 *   src/data/exercises.index.json   — searchable metadata, no prose. Ships in the bundle.
 *   src/data/steps/<lang>.json      — instruction steps, lazy-loaded per language.
 *
 * Media (thumbnails + GIFs) is © Gym Visual and is NOT vendored. We reference the
 * upstream raw URLs so we never redistribute it.
 *
 * Usage: node scripts/build-exercises.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'data');
const UPSTREAM = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main';
const SOURCE = `${UPSTREAM}/data/exercises.json`;

/** Languages su94r's i18n supports that upstream also provides. */
const LANGS = ['en', 'es', 'fr', 'zh', 'hi'];

// ─── Classification vocabularies ────────────────────────────────────────────

/** Equipment you need a commercial gym for. */
const GYM_EQUIPMENT = new Set([
  'barbell', 'cable', 'leverage machine', 'smith machine', 'ez barbell',
  'olympic barbell', 'sled machine', 'assisted', 'trap bar', 'hammer', 'tire',
  'skierg machine', 'stationary bike', 'elliptical machine', 'stepmill machine',
  'upper body ergometer',
]);

/**
 * Equipment that realistically fits in a spare room or under a desk.
 * 'rope' is deliberately absent — upstream uses it for climbing and battle
 * ropes, neither of which belongs in a beginner home session.
 */
const HOME_EQUIPMENT = new Set([
  'dumbbell', 'band', 'resistance band', 'kettlebell', 'stability ball',
  'medicine ball', 'roller', 'wheel roller', 'bosu ball', 'weighted',
]);

/** Cardio machines — aerobic regardless of what body_part says. */
const CARDIO_EQUIPMENT = new Set([
  'stationary bike', 'elliptical machine', 'stepmill machine',
  'skierg machine', 'upper body ergometer',
]);

/**
 * Upstream tags these "body weight", but they need a bar, rings, rope, bench or
 * similar. Without this the generator cheerfully prescribes a chin-up as
 * something to do beside your desk.
 */
// Hyphen OR space — upstream writes both "pull-up" and "pull up", and missing
// the spaced form is how a chin-up ends up prescribed as a desk-side snack.
const APPARATUS_RE = /\bbar\b|barbell|pull[-\s]?up|chin[-\s]?up|muscle[-\s]?up|\bdip\b|inverted row|rope|ring|parallel|bench|box|step[-\s]?up|suspend|trx|wall|sled|tire|\brack\b|smith|cable|machine/i;

/**
 * Advanced calisthenics. Real exercises, wrong audience — someone starting from
 * a desk job should never be handed a back lever or a planche.
 */
const ADVANCED_RE = /muscle[-\s]?up|lever|planche|handstand|human flag|iron cross|one arm (pull|chin|push)|pistol|\bsalto\b|\bflag\b|maltese|victorian|superman push|side push[-\s]?up|(one|single) leg squat|rope climb|clap push/i;

const MOBILITY_RE = /stretch|mobility|foam roll|roller|rotation|circle/i;
const CARDIO_NAME_RE = /\brun\b|jog|cycl|jump rope|skipping|burpee|mountain climber|jumping jack|\bsprint\b|treadmill|stair|row(ing)? machine/i;

/**
 * Muscles that a desk job specifically degrades: hip flexors shorten from
 * sitting, glutes and posterior chain go quiet, the thoracic spine rounds,
 * and the neck carries the head forward.
 */
const DESK_MUSCLES = new Set([
  'glutes', 'hip flexors', 'hamstrings', 'lower back', 'upper back',
  'rhomboids', 'trapezius', 'traps', 'rotator cuff', 'core', 'abdominals',
  'obliques', 'latissimus dorsi', 'lats', 'quadriceps',
]);

const DESK_BODY_PARTS = new Set(['back', 'waist', 'shoulders', 'neck', 'upper legs']);

// ─── Classifiers ────────────────────────────────────────────────────────────

function equipmentClass(equipment) {
  if (equipment === 'body weight') return 'none';
  if (HOME_EQUIPMENT.has(equipment)) return 'minimal';
  if (GYM_EQUIPMENT.has(equipment)) return 'gym';
  return 'other';
}

function modality(ex) {
  if (ex.body_part === 'cardio') return 'cardio';
  if (CARDIO_EQUIPMENT.has(ex.equipment)) return 'cardio';
  if (CARDIO_NAME_RE.test(ex.name)) return 'cardio';
  if (MOBILITY_RE.test(ex.name)) return 'mobility';
  return 'resistance';
}

/**
 * Expected direction of blood glucose during and after the activity.
 *
 * This encodes the single most important thing an exercising T1D needs to know:
 * steady aerobic work tends to pull glucose DOWN during the session, while
 * hard resistance and interval work drives catecholamines that can push it UP
 * acutely — then raises insulin sensitivity for hours afterward, which is where
 * the delayed and overnight hypo risk comes from.
 *
 * These are population-level tendencies used to set expectations and prompts.
 * The correlation engine overrides them with the user's own measured response
 * as soon as enough sessions are logged.
 */
function glucoseTendency(mode) {
  if (mode === 'cardio') return 'lowers';
  if (mode === 'resistance') return 'raises-then-lowers';
  return 'neutral';
}

function isDeskRelevant(ex) {
  if (DESK_MUSCLES.has(ex.muscle_group)) return true;
  if (DESK_MUSCLES.has(ex.target)) return true;
  if ((ex.secondary_muscles || []).some(m => DESK_MUSCLES.has(m))) return true;
  return DESK_BODY_PARTS.has(ex.body_part);
}

/** Can you do it beside your desk, in work clothes, without kit? */
function isDeskSnack(ex, eqClass, mode) {
  if (eqClass !== 'none') return false;
  if (APPARATUS_RE.test(ex.name)) return false;
  if (ADVANCED_RE.test(ex.name)) return false;
  if (mode === 'resistance' && !isDeskRelevant(ex)) return false;
  // Anything requiring lying on the floor is a hard sell mid-workday.
  if (/lying|supine|prone|floor|kneeling|sit-up|situp|crunch|bridge|plank/i.test(ex.name)) return false;
  return true;
}

// ─── Build ──────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write(`Fetching ${SOURCE} ...\n`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('Expected upstream to be a JSON array');
  process.stdout.write(`Loaded ${raw.length} exercises\n`);

  const index = [];
  const steps = Object.fromEntries(LANGS.map(l => [l, {}]));

  for (const ex of raw) {
    const eqClass = equipmentClass(ex.equipment);
    const mode = modality(ex);

    index.push({
      id: ex.id,
      name: ex.name,
      bodyPart: ex.body_part,
      equipment: ex.equipment,
      equipmentClass: eqClass,
      target: ex.target,
      muscleGroup: ex.muscle_group,
      secondary: ex.secondary_muscles || [],
      modality: mode,
      glucoseTendency: glucoseTendency(mode),
      needsApparatus: APPARATUS_RE.test(ex.name),
      advanced: ADVANCED_RE.test(ex.name),
      deskRelevant: isDeskRelevant(ex),
      deskSnack: isDeskSnack(ex, eqClass, mode),
      gif: `${UPSTREAM}/${ex.gif_url}`,
      image: `${UPSTREAM}/${ex.image}`,
    });

    for (const lang of LANGS) {
      const s = ex.instruction_steps?.[lang];
      if (Array.isArray(s) && s.length) steps[lang][ex.id] = s;
      else if (ex.instructions?.[lang]) steps[lang][ex.id] = [ex.instructions[lang]];
    }
  }

  await mkdir(join(OUT_DIR, 'steps'), { recursive: true });

  const indexPath = join(OUT_DIR, 'exercises.index.json');
  await writeFile(indexPath, JSON.stringify(index));
  process.stdout.write(`  index        ${(JSON.stringify(index).length / 1024).toFixed(0)} KB → ${indexPath}\n`);

  for (const lang of LANGS) {
    const p = join(OUT_DIR, 'steps', `${lang}.json`);
    const body = JSON.stringify(steps[lang]);
    await writeFile(p, body);
    process.stdout.write(`  steps.${lang}     ${(body.length / 1024).toFixed(0)} KB → ${p}\n`);
  }

  // Summary so regressions in the classifiers are visible at build time.
  const count = pred => index.filter(pred).length;
  process.stdout.write('\nCatalog composition:\n');
  process.stdout.write(`  desk-relevant : ${count(e => e.deskRelevant)}\n`);
  process.stdout.write(`  desk snacks   : ${count(e => e.deskSnack)}\n`);
  process.stdout.write(`  needs apparatus: ${count(e => e.needsApparatus)}\n`);
  process.stdout.write(`  advanced      : ${count(e => e.advanced)}\n`);
  process.stdout.write(`  no equipment  : ${count(e => e.equipmentClass === 'none')}\n`);
  process.stdout.write(`  home kit only : ${count(e => e.equipmentClass === 'minimal')}\n`);
  process.stdout.write(`  cardio        : ${count(e => e.modality === 'cardio')}\n`);
  process.stdout.write(`  resistance    : ${count(e => e.modality === 'resistance')}\n`);
  process.stdout.write(`  mobility      : ${count(e => e.modality === 'mobility')}\n`);
}

main().catch(err => {
  process.stderr.write(`build-exercises failed: ${err.message}\n`);
  process.exit(1);
});
