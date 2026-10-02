// The Telegram logbook (used by telegram.js): "4 units rapid", "20 Lantus 30 min ago", "40 g",
// or a photo of the plate. Nothing is logged until "Log it" is tapped, the same rule as Alexa,
// and nothing here ever suggests an amount of insulin.

import { slotKind, spokenKind as spokenForVoice, unitWord, MAX_UNITS } from './alexa.js';

const spokenKind = (kind) => spokenForVoice(kind).replace('N P H', 'NPH');

export const MAX_GRAMS = 300;
const MIN = 60e3;

/** "30 min ago", "1h ago", "1 hour 15 minutes ago" → milliseconds (null when none). */
export function agoMs(text) {
  const m = /(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?\s+ago\b/i.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  return ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * MIN;
}

/**
 * What a message asks to log: { type: 'insulin', units, kind, back } or { type: 'carbs', grams,
 * back } or null. Grams need g / grams / carbs; insulin needs a kind word (rapid, R, Lantus…).
 */
export function parseLog(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '.').trim();
  if (!t || t.startsWith('/')) return null;
  const back = agoMs(t);
  const carbs = /(\d+(?:\.\d+)?)\s*(?:g\b|grams?\b|gr\b|carbs?\b|carbohydrates?\b)/.exec(t) || /\b(?:ate|eating|had)\s+(\d+(?:\.\d+)?)\b/.exec(t);
  if (carbs && !/\b(units?|u)\b/.test(t)) return { type: 'carbs', grams: Number(carbs[1]), back };
  const ins = /(\d+(?:\.\d+)?)\s*(?:u\b|units?\b|iu\b)?\s*(?:of\s+)?([a-z][a-z0-9 ]{0,24}?)(?:\s+insulin)?(?:\s+\d.*ago.*)?$/.exec(t.replace(/\b(i\s+)?(took|take|log|add|just)\b/g, '').replace(/\s+ago\b.*$/, '').trim());
  if (ins) {
    const kind = slotKind({ value: ins[2].trim() });
    if (kind) return { type: 'insulin', units: Number(ins[1]), kind, back };
  }
  return null;
}

/** The question shown before logging, or a refusal. */
export function describeLog(entry, now = Date.now()) {
  const when = entry.back ? `${Math.round(entry.back / MIN)} min ago` : 'now';
  if (entry.type === 'carbs') {
    if (!(entry.grams > 0) || entry.grams > MAX_GRAMS) return { error: `${entry.grams} g is not something I can log (1 to ${MAX_GRAMS}).` };
    if (entry.back > 24 * 60 * MIN) return { error: 'I can log meals from the last 24 hours.' };
    return { text: `Log ${Math.round(entry.grams)} g of carbs ${when}?`, data: `log:c:${Math.round(entry.grams)}:${Math.round((now - (entry.back || 0)) / MIN)}` };
  }
  if (!(entry.units > 0) || entry.units > MAX_UNITS) return { error: `${entry.units} units is more than ${MAX_UNITS}. Nothing was logged; check the number.` };
  if (entry.back > 24 * 60 * MIN) return { error: 'I can log doses from the last 24 hours.' };
  return { text: `Log ${unitWord(entry.units)} of ${spokenKind(entry.kind)} insulin ${when}?`, data: `log:i:${entry.units}:${entry.kind}:${Math.round((now - (entry.back || 0)) / MIN)}` };
}

/** A "Log it" button's data back to an entry, checked again (it travels through Telegram). */
export function entryFromData(data, now = Date.now()) {
  const c = /^log:c:(\d{1,3}):(\d{6,9})$/.exec(data);
  if (c) {
    const grams = Number(c[1]); const t = Number(c[2]) * MIN;
    if (grams > 0 && grams <= MAX_GRAMS && now - t <= 25 * 60 * MIN && t <= now + 10 * MIN) return { kind: 'carbs', amount: grams, t, label: `${grams} g of carbs` };
    return null;
  }
  const i = /^log:i:(\d{1,3}(?:\.\d{1,2})?):(rapid|short|intermediate|basal|mix):(\d{6,9})$/.exec(data);
  if (i) {
    const units = Number(i[1]); const t = Number(i[3]) * MIN;
    if (units > 0 && units <= MAX_UNITS && now - t <= 25 * 60 * MIN && t <= now + 10 * MIN) return { kind: i[2], amount: units, t, label: `${unitWord(units)} of ${spokenKind(i[2])} insulin` };
  }
  return null;
}

// ---- meal photos ----

export { MEAL_PROMPT, parseMealAnswer } from './meal.js';

export function describeMeal(m) {
  if (!m) return { text: 'I could not read that photo. Type the grams instead, for example: 40 g.' };
  if (!m.food) return { text: 'I do not see food in that photo. Type the grams instead, for example: 40 g.' };
  const list = m.items.length ? `\n${m.items.map((x) => `• ${x.name}${x.carbs != null ? ` about ${x.carbs} g` : ''}`).join('\n')}` : '';
  return {
    text: `About ${m.total} g of carbs (likely ${m.low}–${m.high} g, ${m.confidence} confidence).${list}\nPhoto estimates are rough: check before logging.`,
    total: m.total,
  };
}
