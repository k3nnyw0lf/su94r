// Alexa skill endpoint.
//   "Alexa, ask my sugar how I'm doing."            latest reading, trend and age
//   "Alexa, tell my sugar 4 units of R insulin now."  logs a dose after you confirm it
//   "Alexa, ask my sugar when I last took insulin."   the last doses, from every device
//   In Spanish on a Spanish-speaking Echo: "Alexa, pregunta a mi azúcar cómo estoy"
//   (interaction-model.es-US.json); every answer below has its Spanish words.
//
// Logging writes data, so every request must carry Amazon's signature (alexa-verify.js),
// match ALEXA_SKILL_ID and be under 150 seconds old. Doses are kept in the dose store
// (doses.js), shared with su94r Mini, and checked with the same double-dose rule.
// Alexa only records what you say you took; it never suggests an amount.

import { verifyAlexaSignature, AlexaVerifyError } from './alexa-verify.js';
import { doubleDoseWarning, kindWord } from '../extension/insulin.js';
import { asMarkers } from './doses.js';
import { speakForecast } from './forecast.js';
import { nightSummary, weekLine } from './history.js';
import { findPatterns } from '../extension/patterns.js';

const MMOL = 18.0182;
export const MAX_UNITS = 100;
const STALE_MS = 10 * 60e3;
const TREND_WORDS = { 1: 'falling fast', 2: 'falling', 3: 'steady', 4: 'rising', 5: 'rising fast' };
const TREND_ES = { 1: 'bajando rápido', 2: 'bajando', 3: 'estable', 4: 'subiendo', 5: 'subiendo rápido' };
const KIND_ES = { short: 'regular', rapid: 'rápida', basal: 'de acción prolongada', intermediate: 'N P H', mix: 'premezclada' };
const unidades = (n) => `${n} ${Number(n) === 1 ? 'unidad' : 'unidades'}`;
const gramos = (n) => `${n} ${Number(n) === 1 ? 'gramo' : 'gramos'}`;
function valorEs(mg, units) {
  if (mg < 40) return 'menos de 40';
  if (mg > 400) return 'más de 400';
  return units === 'mmol/L' ? `${(mg / MMOL).toFixed(1)} milimoles por litro` : `${Math.round(mg)} miligramos por decilitro`;
}
function haceEs(t, now = Date.now()) {
  const m = Math.max(0, Math.round((now - t) / 60e3));
  if (m < 1) return 'ahora mismo';
  if (m === 1) return 'hace un minuto';
  if (m < 60) return `hace ${m} minutos`;
  const h = Math.floor(m / 60);
  return `hace ${h} ${h === 1 ? 'hora' : 'horas'}${m % 60 ? ` y ${m % 60} minutos` : ''}`;
}
// The Spanish double-dose warning ("Ya registraste 4 u de insulina rápida hace 45 min") read aloud.
const speakEs = (text) => String(text)
  .replace(/(\d+(?:\.\d+)?) u\b/g, (_, n) => unidades(n))
  .replace(/(\d+) h (\d+) min/g, '$1 horas y $2 minutos')
  .replace(/(\d+) min\b/g, '$1 minutos')
  .replace(/\bNPH\b/g, 'N P H')
  .replace(/[()]/g, ', ');

const reply = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function spokenValue(mg, units) {
  if (mg < 40) return 'below 40';
  if (mg > 400) return 'above 400';
  return units === 'mmol/L' ? `${(mg / MMOL).toFixed(1)} millimoles per liter` : `${Math.round(mg)} milligrams per deciliter`;
}

function shownValue(mg, units) {
  if (mg < 40) return 'LO';
  if (mg > 400) return 'HI';
  return units === 'mmol/L' ? (mg / MMOL).toFixed(1) : String(Math.round(mg));
}

function minutesAgo(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60e3));
  if (m === 0) return 'just now';
  if (m === 1) return 'a minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ${m % 60} minutes ago`;
}

