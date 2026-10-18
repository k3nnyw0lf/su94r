// su94r for everyone: the public, multi-user Alexa skill ("su94r", said "sugar").
//
// Each person links Alexa to a su94r account on su94r's own sign-in page (OAuth 2.0
// authorization-code grant, the way Alexa account linking works). They sign in there with a
// LibreLinkUp FOLLOWER account made only for su94r, never their own Libre login: they (and
// any family member) share to it from the LibreLink app. So:
//   - each person hears and sees only the people who chose to share with that follower;
//   - if Abbott ever blocks the follower, the patient's own Libre account and alarms are untouched.
// The follower login is sealed with AES-GCM (key from Supabase Vault via sugar_cred_key()).
// Read-only: glucose, trend, the last 3 hours on a screen, and the home-screen tile. No dosing.
//
// Routes (cgm-core.js, under sugar/): link (GET page, POST sign-in), token (OAuth token
// endpoint), alexa (the skill endpoint), tick (cron: tiles), delete (GET page, POST delete).
// Env: SUGAR_SKILL_ID, SUGAR_CLIENT_ID, SUGAR_CLIENT_SECRET (the operator makes it up and types it in
// both Amazon's account-linking form and the Supabase secrets), SUGAR_ALEXA_CLIENT_ID/SECRET
// (Alexa Skill Messaging of the su94r skill, for tiles), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { login as lluLogin, getConnections as lluConnections, getGraph as lluGraph, toPoint } from '../extension/libre.js';
import { verifyAlexaSignature, AlexaVerifyError } from './alexa-verify.js';
import { describePerson, aplDirective } from './alexa.js';
import { widgetContent, pushWidget } from './widget.js';
import { sha256, randomToken } from './screens.js';
import { linkPage, deletePage, donePage, docPage } from './sugar-page.js';
import { legalPage, LEGAL_KINDS } from './sugar-legal.js';

export const CONSENT_VERSION = '2026-10-18';
export const CONSENT_ITEMS = ['adult_terms', 'health_collect', 'share_amazon', 'not_medical', 'unofficial'];
const CODE_TTL = 10 * 60e3;
const ACCESS_TTL = 3600e3;
const REFRESH_TTL = 365 * 24 * 3600e3;
const MAX_PEOPLE = 20;                       // LibreLinkUp's own limit per follower account
const AMAZON_REDIRECT = /^https:\/\/(pitangui\.amazon\.com|layla\.amazon\.com|alexa\.amazon\.co\.jp)\/api\/skill\/link\/[A-Z0-9]+$/;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
// Supabase serves HTML from edge functions as text/plain with a sandbox CSP, so pages travel to
// the Cloudflare proxy as a JSON envelope (x-su94r-page: 1); the proxy serves them with
// servePage() from sugar-page.js. A redirect travels as { location }.
const html = (body, status = 200) => json({ page: body }, status, { 'x-su94r-page': '1' });
const redirect = (location) => json({ location }, 200, { 'x-su94r-page': '1' });
const reply = (body) => json(body);
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ─── store ──────────────────────────────────────────────────────────────────────────────────

