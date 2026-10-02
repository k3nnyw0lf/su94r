// Alexa skill endpoint.
//   "Alexa, ask my sugar how I'm doing."            latest reading, trend and age
//   "Alexa, tell my sugar 4 units of R insulin now."  logs a dose after you confirm it
//   "Alexa, ask my sugar when I last took insulin."   the last doses, from every device
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

const MMOL = 18.0182;
export const MAX_UNITS = 100;
const STALE_MS = 10 * 60e3;
const TREND_WORDS = { 1: 'falling fast', 2: 'falling', 3: 'steady', 4: 'rising', 5: 'rising fast' };

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

export function describePerson(p, { many, now = Date.now() } = {}) {
  const who = many ? p.firstName || p.name : null;
  const l = p.latest;
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

function aplDirective(people) {
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
            { type: 'Text', text: people.length > 1 ? p.name : 'Glucose', fontSize: '36dp', color: '#8b949e' },
            { type: 'Text', text: l ? shownValue(l.mg, p.units) : '—', fontSize: '200dp', fontWeight: 'bold', color },
            { type: 'Text', text: l ? `${p.units} · ${TREND_WORDS[l.trend] || ''} · ${minutesAgo(l.t)}` : '', fontSize: '32dp', color: '#f2f5f8' },
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
  const say = (text, { end = true, apl = null } = {}) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: { type: 'Simple', title: 'Glucose', content: text },
      shouldEndSession: end,
      ...(apl ? { directives: [apl] } : {}),
    },
  });

  if (type === 'SessionEndedRequest') return reply({ version: '1.0', response: {} });
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return say('Okay.');
  if (intent === 'AMAZON.HelpIntent') {
    return say('Ask me how your sugar is, how your night was, or where you are heading. Log a dose: say, 4 units of R insulin. Log a meal: say, I ate 40 grams. You can also ask when you last took insulin.', { end: false });
  }
  if (intent === 'LogInsulinIntent' || intent === 'LastInsulinIntent') {
    return insulinIntent(body, { say, reply, store, getSnapshot });
  }
  if (intent === 'LogCarbsIntent') return carbsIntent(body, { say, reply, store, getSnapshot });
  if (intent === 'ForecastIntent') return forecastIntent(body, { say, getSnapshot, store, forecasts });
  if (intent === 'NightIntent' || intent === 'WeekIntent') return pastIntent(body, intent, { say, getSnapshot, store, history });

  let snap;
  try {
    snap = await getSnapshot();
  } catch (e) {
    return say(e.code === 'config'
      ? 'Your sugar server is not connected yet. On your computer, open su94r Mini settings and press Connect to my su94r server.'
      : 'I could not reach LibreLinkUp just now. Please check your Libre app.');
  }

  let people = snap.people;
  const asked = body.request.intent?.slots?.name?.value?.toLowerCase();
  if (asked) {
    const match = people.filter((p) => (p.firstName || p.name).toLowerCase().startsWith(asked) || p.name.toLowerCase().includes(asked));
    if (!match.length) return say(`I don't follow anyone called ${asked}.`);
    people = match;
  }
  if (!people.length) return say('No one is sharing their glucose with this account yet.');

  const many = people.length > 1;
  const text = people.map((p) => describePerson(p, { many })).join(' ');
  const hasScreen = Boolean(body?.context?.System?.device?.supportedInterfaces?.['Alexa.Presentation.APL']);
  return say(text, { apl: hasScreen ? aplDirective(people) : null });
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

async function insulinIntent(body, { say, reply, store, getSnapshot }) {
  const card = (text, end = true, directives = null) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: { type: 'Simple', title: 'Insulin', content: text },
      shouldEndSession: end,
      ...(directives ? { directives } : {}),
    },
  });
  if (!store?.ready) return say('Logging insulin by voice is not set up on the server yet.');
  const now = Date.now();
  const intent = body.request.intent;
  const who = await whoFor(body, getSnapshot, store);
  if (who.missing) return say(`I don't follow anyone called ${who.missing}.`);
  if (who.none) return say('No one is sharing their glucose with this account yet, so I do not know whose insulin to log.');
  const forWhom = who.many && who.name ? ` for ${who.name}` : '';

  let doses;
  try { doses = asMarkers(await store.recent(who.pid, now)); } catch { return say('I could not reach the dose log just now. Nothing was logged.'); }

  if (intent.name === 'LastInsulinIntent') {
    const day = doses.filter((d) => d.type === 'insulin' && now - d.t < 24 * 3600e3 && d.t <= now + 10 * 60e3).sort((a, b) => b.t - a.t);
    if (!day.length) return card(`I have no insulin logged${forWhom} in the last 24 hours.`);
    const bolus = day.find((d) => d.kind !== 'basal');
    const basal = day.find((d) => d.kind === 'basal');
    const line = (d) => `${d.amount ? unitWord(d.amount) : 'a dose'} of ${spokenKind(d.kind)}, ${ago(d.t, now)}`;
    const parts = [bolus && line(bolus), basal && line(basal)].filter(Boolean);
    return card(`Last insulin${forWhom}: ${parts.join('. And ')}.`);
  }

  // LogInsulinIntent
  const units = Number(intent.slots?.units?.value);
  const kind = slotKind(intent.slots?.insulin);
  const elicit = (slot, text) => card(text, false, [{ type: 'Dialog.ElicitSlot', slotToElicit: slot, updatedIntent: intent }]);
  if (!Number.isFinite(units) || units <= 0) return elicit('units', 'How many units?');
  if (units > MAX_UNITS) return say(`${unitWord(units)} is more than ${MAX_UNITS}. I did not log it. Please check the number and say it again.`);
  if (!kind) return elicit('insulin', 'Which insulin: rapid, regular, long-acting, N P H, or pre-mixed?');
  const back = durationMs(intent.slots?.ago?.value);
  if (back != null && back > 24 * 3600e3) return say('I can log doses from the last 24 hours. Nothing was logged.');
  const t = now - (back || 0);
  const when = back ? ago(t, now) : 'now';
  const what = `${unitWord(units)} of ${spokenKind(kind)} insulin ${when}${forWhom}`;

  if (intent.confirmationStatus === 'DENIED') return card('Okay, I did not log anything.');
  if (intent.confirmationStatus !== 'CONFIRMED') {
    const warning = doubleDoseWarning(doses, who.pid, { t, kind }, {}, now);
    const text = warning
      ? `Careful. ${speak(warning)} Do you still want to log ${what}?`
      : `Log ${what}?`;
    return card(text, false, [{ type: 'Dialog.ConfirmIntent', updatedIntent: intent }]);
  }

  const id = crypto.randomUUID();
  try {
    await store.upsert([{ id, pid: who.pid, t, kind, amount: units, source: 'alexa' }]);
  } catch {
    return say('I could not save that just now. Nothing was logged. Please log it in su94r Mini.');
  }
  return card(`Logged ${what}. It will show in su94r Mini within a minute.`);
}