export function describePerson(p, { many, now = Date.now(), lang = 'en' } = {}) {
  const who = many ? p.firstName || p.name : null;
  const l = p.latest;
  if (lang === 'es') {
    if (!l) return `${who ? `${who} no tiene` : 'No hay'} lecturas todavía.`;
    if (now - l.t > STALE_MS) return `${who ? `${who}: sin` : 'Sin'} lecturas nuevas ${haceEs(l.t, now).replace('hace ', 'desde hace ')}. La última fue ${valorEs(l.mg, p.units)}.`;
    const st = l.mg < 55 ? 'baja urgente' : l.mg < p.low ? 'baja' : l.mg > p.high ? 'alta' : null;
    const tr = TREND_ES[l.trend];
    const leadEs = st ? `Atención. ${who ? `${who} tiene la glucosa` : 'Tienes la glucosa'} ${st}:` : `${who ? `${who} está` : 'Estás'} en`;
    return `${leadEs} ${valorEs(l.mg, p.units)}${tr ? ` y ${tr}` : ''}, ${haceEs(l.t, now)}.`;
  }
  if (!l) return `${who ? `${who} has` : 'There is'} no reading yet.`;
  const stale = now - l.t > STALE_MS;
  if (stale) {
    return `${who ? `${who}: no` : 'No'} new reading for ${minutesAgo(l.t).replace(' ago', '')}. The last one was ${spokenValue(l.mg, p.units)}.`;
  }
  const status = l.mg < 55 ? 'urgent low' : l.mg < p.low ? 'low' : l.mg > p.high ? 'high' : null;
  const trend = TREND_WORDS[l.trend];
  const lead = status ? `Warning. ${who ? `${who} is` : 'You are'} ${status} at` : `${who ? `${who} is` : 'You are'} at`;
  return `${lead} ${spokenValue(l.mg, p.units)}${trend ? ` and ${trend}` : ''}, ${minutesAgo(l.t)}.`;
}