export function sugarStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  const q = encodeURIComponent;
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('su94r accounts are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`su94r accounts answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  let rawKey = null;
  return {
    ready,
    async credKey() {
      if (!rawKey) rawKey = await call('/rpc/sugar_cred_key', { method: 'POST', body: '{}' });
      return rawKey;
    },
    userById: async (id) => (await call(`/sugar_users?select=*&id=eq.${q(id)}`))[0] || null,
    userByEmailHash: async (h) => (await call(`/sugar_users?select=*&email_hash=eq.${q(h)}`))[0] || null,
    userByAlexa: async (a) => (await call(`/sugar_users?select=*&alexa_user=eq.${q(a)}`))[0] || null,
    widgetUsers: async (limit = 50) => call(`/sugar_users?select=*&widget_on=is.true&status=eq.active&order=updated_at.asc&limit=${Number(limit) || 50}`),
    async saveUser(row) {
      return (await call('/sugar_users?on_conflict=email_hash', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'resolution=merge-duplicates,return=representation' } }))[0];
    },
    patchUser: (id, fields) => call(`/sugar_users?id=eq.${q(id)}`, { method: 'PATCH', body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } }),
    deleteUser: (id) => call(`/sugar_users?id=eq.${q(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
    putToken: (row) => call('/sugar_tokens', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=minimal' } }),
    tokenByHash: async (h) => (await call(`/sugar_tokens?select=*&hash=eq.${q(h)}`))[0] || null,
    /** Marks a code used only if it was unused; true when this call won the race. */
    async useCode(h) {
      return (await call(`/sugar_tokens?hash=eq.${q(h)}&kind=eq.code&used=is.false`, { method: 'PATCH', body: JSON.stringify({ used: true }) })).length === 1;
    },
  };
}

// ─── sealing the follower login ─────────────────────────────────────────────────────────────

async function aes(store) {
  return crypto.subtle.importKey('raw', unb64(await store.credKey()), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(store, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(store), new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return `v1:${b64(out)}`;
}
export async function unseal(store, text) {
  const all = unb64(String(text).replace(/^v1:/, ''));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await aes(store), all.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ─── reading one person's follower account ─────────────────────────────────────────────────

const libreDeps = (deps = {}) => ({ login: deps.login || lluLogin, connections: deps.connections || lluConnections, graph: deps.graph || lluGraph });

async function sessionFor(store, user, deps, { fresh = false } = {}) {
  const { login } = libreDeps(deps);
  if (!fresh && user.libre_session) {
    const s = await unseal(store, user.libre_session).catch(() => null);
    if (s?.token && (!s.expires || s.expires * 1000 > Date.now() + 300e3)) return s;
  }
  const cred = await unseal(store, user.libre_cred);
  try {
    const s = await login(cred.email, cred.password);
    await store.patchUser(user.id, { libre_session: await seal(store, s), status: 'active' });
    return s;
  } catch (e) {
    if (e.code === 'credentials') await store.patchUser(user.id, { status: 'needs_login' }).catch(() => {});
    throw e;
  }
}

const personFrom = (c, history = []) => {
  const latest = toPoint(c.glucoseMeasurement);
  const h = history.slice();
  if (latest && !h.some((p) => Math.abs(p.t - latest.t) < 60e3)) h.push(latest);
  h.sort((a, b) => a.t - b.t);
  return {
    pid: c.patientId,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed',
    firstName: c.firstName || '',
    units: (c.glucoseMeasurement?.GlucoseUnits ?? c.uom) === 0 ? 'mmol/L' : 'mg/dL',
    low: Number.isFinite(c.targetLow) ? c.targetLow : 70,
    high: Number.isFinite(c.targetHigh) ? c.targetHigh : 180,
    latest,
    history: h,
  };
};

const cache = new Map();   // user id → { at, people } for 55 s per function instance
export const resetSugarCache = () => cache.clear();

/** The people who share with this user's follower account; the first one gets its 12-hour graph. */
export async function peopleFor(store, user, deps = {}) {
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < 55e3) return hit.people;
  const { connections, graph } = libreDeps(deps);
  let session = await sessionFor(store, user, deps);
  let list;
  try {
    list = (await connections(session)).connections || [];
  } catch (e) {
    if (e.code !== 'auth') throw e;
    session = await sessionFor(store, user, deps, { fresh: true });
    list = (await connections(session)).connections || [];
  }
  const people = [];
  for (const [i, c] of list.slice(0, MAX_PEOPLE).entries()) {
    let history = [];
    if (i === 0) { try { history = ((await graph(session, c.patientId)).graphData || []).map(toPoint).filter(Boolean); } catch { /* the number alone still helps */ } }
    people.push(personFrom(c, history));
  }
  cache.set(user.id, { at: Date.now(), people });
  return people;
}

// ─── linking (OAuth 2.0 authorization code) ────────────────────────────────────────────────

const langOf = (url, request) => (url.searchParams.get('lang') || request.headers.get('accept-language') || '').toLowerCase().startsWith('es') ? 'es' : 'en';

function linkParams(src, env) {
  const p = { client_id: src.get('client_id') || '', redirect_uri: src.get('redirect_uri') || '', state: src.get('state') || '', response_type: src.get('response_type') || 'code' };
  const ok = env.SUGAR_CLIENT_ID && p.client_id === env.SUGAR_CLIENT_ID && AMAZON_REDIRECT.test(p.redirect_uri) && p.response_type === 'code' && p.state.length <= 2048;
  return { p, ok };
}

async function linkRoute(request, url, env, store, deps) {
  if (request.method === 'GET') {
    const { p, ok } = linkParams(url.searchParams, env);
    const lang = langOf(url, request);
    if (!ok) return html(donePage(lang, 'bad'), 400);
    return html(linkPage({ lang, params: p }));
  }
  if (request.method !== 'POST') return json({ error: 'GET or POST' }, 405);
  const form = await request.formData();
  const { p, ok } = linkParams(form, env);
  const lang = form.get('lang') === 'es' ? 'es' : 'en';
  if (!ok) return html(donePage(lang, 'bad'), 400);
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const again = (error) => html(linkPage({ lang, params: p, error, email }), 400);
  if (CONSENT_ITEMS.some((k) => form.get(k) !== 'yes')) return again('consent');
  if (!email || !password) return again('missing');
  const { login, connections } = libreDeps(deps);
  let session;
  try { session = await login(email, password); } catch (e) { return again(e.code === 'credentials' ? 'credentials' : 'libre'); }
  let list = [];
  try { list = (await connections(session)).connections || []; } catch { return again('libre'); }
  if (!list.length) return again('nobody');
  const user = await store.saveUser({
    email_hash: await sha256(email.toLowerCase()),
    libre_cred: await seal(store, { email, password }),
    libre_session: await seal(store, session),
    consents: { version: CONSENT_VERSION, at: new Date().toISOString(), items: CONSENT_ITEMS, lang },
    status: 'active',
    updated_at: new Date().toISOString(),
  });
  const code = randomToken(24);
  await store.putToken({ hash: await sha256(code), user_id: user.id, kind: 'code', redirect_uri: p.redirect_uri, expires_at: new Date(Date.now() + CODE_TTL).toISOString() });
  const to = new URL(p.redirect_uri);
  to.searchParams.set('state', p.state);
  to.searchParams.set('code', code);
  return redirect(to.toString());
}

function clientOk(request, form, env) {
  let id = form.get('client_id'), secret = form.get('client_secret');
  const auth = request.headers.get('authorization') || '';
  if (/^basic /i.test(auth)) {
    try { [id, secret] = atob(auth.slice(6).trim()).split(':').map(decodeURIComponent); } catch { return false; }
  }
  if (!env.SUGAR_CLIENT_ID || !env.SUGAR_CLIENT_SECRET || id !== env.SUGAR_CLIENT_ID || typeof secret !== 'string') return false;
  const a = new TextEncoder().encode(secret), b = new TextEncoder().encode(env.SUGAR_CLIENT_SECRET.trim());
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

async function issue(store, userId, { refresh = null } = {}) {
  const access = randomToken(32);
  await store.putToken({ hash: await sha256(access), user_id: userId, kind: 'access', expires_at: new Date(Date.now() + ACCESS_TTL).toISOString() });
  let refreshToken = refresh;
  if (!refreshToken) {
    refreshToken = randomToken(32);
    await store.putToken({ hash: await sha256(refreshToken), user_id: userId, kind: 'refresh', expires_at: new Date(Date.now() + REFRESH_TTL).toISOString() });
  }
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refreshToken };
}

async function tokenRoute(request, env, store) {
  if (request.method !== 'POST') return json({ error: 'invalid_request' }, 405);
  const form = await request.formData().catch(() => new FormData());
  if (!clientOk(request, form, env)) return json({ error: 'invalid_client' }, 401);
  const grant = form.get('grant_type');
  const live = (t, kind) => t && t.kind === kind && Date.parse(t.expires_at) > Date.now();
  if (grant === 'authorization_code') {
    const h = await sha256(String(form.get('code') || ''));
    const t = await store.tokenByHash(h);
    if (!live(t, 'code') || t.used || (form.get('redirect_uri') && form.get('redirect_uri') !== t.redirect_uri)) return json({ error: 'invalid_grant' }, 400);
    if (!(await store.useCode(h))) return json({ error: 'invalid_grant' }, 400);
    return json(await issue(store, t.user_id));
  }
  if (grant === 'refresh_token') {
    const rt = String(form.get('refresh_token') || '');
    const t = await store.tokenByHash(await sha256(rt));
    if (!live(t, 'refresh') || !(await store.userById(t.user_id))) return json({ error: 'invalid_grant' }, 400);
    return json(await issue(store, t.user_id, { refresh: rt }));
  }
  return json({ error: 'unsupported_grant_type' }, 400);
}

async function userForToken(store, token) {
  if (!token) return null;
  const t = await store.tokenByHash(await sha256(token));
  if (!t || t.kind !== 'access' || Date.parse(t.expires_at) <= Date.now()) return null;
  return store.userById(t.user_id);
}

// ─── the skill ──────────────────────────────────────────────────────────────────────────────

const T = (lang, en, es) => (lang === 'es' ? es : en);

export async function handleSugarAlexa(request, env, store, deps = {}) {
  if (!env.SUGAR_SKILL_ID) return new Response('SUGAR_SKILL_ID is not set', { status: 503 });
  const raw = await request.text();
  try { await (deps.verify || verifyAlexaSignature)(request.headers, raw); } catch (e) {
    return new Response(e instanceof AlexaVerifyError ? `signature: ${e.message}` : 'signature check failed', { status: 401 });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('bad request', { status: 400 }); }
  const appId = body?.context?.System?.application?.applicationId || body?.session?.application?.applicationId;
  if (appId !== env.SUGAR_SKILL_ID) return new Response('unknown skill', { status: 403 });
  const sent = Date.parse(body?.request?.timestamp || '');
  if (!Number.isFinite(sent) || Math.abs(Date.now() - sent) > 150e3) return new Response('stale request', { status: 400 });

  const type = body.request.type || '';
  const amazonUser = body.context?.System?.user?.userId || body.session?.user?.userId || null;
  const token = body.context?.System?.user?.accessToken || body.session?.user?.accessToken || null;
  const lang = /^es/i.test(body.request.locale || '') ? 'es' : 'en';
  const empty = reply({ version: '1.0', response: {} });

  // Turning the skill off in the Alexa app deletes the account and everything with it.
  if (type === 'AlexaSkillEvent.SkillDisabled') {
    const u = amazonUser && await store.userByAlexa(amazonUser);
    if (u) await store.deleteUser(u.id);
    return empty;
  }
  const user = await userForToken(store, token);
  if (type === 'AlexaSkillEvent.SkillAccountLinked') {
    if (user && amazonUser) await store.patchUser(user.id, { alexa_user: amazonUser });
    return empty;
  }
  if (/^Alexa\.DataStore\.PackageManager\./.test(type)) {
    const u = user || (amazonUser && await store.userByAlexa(amazonUser));
    if (u && /\.UsagesInstalled$/.test(type)) {
      await store.patchUser(u.id, { widget_on: true, alexa_user: amazonUser || u.alexa_user });
      try {
        const p = (await peopleFor(store, u, deps))[0];
        if (p) await (deps.pushTile || pushWidget)(tileEnv(env), amazonUser || u.alexa_user, widgetContent(p));
      } catch { /* the tick sends it within 5 minutes */ }
    }
    if (u && /\.UsagesRemoved$/.test(type)) await store.patchUser(u.id, { widget_on: false });
    return empty;
  }
  if (type === 'SessionEndedRequest') return empty;

  const intent = body.request.intent?.name;
  const say = (text, { end = true, apl = null, link = false } = {}) => reply({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      card: link ? { type: 'LinkAccount' } : { type: 'Simple', title: 'su94r', content: text },
      shouldEndSession: end,
      ...(apl ? { directives: [apl] } : {}),
    },
  });
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return say(T(lang, 'Okay.', 'De acuerdo.'));
  if (intent === 'AMAZON.NavigateHomeIntent') return say(T(lang, 'Okay.', 'De acuerdo.'));
  if (intent === 'AMAZON.FallbackIntent') {
    return say(T(lang, 'Sorry, I can only read glucose. Ask me how your sugar is, or how someone in your family is doing.', 'Perdón, solo puedo leer la glucosa. Pregúntame cómo está tu azúcar, o cómo está alguien de tu familia.'), { end: false });
  }
  if (intent === 'AMAZON.HelpIntent') {
    return say(T(lang, 'Ask me how your sugar is, or how someone in your family is doing. su94r only reads the glucose of people who share with your su94r follower account. It is not an alarm and not medical advice.',
      'Pregúntame cómo está tu azúcar, o cómo está alguien de tu familia. su94r solo lee la glucosa de quienes comparten con tu cuenta seguidora de su94r. No es una alarma ni un consejo médico.'), { end: false });
  }
  if (!user) {
    return say(T(lang, 'To hear your glucose, link your su94r account. I sent a card to your Alexa app.', 'Para escuchar tu glucosa, vincula tu cuenta de su94r. Te envié una tarjeta a la app de Alexa.'), { link: true });
  }
  if (user.status === 'needs_login') {
    return say(T(lang, 'Your su94r follower sign-in stopped working. In the Alexa app, open su94r and link it again.', 'El inicio de sesión de tu cuenta seguidora de su94r dejó de funcionar. En la app de Alexa, abre su94r y vincúlala otra vez.'), { link: true });
  }
  if (amazonUser && user.alexa_user !== amazonUser) await store.patchUser(user.id, { alexa_user: amazonUser }).catch(() => {});

  let people;
  try { people = await peopleFor(store, user, deps); } catch (e) {
    return e.code === 'credentials'
      ? say(T(lang, 'Your su94r follower sign-in stopped working. In the Alexa app, open su94r and link it again.', 'El inicio de sesión de tu cuenta seguidora de su94r dejó de funcionar. En la app de Alexa, abre su94r y vincúlala otra vez.'), { link: true })
      : say(T(lang, 'I could not reach Libre just now. Check your Libre app, and keep its alarms on.', 'No pude conectar con Libre ahora. Revisa tu app de Libre y mantén sus alarmas encendidas.'));
  }
  const asked = body.request.intent?.slots?.name?.value?.toLowerCase();
  if (asked) {
    const match = people.filter((p) => (p.firstName || p.name).toLowerCase().startsWith(asked) || p.name.toLowerCase().includes(asked));
    if (!match.length) return say(T(lang, `No one called ${asked} shares with your su94r account.`, `Nadie llamado ${asked} comparte con tu cuenta de su94r.`));
    people = match;
  }
  if (!people.length) return say(T(lang, 'No one shares their glucose with your su94r follower account yet. In the LibreLink app, share with that follower email.', 'Nadie comparte su glucosa con tu cuenta seguidora de su94r todavía. En la app LibreLink, comparte con ese correo.'));
  let text = people.map((p) => describePerson(p, { many: people.length > 1, lang })).join(' ');
  if (!user.meta?.disclaimed) {
    text += T(lang, ' Remember: su94r is information only, can be late, and is not an alarm. Keep your Libre alarms on.', ' Recuerda: su94r es solo información, puede llegar tarde y no es una alarma. Mantén encendidas las alarmas de Libre.');
    await store.patchUser(user.id, { meta: { ...(user.meta || {}), disclaimed: new Date().toISOString() } }).catch(() => {});
  }
  const hasScreen = Boolean(body?.context?.System?.device?.supportedInterfaces?.['Alexa.Presentation.APL']);
  return say(text, { apl: hasScreen ? aplDirective(people, lang) : null });
}

/** The su94r skill's own messaging credentials (not the owner's My Sugar ones). */
const tileEnv = (env) => ({ ALEXA_CLIENT_ID: env.SUGAR_ALEXA_CLIENT_ID, ALEXA_CLIENT_SECRET: env.SUGAR_ALEXA_CLIENT_SECRET });

/** Cron, every 5 minutes: each tile gets its person's new reading (or the same one every 30 minutes). */
export async function sugarTick(env, store, deps = {}, { limit = 50, now = Date.now() } = {}) {
  const users = await store.widgetUsers(limit);
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      const p = (await peopleFor(store, u, deps))[0];
      if (!p?.latest) continue;
      const meta = u.meta || {};
      if (meta.widgetT === p.latest.t && now - (meta.widgetAt || 0) < 30 * 60e3) continue;
      const r = await (deps.pushTile || pushWidget)(tileEnv(env), u.alexa_user, widgetContent(p, now), { now });
      if (r.ok) { sent++; await store.patchUser(u.id, { meta: { ...meta, widgetT: p.latest.t, widgetAt: now } }); } else failed++;
    } catch { failed++; }
  }
  return { users: users.length, sent, failed };
}

async function deleteRoute(request, url, store, deps) {
  if (request.method === 'GET') return html(deletePage(langOf(url, request)));
  if (request.method !== 'POST') return json({ error: 'GET or POST' }, 405);
  const form = await request.formData();
  const lang = form.get('lang') === 'es' ? 'es' : 'en';
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const u = email && await store.userByEmailHash(await sha256(email.toLowerCase()));
  if (!u) return html(deletePage(lang, 'notfound'), 404);
  const cred = await unseal(store, u.libre_cred).catch(() => null);
  if (!cred || cred.password !== password) {
    // The follower password may have changed since linking: Libre itself can confirm it.
    try { await libreDeps(deps).login(email, password); } catch { return html(deletePage(lang, 'credentials'), 401); }
  }
  await store.deleteUser(u.id);
  cache.delete(u.id);
  return html(donePage(lang, 'deleted'));
}

export const SUGAR_PATHS = new Set(['sugar/link', 'sugar/token', 'sugar/alexa', 'sugar/tick', 'sugar/delete', ...Object.keys(LEGAL_KINDS)]);

export async function sugarRoute(path, request, env, deps = {}) {
  if (!SUGAR_PATHS.has(path)) return null;
  if (LEGAL_KINDS[path]) {
    const url = new URL(request.url);
    const doc = legalPage(LEGAL_KINDS[path], langOf(url, request), { operator: env.SUGAR_OPERATOR, contact: env.SUGAR_CONTACT, reviewed: env.SUGAR_LEGAL_REVIEWED === '1' });
    return html(docPage(langOf(url, request), doc));
  }
  const store = deps.sugarStore || sugarStore(env);
  if (!store.ready) return json({ error: 'not configured' }, 503);
  const url = new URL(request.url);
  if (path === 'sugar/link') return linkRoute(request, url, env, store, deps);
  if (path === 'sugar/token') return tokenRoute(request, env, store);
  if (path === 'sugar/alexa') return request.method === 'POST' ? handleSugarAlexa(request, env, store, deps) : json({ error: 'POST only' }, 405);
  if (path === 'sugar/tick') return request.method === 'POST' ? json(await sugarTick(env, store, deps)) : json({ error: 'POST only' }, 405);
  return deleteRoute(request, url, store, deps);
}
