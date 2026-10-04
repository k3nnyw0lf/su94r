// Phone calls for a low nobody answers, through Telnyx (paid: about $0.007 a minute for US calls
// and $1 a month for the number, Telnyx's list prices in October 2026; the spoken words cost a
// fraction of a cent). Off until the owner sets the four Supabase secrets and adds numbers in
// su94r Mini (Low alerts → Phone calls):
//   SU94R_TELNYX_API_KEY, SU94R_TELNYX_ACCOUNT_SID, SU94R_TELNYX_TEXML_APP_ID, SU94R_TELNYX_FROM
//
// The night check decides when to call (night.js escalate). A call: Telnyx fetches call/texml with
// the words; the person hears them and presses 1 (the same as "I'm OK": call/answer acknowledges the
// low with that call's own token) or 2 to hear them again.
//
// Routes (Telnyx fetches these; the token in the address is the only key, and it only answers a low):
//   GET|POST call/texml?t=&lang=&say=     the call's words, with a 1-or-2 menu
//   GET|POST call/answer?t=&lang=&say=    the digit pressed (Digits), from the menu

import { acknowledge } from './night.js';

const API = 'https://api.telnyx.com/v2/texml/Accounts';
const VOICE = { en: { voice: 'Polly.Joanna', language: 'en-US' }, es: { voice: 'Polly.Lupe', language: 'es-US' } };

export const telnyxReady = (env) => Boolean(env.TELNYX_API_KEY && env.TELNYX_ACCOUNT_SID && env.TELNYX_TEXML_APP_ID && env.TELNYX_FROM);

/** dial(to, { token, say, lang }): starts one call; throws when Telnyx refuses it. */
export function dialer(env, { base, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!telnyxReady(env)) return null;
  return async (to, { token, say, lang = 'en' }) => {
    const q = new URLSearchParams({ t: token, lang, say: String(say).slice(0, 600) });
    const res = await fetchImpl(`${API}/${encodeURIComponent(env.TELNYX_ACCOUNT_SID)}/Calls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ApplicationSid: env.TELNYX_TEXML_APP_ID, To: to, From: env.TELNYX_FROM, Url: `${base}/call/texml?${q}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Telnyx answered ${res.status}`);
    return true;
  };
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** The TeXML for the call: the words inside a one-digit menu, said twice before giving up. */
export function texml(say, lang, action) {
  const v = VOICE[lang] || VOICE.en;
  const tail = lang === 'es' ? 'No marcaste nada. su94r sigue alertando.' : 'No key pressed. su94r keeps alerting.';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Gather action="${xml(action)}" numDigits="1" timeout="8" validDigits="12"><Say voice="${v.voice}" language="${v.language}" loop="2">${xml(say)}</Say></Gather><Say voice="${v.voice}" language="${v.language}">${xml(tail)}</Say><Hangup/></Response>`;
}

const say = (text, lang) => { const v = VOICE[lang] || VOICE.en; return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say voice="${v.voice}" language="${v.language}">${xml(text)}</Say><Hangup/></Response>`; };

/** call/texml and call/answer; null when the path is not one. */
export async function callRoute(path, request, url, { night, base, now = () => Date.now() }) {
  if (path !== 'call/texml' && path !== 'call/answer') return null;
  const reply = (body) => new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' } });
  const token = url.searchParams.get('t') || '';
  const lang = url.searchParams.get('lang') === 'es' ? 'es' : 'en';
  const words = (url.searchParams.get('say') || '').slice(0, 600);
  if (!/^[0-9a-f]{32}$/.test(token) || !words) return reply(say(lang === 'es' ? 'Esta llamada ya no está activa.' : 'This call is no longer active.', lang));
  const q = new URLSearchParams({ t: token, lang, say: words });
  const action = `${base}/call/answer?${q}`;
  if (path === 'call/texml') return reply(texml(words, lang, action));
  // The digit: in the address (GET) or the form body (POST).
  let digits = url.searchParams.get('Digits');
  if (digits == null && request.method === 'POST') {
    const form = new URLSearchParams(await request.text().catch(() => ''));
    digits = form.get('Digits');
  }
  if (digits === '2') return reply(texml(words, lang, action));
  if (digits !== '1') return reply(say(lang === 'es' ? 'No entendí. su94r sigue alertando.' : 'Did not get that. su94r keeps alerting.', lang));
  if (night?.ready) {
    const row = await night.get();
    const state = await acknowledge(row, token, now());
    if (state) await night.patch({ state });
  }
  return reply(say(lang === 'es' ? 'Gracias. Las alertas de esta baja paran. Cuídate.' : 'Thank you. The alerts for this low stop. Take care.', lang));
}