/** The last 3 hours as an APL vector graphic: the target band and the line (800 × 200). */
export function sparkGraphic(p, now = Date.now()) {
  const pts = (p.history || []).filter((q) => q.t >= now - 3 * 3600e3).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const W = 800, H = 200, lo = 40, hi = Math.max(300, ...pts.map((q) => q.mg));
  const x = (t) => ((t - (now - 3 * 3600e3)) / (3 * 3600e3)) * W;
  const y = (v) => H - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * H;
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${x(q.t).toFixed(0)},${y(q.mg).toFixed(0)}`).join(' ');
  const band = `M0,${y(p.high).toFixed(0)} L${W},${y(p.high).toFixed(0)} L${W},${y(p.low).toFixed(0)} L0,${y(p.low).toFixed(0)} Z`;
  return {
    type: 'AVG', version: '1.2', width: W, height: H,
    items: [
      { type: 'path', pathData: band, fill: '#3fb95026' },
      { type: 'path', pathData: line, stroke: '#f2f5f8', strokeWidth: 6, fill: 'transparent', strokeLineCap: 'round', strokeLineJoin: 'round' },
    ],
  };
}

function aplDirective(people, lang = 'en') {
  const es = lang === 'es';
  const p = people[0];
  const l = p.latest;
  const color = !l || Date.now() - l.t > STALE_MS ? '#8b949e' : l.mg < p.low ? '#ff5d55' : l.mg > p.high ? '#e3a33b' : '#3fb950';
  const spark = sparkGraphic(p);
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: 'glucose',
    document: {
      type: 'APL',
      version: '2023.3',
      ...(spark ? { graphics: { spark } } : {}),
      mainTemplate: {
        items: [{
          type: 'Container',
          width: '100vw',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          items: [
            { type: 'Text', text: people.length > 1 ? p.name : es ? 'Glucosa' : 'Glucose', fontSize: '36dp', color: '#8b949e' },
            { type: 'Text', text: l ? shownValue(l.mg, p.units) : '—', fontSize: '200dp', fontWeight: 'bold', color },
            { type: 'Text', text: l ? `${p.units} · ${(es ? TREND_ES : TREND_WORDS)[l.trend] || ''} · ${es ? haceEs(l.t) : minutesAgo(l.t)}` : '', fontSize: '32dp', color: '#f2f5f8' },
            ...(spark ? [{ type: 'VectorGraphic', source: 'spark', width: '80vw', height: '22vh', scale: 'fill', paddingTop: '16dp' }] : []),
            ...(people.length > 1 ? [{
              type: 'Text',
              text: people.slice(1).map((q) => `${q.firstName || q.name} ${q.latest ? shownValue(q.latest.mg, q.units) : '—'}`).join('   ·   '),
              fontSize: '28dp', color: '#8b949e', paddingTop: '24dp',
            }] : []),
          ],
        }],
      },
    },
  };
}

export async function handleAlexa(request, env, getSnapshot, { store = null, verify, forecasts = null, history = null } = {}) {
  if (!env.ALEXA_SKILL_ID) return new Response('ALEXA_SKILL_ID is not set', { status: 503 });
  const raw = await request.text();
  try {
    await (verify || verifyAlexaSignature)(request.headers, raw);
  } catch (e) {
    return new Response(e instanceof AlexaVerifyError ? `signature: ${e.message}` : 'signature check failed', { status: 401 });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const appId = body?.context?.System?.application?.applicationId || body?.session?.application?.applicationId;
  if (appId !== env.ALEXA_SKILL_ID) return new Response('unknown skill', { status: 403 });
  const sent = Date.parse(body?.request?.timestamp || '');
  if (!Number.isFinite(sent) || Math.abs(Date.now() - sent) > 150e3) return new Response('stale request', { status: 400 });

  const type = body.request.type;
  const intent = body.request.intent?.name;
  const lang = /^es/i.test(body.request.locale || '') ? 'es' : 'en';
  const T = (en, es) => (lang === 'es' ? es : en);
  const say = (text, { end = true, apl = null } = {}) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: { type: 'Simple', title: T('Glucose', 'Glucosa'), content: text },
      shouldEndSession: end,
      ...(apl ? { directives: [apl] } : {}),
    },
  });

  if (type === 'SessionEndedRequest') return reply({ version: '1.0', response: {} });
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return say(T('Okay.', 'De acuerdo.'));
  if (intent === 'AMAZON.HelpIntent') {
    return say(T('Ask me how your sugar is, how your night was, or where you are heading. Log a dose: say, 4 units of R insulin. Log a meal: say, I ate 40 grams. You can also ask when you last took insulin.',
      'Pregúntame cómo está tu azúcar, cómo fue tu noche o hacia dónde vas. Para registrar una dosis di: 4 unidades de insulina rápida. Para registrar una comida di: comí 40 gramos. También puedes preguntar cuándo te pusiste insulina por última vez.'), { end: false });
  }
  if (intent === 'LogInsulinIntent' || intent === 'LastInsulinIntent') {
    return insulinIntent(body, { say, reply, store, getSnapshot, lang });
  }
  if (intent === 'LogCarbsIntent') return carbsIntent(body, { say, reply, store, getSnapshot, lang });
  if (intent === 'ForecastIntent') return forecastIntent(body, { say, getSnapshot, store, forecasts, lang });
  if (intent === 'NightIntent' || intent === 'WeekIntent') return pastIntent(body, intent, { say, getSnapshot, store, history, lang });
  if (intent === 'PatternIntent') return patternIntent(body, { say, getSnapshot, store, history, lang });

  let snap;
  try {
    snap = await getSnapshot();
  } catch (e) {
    return say(e.code === 'config'
      ? T('Your sugar server is not connected yet. On your computer, open su94r Mini settings and press Connect to my su94r server.', 'Tu servidor de azúcar todavía no está conectado. En tu computadora abre la configuración de su94r Mini y pulsa Connect to my su94r server.')
      : T('I could not reach LibreLinkUp just now. Please check your Libre app.', 'No pude conectar con LibreLinkUp ahora. Revisa tu app de Libre.'));
  }

  let people = snap.people;
  const asked = body.request.intent?.slots?.name?.value?.toLowerCase();
  if (asked) {
    const match = people.filter((p) => (p.firstName || p.name).toLowerCase().startsWith(asked) || p.name.toLowerCase().includes(asked));
    if (!match.length) return say(T(`I don't follow anyone called ${asked}.`, `No sigo a nadie llamado ${asked}.`));
    people = match;
  }
  if (!people.length) return say(T('No one is sharing their glucose with this account yet.', 'Nadie está compartiendo su glucosa con esta cuenta todavía.'));

  const many = people.length > 1;
  const text = people.map((p) => describePerson(p, { many, lang })).join(' ');
  const hasScreen = Boolean(body?.context?.System?.device?.supportedInterfaces?.['Alexa.Presentation.APL']);
  return say(text, { apl: hasScreen ? aplDirective(people, lang) : null });
}

