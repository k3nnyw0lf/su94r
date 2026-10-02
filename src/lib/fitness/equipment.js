// ═══════════════════════════════════════════════════════════════════════════
// Equipment detection from photos.
//
// The program generator filters the catalog by equipment. Asking someone to
// tick boxes against 28 equipment names is a bad experience and they will get
// it wrong — "is my adjustable one a dumbbell or a barbell?" Photographing the
// corner of the room they train in is easier and more accurate.
//
// Runs on Gemini's free tier with a response schema, so the model returns
// validated JSON rather than prose we have to parse.
// ═══════════════════════════════════════════════════════════════════════════

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

/**
 * The exact `equipment` values used by the exercise catalog. The model must
 * answer in these terms or the result cannot filter anything — hence the enum
 * in the response schema rather than free text.
 */
export const EQUIPMENT_VOCAB = [
  'body weight', 'dumbbell', 'barbell', 'ez barbell', 'olympic barbell', 'trap bar',
  'kettlebell', 'band', 'resistance band', 'cable', 'leverage machine',
  'smith machine', 'stability ball', 'bosu ball', 'medicine ball', 'roller',
  'wheel roller', 'rope', 'weighted', 'sled machine', 'assisted', 'tire',
  'stationary bike', 'elliptical machine', 'stepmill machine', 'skierg machine',
  'upper body ergometer', 'hammer',
];

/** Equipment the catalog treats as a home setup, for the summary line. */
const HOME = new Set([
  'dumbbell', 'band', 'resistance band', 'kettlebell', 'stability ball',
  'medicine ball', 'roller', 'wheel roller', 'bosu ball', 'weighted',
]);

const PROMPT = `You are cataloguing home gym equipment from photographs.

List every distinct piece of exercise equipment you can identify. For each one:
- "equipment" MUST be chosen from the allowed list. Pick the closest match.
  Adjustable or fixed hand weights are "dumbbell". A straight bar with plates is
  "barbell". Loop or tube bands are "band". Foam rollers are "roller".
- "detail" is a short free-text note if you can read weights, quantities, or a
  brand from the image (e.g. "pair, 5-52 lb adjustable"). Empty string if not.
- "confidence" is 0.0-1.0 for how sure you are the item is present.

Rules:
- Only list what you can actually SEE. Do not infer a bench because there is a
  dumbbell, and do not guess at items that are partly out of frame.
- If an item appears in several photos, list it once.
- Do not include "body weight" — that is always available and is not equipment.
- If no exercise equipment is visible at all, return an empty array.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          equipment: { type: 'STRING', enum: EQUIPMENT_VOCAB },
          detail: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
        },
        required: ['equipment', 'confidence'],
      },
    },
  },
  required: ['items'],
};

/** Reads a File/Blob into the bare base64 the Gemini API expects. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve({ mimeType: file.type || 'image/jpeg', data: result.slice(comma + 1) });
    };
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(file);
  });
}

/**
 * Identifies equipment across one or more photos.
 *
 * @param {Array<{mimeType: string, data: string}>} images
 * @param {string} apiKey  Gemini API key from settings.
 * @param {object} [opts]
 * @param {number} [opts.minConfidence]  Discard weak guesses. Default 0.5.
 * @returns {Promise<{items: Array, equipment: string[]}>}
 */
export async function detectEquipment(images, apiKey, opts = {}) {
  const { minConfidence = 0.5 } = opts;
  if (!apiKey) throw new Error('Add a Gemini API key in Settings first — it is free.');
  if (!images?.length) throw new Error('No photos provided');

  const parts = [
    { text: PROMPT },
    ...images.map(img => ({ inline_data: { mime_type: img.mimeType, data: img.data } })),
  ];

  const res = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini rejected the request (${res.status}): ${detail.slice(0, 200)}`);
  }

  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no result. Try a clearer photo.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not read the equipment list from the response.');
  }

  // Deduplicate, keeping the highest-confidence sighting of each item.
  const best = new Map();
  for (const item of parsed.items || []) {
    if (!EQUIPMENT_VOCAB.includes(item.equipment)) continue;
    if ((item.confidence ?? 0) < minConfidence) continue;
    const existing = best.get(item.equipment);
    if (!existing || item.confidence > existing.confidence) best.set(item.equipment, item);
  }

  const items = [...best.values()].sort((a, b) => b.confidence - a.confidence);
  return { items, equipment: items.map(i => i.equipment) };
}

/**
 * Plain-language summary of what a detected inventory unlocks.
 * `catalog` is the loaded exercise index.
 */
export function inventorySummary(equipment, catalog) {
  // Bodyweight work is always on the table, whatever the photos showed.
  const owned = new Set([...equipment, 'body weight']);
  const usable = catalog.filter(ex => owned.has(ex.equipment) && !ex.advanced && !ex.needsApparatus);
  const home = equipment.filter(e => HOME.has(e));

  return {
    total: usable.length,
    deskRelevant: usable.filter(ex => ex.deskRelevant).length,
    homeItems: home.length,
    note: equipment.length
      ? `${usable.length} exercises match your kit, ${usable.filter(ex => ex.deskRelevant).length} of them targeted at desk-related weak points.`
      : 'No equipment detected — your plan will use bodyweight movements only, which is a perfectly good place to start.',
  };
}