// ---------- logging a meal by voice ----------

const MAX_GRAMS = 300;
const gramWord = (n) => `${n} gram${Number(n) === 1 ? '' : 's'}`;

async function carbsIntent(body, { say, reply, store, getSnapshot }) {
  const card = (text, end = true, directives = null) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: { type: 'Simple', title: 'Meal', content: text },
      shouldEndSession: end,
      ...(directives ? { directives } : {}),
    },
  });
  if (!store?.ready) return say('Logging meals by voice is not set up on the server yet.');
  const now = Date.now();
  const intent = body.request.intent;
  const who = await whoFor(body, getSnapshot, store);
  if (who.missing) return say(`I don't follow anyone called ${who.missing}.`);
  if (who.none) return say('No one is sharing their glucose with this account yet, so I do not know whose meal to log.');
  const forWhom = who.many && who.name ? ` for ${who.name}` : '';
  const grams = Number(intent.slots?.grams?.value);
  if (!Number.isFinite(grams) || grams <= 0) return card('How many grams of carbs?', false, [{ type: 'Dialog.ElicitSlot', slotToElicit: 'grams', updatedIntent: intent }]);
  if (grams > MAX_GRAMS) return say(`${gramWord(grams)} is more than ${MAX_GRAMS}. I did not log it. Please check the number and say it again.`);
  const back = durationMs(intent.slots?.ago?.value);
  if (back != null && back > 24 * 3600e3) return say('I can log meals from the last 24 hours. Nothing was logged.');
  const t = now - (back || 0);
  const what = `${gramWord(Math.round(grams))} of carbs ${back ? ago(t, now) : 'now'}${forWhom}`;
  if (intent.confirmationStatus === 'DENIED') return card('Okay, I did not log anything.');
  if (intent.confirmationStatus !== 'CONFIRMED') return card(`Log ${what}?`, false, [{ type: 'Dialog.ConfirmIntent', updatedIntent: intent }]);
  try {
    await store.upsert([{ id: crypto.randomUUID(), pid: who.pid, t, kind: 'carbs', amount: Math.round(grams), source: 'alexa' }]);
  } catch {
    return say('I could not save that just now. Nothing was logged. Please log it in su94r Mini.');
  }
  return card(`Logged ${what}. It will show in su94r Mini within a minute.`);
}

// ---------- where the glucose is heading (the learner's estimate) ----------

async function forecastIntent(body, { say, getSnapshot, store, forecasts }) {
  if (!forecasts?.ready) return say('Estimates are not set up on the server yet.');
  const who = await whoFor(body, getSnapshot, store || { recent: async () => [] });
  if (who.missing) return say(`I don't follow anyone called ${who.missing}.`);
  if (who.none) return say('No one is sharing their glucose with this account yet.');
  let f = null;
  try { f = await forecasts.get(who.pid); } catch { return say('I could not reach the estimate just now.'); }
  let units = 'mg/dL';
  try { units = (await getSnapshot()).people.find((p) => p.pid === who.pid)?.units || units; } catch { /* keep mg/dL */ }
  return say(speakForecast(f, { units, name: who.many ? who.name : '' }));
}

// ---- "how was my night?" and "how was my week?" (the server's history, history.js) ----

async function pastIntent(body, intent, { say, getSnapshot, store, history }) {
  if (!history?.ready) return say('The history is not set up on the server yet.');
  const who = await whoFor(body, getSnapshot, store || { recent: async () => [] });
  if (who.missing) return say(`I don't follow anyone called ${who.missing}.`);
  if (who.none) return say('No one is sharing their glucose with this account yet.');
  let person = null;
  try { person = (await getSnapshot()).people.find((p) => p.pid === who.pid) || null; } catch { /* defaults */ }
  const mmol = person?.units === 'mmol/L';
  const fmt = (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
  const now = Date.now();
  let points;
  try { points = await history.range(who.pid, now - (intent === 'NightIntent' ? 1 : 7) * 24 * 3600e3, now + 60e3); } catch { return say('I could not reach the history just now.'); }
  const range = { low: person?.low ?? 70, high: person?.high ?? 180, fmt, now };
  const text = intent === 'NightIntent' ? nightSummary(points, range) : weekLine(points, range);
  return say(who.many && who.name ? `${who.name}: ${text}` : text);
}