// ---------- logging and recalling insulin by voice ----------

const KIND_WORDS = {
  rapid: /^(rapid|fast|quick|humalog|novolog|novorapid|fiasp|lyumjev|admelog|apidra|lispro|aspart)/,
  short: /^(r|are|our|regular|humulin r|novolin r|actrapid)$/,
  basal: /^(long|basal|lantus|basaglar|toujeo|tresiba|levemir|semglee|glargine|degludec)/,
  intermediate: /^(n|nph|n p h|humulin n|novolin n|intermediate)$/,
  mix: /^(mix|mixed|premix|pre mixed|70 30|seventy thirty|humalog mix|novolog mix)/,
};

export function slotKind(slot) {
  const id = slot?.resolutions?.resolutionsPerAuthority?.find((a) => a.status?.code === 'ER_SUCCESS_MATCH')?.values?.[0]?.value?.id;
  if (id && KIND_WORDS[id]) return id;
  const v = String(slot?.value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/ insulin$/, '');
  return Object.keys(KIND_WORDS).find((k) => KIND_WORDS[k].test(v)) || null;
}

/** ISO 8601 duration as Alexa sends it ("PT30M", "PT1H30M") in milliseconds. */
export function durationMs(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x || 0));
  return ((d * 24 + h) * 60 + mi) * 60e3 + s * 1e3;
}

export const unitWord = (n) => `${n} unit${Number(n) === 1 ? '' : 's'}`;
export const spokenKind = (kind) => ({ short: 'regular', rapid: 'rapid', basal: 'long-acting', intermediate: 'N P H', mix: 'pre-mixed' }[kind] || kindWord(kind));
// The extension's wording ("4 u rapid 45 min ago (3.4 u still active)") read aloud.
const speak = (text) => String(text)
  .replace(/(\d+(?:\.\d+)?) u\b/g, (_, n) => unitWord(n))
  .replace(/(\d+) h (\d+) min/g, '$1 hours $2 minutes')
  .replace(/(\d+) min\b/g, '$1 minutes')
  .replace(/\bNPH\b/g, 'N P H')
  .replace(/[()]/g, ', ');

function ago(t, now) {
  const m = Math.max(0, Math.round((now - t) / 60e3));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} minutes` : ''} ago`;
}

async function whoFor(body, getSnapshot, store) {
  const asked = body.request.intent?.slots?.name?.value?.toLowerCase();
  let people = [];
  try { people = (await getSnapshot()).people || []; } catch { /* LibreLinkUp down: fall back below */ }
  if (asked) {
    const match = people.find((p) => (p.firstName || p.name || '').toLowerCase().startsWith(asked));
    return match ? { pid: match.pid, name: match.firstName || match.name, many: people.length > 1 } : { missing: asked };
  }
  if (people.length) return { pid: people[0].pid, name: people[0].firstName || people[0].name, many: people.length > 1 };
  const last = (await store.recent(null))[0];
  return last ? { pid: last.pid, name: null, many: false } : { none: true };
}

