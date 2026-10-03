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
const ES_ONES = { cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29 };
const ES_TENS = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };

/**
 * Spanish to the words parseLog reads: "cuatro unidades de rápida hace media hora" →
 * "4 units rapid 30 minutes ago", "comí cuarenta gramos" → "ate 40 grams".
 */
export function normalizeSpanish(text) {
  let t = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/\bmedia hora\b/g, '30 minutos').replace(/\buna hora\b/g, '1 hora').replace(/\bmedia unidad\b/g, '0.5 unidades');
  t = t.replace(/\b(cien|ciento)( y)?\b/g, '100 ');
  t = t.replace(new RegExp(`\\b(${Object.keys(ES_TENS).join('|')})(?: y (${Object.keys(ES_ONES).join('|')}))?\\b`, 'g'), (m, tens, one) => String(ES_TENS[tens] + (one ? ES_ONES[one] : 0)));
  t = t.replace(new RegExp(`\\b(${Object.keys(ES_ONES).join('|')})\\b`, 'g'), (m) => String(ES_ONES[m]));
  t = t.replace(/\s+/g, ' ').replace(/\b100 (\d{1,2})\b/g, (m, n) => String(100 + Number(n)));
  t = t.replace(/(\d+) y (medio|media)\b/g, (m, n) => `${n}.5`);
  t = t.replace(/\bhace (\d+) (?:horas?|h)\b(?: y (\d+) (?:minutos?|min)\b)?/g, (m, h, mi) => `${h} hours ${mi ? `${mi} minutes ` : ''}ago`)
    .replace(/\bhace (\d+) (?:minutos?|min)\b/g, '$1 minutes ago');
  t = t.replace(/\bunidades?\b/g, 'units').replace(/\bgramos?\b/g, 'grams').replace(/\b(carbohidratos?|carbos?)\b/g, 'carbs');
  // "2 unidades y media", "20 unidades de Lantus", "40 gramos de carbohidratos"
  t = t.replace(/(\d+) (units|grams) y (medio|media)\b/g, (m, n, u) => `${n}.5 ${u}`).replace(/\b(units|grams) de\b/g, '$1');
  t = t.replace(/\b(de )?(insulina )?(ultra ?rapida|rapida)\b/g, ' rapid')
    .replace(/\b(de )?(insulina )?((de )?accion prolongada|prolongada|lenta|basal)\b/g, ' basal')
    .replace(/\b(de )?(insulina )?premezclada\b/g, ' mix')
    .replace(/\b(de )?(insulina )?intermedia\b/g, ' nph');
  t = t.replace(/\b(me comi|comi|cene|almorce|desayune)\b/g, 'ate').replace(/\b(me puse|me inyecte|me tome|puse|tome|registra|anota|anotar)\b/g, ' ')
    .replace(/\b(de )?insulina\b/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** What a message asks to log, in English or Spanish (see parseLogEn). */
export function parseLog(text) {
  return parseLogEn(text) || parseLogEn(normalizeSpanish(text));
}

function parseLogEn(text) {
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
const KIND_ES = { rapid: 'rápida', short: 'regular', intermediate: 'NPH', basal: 'de acción prolongada', mix: 'premezclada' };
/** "4 unidades de insulina rápida", "40 g de carbohidratos". */
export function labelEs(kind, amount) {
  return kind === 'carbs' ? `${amount} g de carbohidratos` : `${amount} ${Number(amount) === 1 ? 'unidad' : 'unidades'} de insulina ${KIND_ES[kind] || kind}`;
}

export function describeLog(entry, now = Date.now(), lang = 'en') {
  if (lang === 'es') {
    const whenEs = entry.back ? `hace ${Math.round(entry.back / MIN)} min` : 'ahora';
    const r = describeLog(entry, now, 'en');
    if (!r.error) return { ...r, text: `¿Registrar ${entry.type === 'carbs' ? labelEs('carbs', Math.round(entry.grams)) : labelEs(entry.kind, entry.units)} ${whenEs}?` };
    if (entry.type === 'carbs') return { error: entry.back > 24 * 60 * MIN ? 'Puedo registrar comidas de las últimas 24 horas.' : `${entry.grams} g no es algo que pueda registrar (de 1 a ${MAX_GRAMS}).` };
    return { error: entry.back > 24 * 60 * MIN ? 'Puedo registrar dosis de las últimas 24 horas.' : `${entry.units} unidades es más de ${MAX_UNITS}. No se registró nada; revisa el número.` };
  }
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

export function describeMeal(m, lang = 'en') {
  if (lang === 'es') {
    if (!m) return { text: 'No pude leer esa foto. Escribe los gramos, por ejemplo: 40 g.' };
    if (!m.food) return { text: 'No veo comida en esa foto. Escribe los gramos, por ejemplo: 40 g.' };
    const conf = { low: 'baja', medium: 'media', high: 'alta' }[m.confidence] || m.confidence;
    const listEs = m.items.length ? `\n${m.items.map((x) => `• ${x.name}${x.carbs != null ? ` unos ${x.carbs} g` : ''}`).join('\n')}` : '';
    return { text: `Unos ${m.total} g de carbohidratos (probablemente ${m.low}–${m.high} g, confianza ${conf}).${listEs}\nLos estimados por foto son aproximados: revisa antes de registrar.`, total: m.total };
  }
  if (!m) return { text: 'I could not read that photo. Type the grams instead, for example: 40 g.' };
  if (!m.food) return { text: 'I do not see food in that photo. Type the grams instead, for example: 40 g.' };
  const list = m.items.length ? `\n${m.items.map((x) => `• ${x.name}${x.carbs != null ? ` about ${x.carbs} g` : ''}`).join('\n')}` : '';
  return {
    text: `About ${m.total} g of carbs (likely ${m.low}–${m.high} g, ${m.confidence} confidence).${list}\nPhoto estimates are rough: check before logging.`,
    total: m.total,
  };
}
