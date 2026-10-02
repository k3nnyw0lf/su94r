// ═══════════════════════════════════════════════════════════════════════════
// Meal photo → carbohydrate estimate.
//
// Carb counting is the largest daily cognitive burden in Type 1 diabetes, and
// the one most likely to be skipped when busy — which is exactly when a
// mis-estimate does damage.
//
// SCOPE, same hard line as everywhere else in this app:
//   Grams of carbohydrate only. Never an insulin dose, never a correction,
//   never a ratio. The number feeds the user's own judgement or their pump's
//   calculator; it does not replace either.
//
// Honesty rules, because a confidently wrong carb count is worse than no count:
//   • Every item carries its own confidence, and a total range — not a single
//     authoritative-looking figure.
//   • Portion size is the dominant error source in food photography, far more
//     than food identification. The prompt asks for a portion basis so the user
//     can see WHY it guessed 60g, and correct the assumption rather than the
//     result.
//   • High-fat and high-protein meals delay absorption. That is flagged, not
//     folded into the number, because it changes timing rather than quantity.
// ═══════════════════════════════════════════════════════════════════════════

import { fileToBase64 } from '../fitness/equipment.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

export { fileToBase64 };

const PROMPT = `You are estimating carbohydrate content from a photo of a meal, for a person with Type 1 diabetes who must count carbs.

For each distinct food item you can identify:
- name: short, plain (e.g. "white rice", "grilled chicken thigh")
- portionBasis: how you judged the amount, referencing visible cues (e.g. "about 1 cup, roughly fist-sized against the plate rim"). Be explicit — the user needs to check your assumption.
- carbsGrams: your best estimate for the portion SHOWN
- carbsLow / carbsHigh: a plausible range for that portion
- confidence: 0-1, how sure you are of BOTH the food and the portion

Also return:
- glycemicNote: one short sentence if this meal is likely to absorb unusually fast or slow (high fat, high protein, very refined carbs). Empty string if unremarkable.
- caveat: one short sentence naming the single biggest source of error in THIS photo (e.g. "the sauce may contain sugar", "depth of the bowl is hard to judge"). Never empty.

Rules:
- Judge only what is visible. Do not assume hidden ingredients beyond obvious ones.
- If the photo is too unclear to estimate, return an empty items array.
- Portion size is usually the biggest error. When unsure, widen the range rather than guessing precisely.
- Never mention insulin, dosing, or blood sugar targets.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          portionBasis: { type: 'string' },
          carbsGrams: { type: 'number' },
          carbsLow: { type: 'number' },
          carbsHigh: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['name', 'portionBasis', 'carbsGrams', 'carbsLow', 'carbsHigh', 'confidence'],
      },
    },
    glycemicNote: { type: 'string' },
    caveat: { type: 'string' },
  },
  required: ['items', 'caveat'],
};

/**
 * Estimates carbohydrate from one or more photos of a meal.
 *
 * @param {Array<{mimeType:string,data:string}>} images
 * @param {string} apiKey Gemini key from settings.
 * @returns {Promise<{items:Array,total:number,low:number,high:number,confidence:number,glycemicNote:string,caveat:string}>}
 */
export async function estimateMealCarbs(images, apiKey) {
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
    throw new Error('Could not read the response. Try again.');
  }

  return summarise(parsed);
}

/**
 * Folds the model output into totals. Pure, so it is testable without a network
 * call — which is where the arithmetic bugs would otherwise hide.
 */
export function summarise(parsed) {
  const items = (parsed?.items || [])
    .filter(i => i && typeof i.name === 'string' && Number.isFinite(Number(i.carbsGrams)))
    .map(i => {
      const g = Math.max(0, Number(i.carbsGrams));
      // Trust the model's own range, but never let it be narrower than its
      // stated confidence justifies — an unsure guess with a tight range is
      // the exact failure mode this module exists to avoid.
      const conf = Math.min(Math.max(Number(i.confidence) || 0, 0), 1);
      const minSpread = g * (1 - conf) * 0.6;
      return {
        name: i.name,
        portionBasis: i.portionBasis || '',
        carbsGrams: Math.round(g),
        carbsLow: Math.round(Math.min(Number(i.carbsLow) ?? g, g - minSpread, g)),
        carbsHigh: Math.round(Math.max(Number(i.carbsHigh) ?? g, g + minSpread, g)),
        confidence: conf,
      };
    })
    .map(i => ({ ...i, carbsLow: Math.max(0, i.carbsLow) }));

  const total = items.reduce((n, i) => n + i.carbsGrams, 0);
  const low = items.reduce((n, i) => n + i.carbsLow, 0);
  const high = items.reduce((n, i) => n + i.carbsHigh, 0);

  // Overall confidence is the WEAKEST link, not the average. One unidentifiable
  // item makes the whole plate uncertain.
  const confidence = items.length ? Math.min(...items.map(i => i.confidence)) : 0;

  return {
    items,
    total,
    low,
    high,
    confidence,
    glycemicNote: parsed?.glycemicNote || '',
    caveat: parsed?.caveat || 'Estimated from a photo — check against labels where you can.',
  };
}

/** Plain-language confidence banding for the UI. */
export function confidenceLabel(c) {
  if (c >= 0.75) return { label: 'Reasonably confident', tone: 'ok' };
  if (c >= 0.5) return { label: 'Rough estimate', tone: 'caution' };
  return { label: 'Low confidence — verify before relying on it', tone: 'warn' };
}

export const MEAL_DISCLAIMER =
  'A photo estimate of carbohydrate, not a measurement, and never an insulin dose. ' +
  'Portion size is the largest source of error. Check the portion assumption shown for ' +
  'each item and correct it rather than trusting the total.';