async function insulinIntent(body, { say, reply, store, getSnapshot, lang = 'en' }) {
  const es = lang === 'es';
  const T = (en, sp) => (es ? sp : en);
  const card = (text, end = true, directives = null) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: { type: 'Simple', title: T('Insulin', 'Insulina'), content: text },
      shouldEndSession: end,
      ...(directives ? { directives } : {}),
    },
  });
  if (!store?.ready) return say(T('Logging insulin by voice is not set up on the server yet.', 'Registrar insulina por voz todavía no está configurado en el servidor.'));
  const now = Date.now();
  const intent = body.request.intent;
  const who = await whoFor(body, getSnapshot, store);
  if (who.missing) return say(T(`I don't follow anyone called ${who.missing}.`, `No sigo a nadie llamado ${who.missing}.`));
  if (who.none) return say(T('No one is sharing their glucose with this account yet, so I do not know whose insulin to log.', 'Nadie está compartiendo su glucosa con esta cuenta todavía, así que no sé de quién registrar la insulina.'));
  const forWhom = who.many && who.name ? T(` for ${who.name}`, ` para ${who.name}`) : '';

  let doses;
  try { doses = asMarkers(await store.recent(who.pid, now)); } catch { return say(T('I could not reach the dose log just now. Nothing was logged.', 'No pude abrir el registro de dosis ahora. No se registró nada.')); }

  if (intent.name === 'LastInsulinIntent') {
    const day = doses.filter((d) => d.type === 'insulin' && now - d.t < 24 * 3600e3 && d.t <= now + 10 * 60e3).sort((a, b) => b.t - a.t);
    if (!day.length) return card(T(`I have no insulin logged${forWhom} in the last 24 hours.`, `No tengo insulina registrada${forWhom} en las últimas 24 horas.`));
    const bolus = day.find((d) => d.kind !== 'basal');
    const basal = day.find((d) => d.kind === 'basal');
    const line = (d) => (es ? `${d.amount ? unidades(d.amount) : 'una dosis'} de ${KIND_ES[d.kind] || d.kind}, ${haceEs(d.t, now)}` : `${d.amount ? unitWord(d.amount) : 'a dose'} of ${spokenKind(d.kind)}, ${ago(d.t, now)}`);
    const parts = [bolus && line(bolus), basal && line(basal)].filter(Boolean);
    return card(T(`Last insulin${forWhom}: ${parts.join('. And ')}.`, `Última insulina${forWhom}: ${parts.join('. Y ')}.`));
  }

  // LogInsulinIntent
  const units = Number(intent.slots?.units?.value);
  const kind = slotKind(intent.slots?.insulin);
  const elicit = (slot, text) => card(text, false, [{ type: 'Dialog.ElicitSlot', slotToElicit: slot, updatedIntent: intent }]);
  if (!Number.isFinite(units) || units <= 0) return elicit('units', T('How many units?', '¿Cuántas unidades?'));
  if (units > MAX_UNITS) return say(T(`${unitWord(units)} is more than ${MAX_UNITS}. I did not log it. Please check the number and say it again.`, `${unidades(units)} es más de ${MAX_UNITS}. No lo registré. Revisa el número y dilo otra vez.`));
  if (!kind) return elicit('insulin', T('Which insulin: rapid, regular, long-acting, N P H, or pre-mixed?', '¿Qué insulina: rápida, regular, de acción prolongada, N P H o premezclada?'));
  const back = durationMs(intent.slots?.ago?.value);
  if (back != null && back > 24 * 3600e3) return say(T('I can log doses from the last 24 hours. Nothing was logged.', 'Puedo registrar dosis de las últimas 24 horas. No se registró nada.'));
  const t = now - (back || 0);
  const when = es ? (back ? haceEs(t, now) : 'ahora') : (back ? ago(t, now) : 'now');
  const what = es ? `${unidades(units)} de insulina ${KIND_ES[kind]} ${when}${forWhom}` : `${unitWord(units)} of ${spokenKind(kind)} insulin ${when}${forWhom}`;

  if (intent.confirmationStatus === 'DENIED') return card(T('Okay, I did not log anything.', 'De acuerdo, no registré nada.'));
  if (intent.confirmationStatus !== 'CONFIRMED') {
    const warning = doubleDoseWarning(doses, who.pid, { t, kind }, {}, now, lang);
    const text = warning
      ? T(`Careful. ${speak(warning)} Do you still want to log ${what}?`, `Cuidado. ${speakEs(warning)} ¿Todavía quieres registrar ${what}?`)
      : T(`Log ${what}?`, `¿Registro ${what}?`);
    return card(text, false, [{ type: 'Dialog.ConfirmIntent', updatedIntent: intent }]);
  }

  const id = crypto.randomUUID();
  try {
    await store.upsert([{ id, pid: who.pid, t, kind, amount: units, source: 'alexa' }]);
  } catch {
    return say(T('I could not save that just now. Nothing was logged. Please log it in su94r Mini.', 'No pude guardarlo ahora. No se registró nada. Regístralo en su94r Mini o en la app.'));
  }
  return card(T(`Logged ${what}. It will show in su94r Mini within a minute.`, `Registré ${what}. Aparece en su94r Mini en un minuto.`));
}

