// Carb estimates from a meal photo: the instruction the vision model gets, and the check of its
// answer. Used by Telegram meal photos (telegram.js via tglog.js) and the phone app (su94r-proxy
// /app/meal). No imports, so the proxy Worker stays small.

const MAX_GRAMS = 300;

export const MEAL_PROMPT = 'You estimate carbohydrates in food photos for a person with diabetes. Look at the photo and answer '
  + 'with JSON only, no other text: {"food": true|false, "items": [{"name": "...", "carbs_g": number}], "total_g": number, '
  + '"low_g": number, "high_g": number, "confidence": "low"|"medium"|"high"}. Count only what is on the plate or in the '
  + 'hand, with typical portion sizes when unsure, and make the low–high range honest. If there is no food, answer {"food": false}. '
  + 'Never mention insulin or doses.';

/** The model's answer to a clean estimate, or null when it is not one. */
export function parseMealAnswer(text) {
  const s = String(text || '');
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j;
  try { j = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (j.food === false) return { food: false };
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const total = num(j.total_g);
  if (total == null || total < 0 || total > MAX_GRAMS) return null;
  const low = Math.max(0, Math.min(total, num(j.low_g) ?? Math.round(total * 0.75)));
  const high = Math.min(MAX_GRAMS, Math.max(total, num(j.high_g) ?? Math.round(total * 1.25)));
  const items = (Array.isArray(j.items) ? j.items : []).slice(0, 6)
    .map((x) => ({ name: String(x?.name || '').replace(/[^\p{L}\p{N} '\-,.()]/gu, '').slice(0, 40), carbs: num(x?.carbs_g) }))
    .filter((x) => x.name);
  const confidence = ['low', 'medium', 'high'].includes(j.confidence) ? j.confidence : 'low';
  return { food: true, total, low, high, items, confidence };
}