// ---------- logging a meal by voice ----------

const MAX_GRAMS = 300;
const gramWord = (n) => `${n} gram${Number(n) === 1 ? '' : 's'}`;

async function carbsIntent(body, { say, reply, store, getSnapshot, lang = 'en' }) {
  const es = lang === 'es';
  const T = (en, sp) => (es ? sp : en);
  const card = (text, end = true, directives = null) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: { type: 'Simple', title: T('Meal', 'Comida'), content: text },
      shouldEndSession: end,
      ...(directives ? { directives } : {}),
    },
  });
  if (!store?.ready) return say(T('Logging meals by voice is not set up on the server yet.', 'Registrar comidas por voz todavía no está configurado en el servidor.'));
  const now = Date.now();
  const intent = body.request.intent;
  const who = await whoFor(body, getSnapshot, store);
  if (who.missing) return say(T(`I don't follow anyone called ${who.missing}.`, `No sigo a nadie llamado ${who.missing}.`));
  if (who.none) return say(T('No one is sharing their glucose with this account yet, so I do not know whose meal to log.', 'Nadie está compartiendo su glucosa con esta cuenta todavía, así que no sé de quién registrar la comida.'));
  const forWhom = who.many && who.name ? T(` for ${who.name}`, ` para ${who.name}`) : '';
  const grams = Number(intent.slots?.grams?.value);
  if (!Number.isFinite(grams) || grams <= 0) return card(T('How many grams of carbs?', '¿Cuántos gramos de carbohidratos?'), false, [{ type: 'Dialog.ElicitSlot', slotToElicit: 'grams', updatedIntent: intent }]);
  if (grams > MAX_GRAMS) return say(T(`${gramWord(grams)} is more than ${MAX_GRAMS}. I did not log it. Please check the number and say it again.`, `${gramos(grams)} es más de ${MAX_GRAMS}. No lo registré. Revisa el número y dilo otra vez.`));
  const back = durationMs(intent.slots?.ago?.value);
  if (back != null && back > 24 * 3600e3) return say(T('I can log meals from the last 24 hours. Nothing was logged.', 'Puedo registrar comidas de las últimas 24 horas. No se registró nada.'));
  const t = now - (back || 0);
  const what = es ? `${gramos(Math.round(grams))} de carbohidratos ${back ? haceEs(t, now) : 'ahora'}${forWhom}` : `${gramWord(Math.round(grams))} of carbs ${back ? ago(t, now) : 'now'}${forWhom}`;
  if (intent.confirmationStatus === 'DENIED') return card(T('Okay, I did not log anything.', 'De acuerdo, no registré nada.'));
  if (intent.confirmationStatus !== 'CONFIRMED') return card(T(`Log ${what}?`, `¿Registro ${what}?`), false, [{ type: 'Dialog.ConfirmIntent', updatedIntent: intent }]);
  try {
    await store.upsert([{ id: crypto.randomUUID(), pid: who.pid, t, kind: 'carbs', amount: Math.round(grams), source: 'alexa' }]);
  } catch {
    return say(T('I could not save that just now. Nothing was logged. Please log it in su94r Mini.', 'No pude guardarlo ahora. No se registró nada. Regístralo en su94r Mini o en la app.'));
  }
  return card(T(`Logged ${what}. It will show in su94r Mini within a minute.`, `Registré ${what}. Aparece en su94r Mini en un minuto.`));
}

// ---------- where the glucose is heading (the learner's estimate) ----------

async function forecastIntent(body, { say, getSnapshot, store, forecasts, lang = 'en' }) {
  const T = (en, sp) => (lang === 'es' ? sp : en);
  if (!forecasts?.ready) return say(T('Estimates are not set up on the server yet.', 'Los estimados todavía no están configurados en el servidor.'));
  const who = await whoFor(body, getSnapshot, store || { recent: async () => [] });
  if (who.missing) return say(T(`I don't follow anyone called ${who.missing}.`, `No sigo a nadie llamado ${who.missing}.`));
  if (who.none) return say(T('No one is sharing their glucose with this account yet.', 'Nadie está compartiendo su glucosa con esta cuenta todavía.'));
  let f = null;
  try { f = await forecasts.get(who.pid); } catch { return say(T('I could not reach the estimate just now.', 'No pude abrir el estimado ahora.')); }
  let units = 'mg/dL';
  try { units = (await getSnapshot()).people.find((p) => p.pid === who.pid)?.units || units; } catch { /* keep mg/dL */ }
  return say(speakForecast(f, { units, name: who.many ? who.name : '', lang }));
}

// ---- "what patterns do you see?" (extension/patterns.js over the last 14 days) ----

async function patternIntent(body, { say, getSnapshot, store, history, lang = 'en' }) {
  const T = (en, sp) => (lang === 'es' ? sp : en);
  if (!history?.ready) return say(T('The history is not set up on the server yet.', 'El historial todavía no está configurado en el servidor.'));
  const who = await whoFor(body, getSnapshot, store || { recent: async () => [] });
  if (who.missing) return say(T(`I don't follow anyone called ${who.missing}.`, `No sigo a nadie llamado ${who.missing}.`));
  if (who.none) return say(T('No one is sharing their glucose with this account yet.', 'Nadie está compartiendo su glucosa con esta cuenta todavía.'));
  let person = null;
  try { person = (await getSnapshot()).people.find((p) => p.pid === who.pid) || null; } catch { /* defaults */ }
  const mmol = person?.units === 'mmol/L';
  const now = Date.now();
  let points, events = [];
  try { points = await history.range(who.pid, now - 14 * 24 * 3600e3, now + 60e3); } catch { return say(T('I could not reach the history just now.', 'No pude abrir el historial ahora.')); }
  try { if (store?.between) events = asMarkers(await store.between(who.pid, now - 14 * 24 * 3600e3, now)); } catch { /* without doses */ }
  // Spoken without the unit (Alexa reads "mg/dL" letter by letter).
  const r = findPatterns(points, events, { now, low: person?.low ?? 70, high: person?.high ?? 180, fmt: (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg))), unit: '', lang });
  const list = r.patterns.slice(0, 3).map((p) => p.text.replace(/ {2,}/g, ' ').replace(/ \./g, '.').replace(/ \(/g, ' (').replace(/ ,/g, ',')).join(' ');
  const text = r.patterns.length
    ? T(`Over the last ${r.days} days: ${list} The app's History shows more.`, `En los últimos ${r.days} días: ${list} El historial de la app muestra más.`)
    : r.note;
  return say(who.many && who.name ? `${who.name}: ${text}` : text);
}

// ---- "how was my night?" and "how was my week?" (the server's history, history.js) ----

async function pastIntent(body, intent, { say, getSnapshot, store, history, lang = 'en' }) {
  const T = (en, sp) => (lang === 'es' ? sp : en);
  if (!history?.ready) return say(T('The history is not set up on the server yet.', 'El historial todavía no está configurado en el servidor.'));
  const who = await whoFor(body, getSnapshot, store || { recent: async () => [] });
  if (who.missing) return say(T(`I don't follow anyone called ${who.missing}.`, `No sigo a nadie llamado ${who.missing}.`));
  if (who.none) return say(T('No one is sharing their glucose with this account yet.', 'Nadie está compartiendo su glucosa con esta cuenta todavía.'));
  let person = null;
  try { person = (await getSnapshot()).people.find((p) => p.pid === who.pid) || null; } catch { /* defaults */ }
  const mmol = person?.units === 'mmol/L';
  const fmt = (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
  const now = Date.now();
  let points;
  try { points = await history.range(who.pid, now - (intent === 'NightIntent' ? 1 : 7) * 24 * 3600e3, now + 60e3); } catch { return say(T('I could not reach the history just now.', 'No pude abrir el historial ahora.')); }
  const range = { low: person?.low ?? 70, high: person?.high ?? 180, fmt, now, lang };
  const text = intent === 'NightIntent' ? nightSummary(points, range) : weekLine(points, range);
  return say(who.many && who.name ? `${who.name}: ${text}` : text);
}
