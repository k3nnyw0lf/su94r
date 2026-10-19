// su94r family accounts: one sealed account per family. Nothing is shared outside it: the
// family's Echo (the su94r skill), its screens (a Tesla, a computer, a TV), its tile and its
// alerts see only the people of that account, and the owner's server never shows them.
//
// A family signs in at su94r.com/sugar/family with their CGM account (a Dexcom account with Share
// on, or a LibreLinkUp follower), ticks the consents once, and gets a settings page for 30 minutes:
// the name and doctor's numbers, night hours, the alert phones (ntfy, free on iPhone and Android),
// the Echo announcement trigger links, and screens paired by the code su94r.com/tv shows.
//
// The night safety net is the owner's nightCheck (night.js) run per family every 5 minutes from
// sugar/tick, always naming the person. Dexcom Follow (or the Libre app) stays the official alarm.

import { NIGHT_DEFAULTS, nightCheck, acknowledge, ntfyPush, defaultRing, ECHO_URL, inLanguage } from './night.js';
import { sha256, randomToken, normalCode } from './screens.js';
import { signIn, peopleFor, seal, unseal, sugarStore } from './sugar.js';
import { familySignInPage, managePage } from './sugar-page.js';

export const FAMILY_PATHS = ['sugar/family', 'sugar/manage', 'sugar/ack'];
const MANAGE_TTL = 30 * 60e3;
const MIN = 60e3;
export const FAMILY_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico'];

const newTopic = () => `su94r-${randomToken(12)}`;
const fnBase = (env) => `${String(env.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/su94r-cgm`;
const ntfyBase = (env) => (env.NTFY_BASE || 'https://ntfy.sh').replace(/\/$/, '');
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null; };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** The family's night row, made with safe defaults the first time. */
export async function ensureNight(store, user) {
  const have = await store.nightFor(user.id);
  if (have) return have;
  const row = {
    user_id: user.id,
    cfg: { enabled: true, low_mgdl: 70, severe_mgdl: 55, high_mgdl: 250, night_start: 22, night_end: 7, time_zone: 'America/New_York', soon_enabled: true, watch_enabled: true, care_enabled: false, echo_always: false, nudge_enabled: false, lang_self: 'en', self_topic: newTopic(), care_topic: newTopic() },
    state: {},
  };
  await store.saveNight(row);
  return row;
}

/** What nightCheck needs: the owner's defaults, the family's settings, and their Echo links unsealed. */
export async function familyRow(store, user, night) {
  const cfg = night.cfg || {};
  const src = user.source === 'dexcom' ? 'Dexcom' : 'Libre';
  const who = user.person || 'your family member';
  return {
    ...NIGHT_DEFAULTS, ...cfg,
    name_people: true,
    source_label: src,
    nudge_enabled: false, call_enabled: false, meds: [], supplements: [], treat_plan: cfg.treat_plan || null,
    echo_low_url: cfg.echo_low_sealed ? (await unseal(store, cfg.echo_low_sealed).catch(() => null))?.url || null : null,
    echo_soon_url: cfg.echo_soon_sealed ? (await unseal(store, cfg.echo_soon_sealed).catch(() => null))?.url || null : null,
    signin_message: {
      title: `su94r cannot read ${who}'s glucose`,
      message: `su94r lost its ${src} sign-in, so the su94r backup alerts are paused.${src === 'Dexcom' ? ' Dexcom Follow still sends its alarms.' : ''} Sign in again at su94r.com/sugar/family.`,
      priority: 4, tags: ['warning'],
      es: { title: `su94r no puede leer la glucosa de ${user.person || 'tu familiar'}`, message: `su94r perdió su sesión de ${src}, así que las alertas de respaldo de su94r están en pausa.${src === 'Dexcom' ? ' Dexcom Follow sigue enviando sus alarmas.' : ''} Vuelve a iniciar sesión en su94r.com/sugar/family.` },
    },
    state: night.state || {},
  };
}

/** Every 5 minutes (sugar/tick): each family's safety net, at most every 4 minutes each. */
export async function familyTick(env, store, deps = {}, { now = Date.now() } = {}) {
  const rows = await store.familyNights(100);
  let checked = 0, sent = 0, failed = 0;
  for (const n of rows) {
    const user = n.user;
    if (!user || n.cfg?.enabled === false) continue;
    if (n.last_tick_at && now - Date.parse(n.last_tick_at) < 4 * MIN) continue;
    // Signed out (the password changed): never retry Dexcom or Libre, but say so every 12 hours
    // until the family signs in again, since su94r's backup is off meanwhile.
    if (user.status !== 'active') {
      const meta = n.state?._meta || {};
      const lastWarn = Math.max(meta.signedOutWarnAt || 0, meta.authWarnAt || 0);   // nightCheck's first warning counts
      if (now - lastWarn >= 12 * 60 * MIN) {
        const row = await familyRow(store, user, n);
        const push = deps.familyPush || ((topic, msg) => ntfyPush(env, topic, inLanguage(msg, row.lang_self === 'es' ? 'es' : 'en')));
        try { await push(row.self_topic, row.signin_message); sent++; } catch { failed++; }
        await store.patchNight(user.id, { state: { ...(n.state || {}), _meta: { ...meta, signedOutWarnAt: now } }, last_tick_at: new Date(now).toISOString() });
      }
      continue;
    }
    let people = [];
    let error = null;
    try { people = await peopleFor(store, user, deps); } catch (e) {
      error = { code: e.code === 'credentials' ? 'auth' : e.code || 'error', message: String(e.message || e).slice(0, 200) };
    }
    const row = await familyRow(store, user, n);
    const lang = row.lang_self === 'es' ? 'es' : 'en';
    const push = deps.familyPush || ((topic, msg) => ntfyPush(env, topic, inLanguage(msg, lang)));
    let result;
    try {
      result = await nightCheck({ row, people, error, now, push, ackUrl: (t) => `${fnBase(env)}/sugar/ack?u=${encodeURIComponent(user.id)}&t=${t}`, ring: deps.ring || defaultRing });
    } catch (e) { failed++; continue; }
    sent += result.sent.filter((s) => s.ok).length;
    failed += result.sent.filter((s) => !s.ok).length;
    await store.patchNight(user.id, { state: result.state, last_tick_at: new Date(now).toISOString(), last_result: { at: new Date(now).toISOString(), sent: result.sent, error: error?.code || null } });
    checked++;
  }
  return { checked, sent, failed };
}

/** A family screen's feed: the same shape as the owner's display data, this family only. */
export async function familyScreenPayload(env, screen, kind = 'data', deps = {}) {
  const store = deps.sugarStore || sugarStore(env);
  try {
    const user = await store.userById(screen.sugar_user);
    if (!user || user.status !== 'active') return jsonRes({ error: user ? 'The family must sign in again at su94r.com/sugar/family.' : 'unauthorized' }, user ? 503 : 401);
    const people = await peopleFor(store, user, deps);
    const now = Date.now();
    if (kind === 'glance') {
      const p = people[0];
      const l = p?.latest;
      if (!l) return jsonRes({ error: 'no reading yet' }, 404);
      const mins = Math.max(0, Math.round((now - l.t) / MIN));
      const stale = mins > 10;
      const mmol = p.units === 'mmol/L';
      const fmt = (mg) => (mg < 40 ? 'LO' : mg > 400 ? 'HI' : mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
      const ref = p.history.find((q) => Math.abs(q.t - (l.t - 15 * MIN)) <= 4 * MIN);
      const d = ref ? l.mg - ref.mg : null;
      const state = stale ? 'stale' : l.mg < 55 ? 'urgent' : l.mg < p.low ? 'low' : l.mg > p.high ? 'high' : 'in';
      return jsonRes({
        name: p.firstName || p.name, value: fmt(l.mg), units: p.units, mg: l.mg, trend: l.trend,
        arrow: ['', '↓', '↘', '→', '↗', '↑'][l.trend] || '',
        delta: d == null ? '' : `${d < 0 ? '−' : '+'}${mmol ? Math.abs(d / 18.0182).toFixed(1) : Math.abs(Math.round(d))}`,
        minutes: mins, ago: mins < 1 ? 'just now' : `${mins} min ago`, state,
        color: { stale: '#6e7681', urgent: '#ff5d55', low: '#ff5d55', high: '#e3a33b', in: '#3fb950' }[state], t: l.t,
      });
    }
    const since = now - 12 * 3600e3;
    return jsonRes({
      at: now,
      people: people.map((p) => ({ name: p.name, units: p.units, low: p.low, high: p.high, sensorStart: null, latest: p.latest, history: p.history.filter((q) => q.t >= since).map((q) => [q.t, q.mg]), extra: {} })),
      screen: { name: screen.name, kind: screen.kind },
    });
  } catch (e) {
    return jsonRes({ error: String(e.message || e).slice(0, 160), code: e.code }, e.code === 'config' ? 503 : 502);
  }
}

// ─── the family settings page ──────────────────────────────────────────────────────────────

async function manageSession(store, token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  const t = await store.tokenByHash(await sha256(token));
  if (!t || t.kind !== 'manage' || Date.parse(t.expires_at) <= Date.now()) return null;
  const user = await store.userById(t.user_id);
  return user ? { user, token } : null;
}

async function manageView(env, store, user, token, deps, { lang, message = null, error = null } = {}) {
  const night = await ensureNight(store, user);
  let reading = null;
  let readError = null;
  try { reading = (await peopleFor(store, user, deps))[0]?.latest || null; } catch (e) { readError = e.code || 'error'; }
  const screens = await store.screensFor(user.id).catch(() => []);
  const cfg = night.cfg || {};
  return managePage({
    lang, token, message, error,
    family: {
      source: user.source || 'libre', person: user.person || '', units: user.units || 'mg/dL', status: user.status,
      low: cfg.low_mgdl ?? 70, severe: cfg.severe_mgdl ?? 55, high: user.meta?.targets?.high ?? cfg.high_mgdl ?? 250,
      nightStart: cfg.night_start ?? 22, nightEnd: cfg.night_end ?? 7, timeZone: cfg.time_zone || 'America/New_York',
      treatPlan: cfg.treat_plan || '', enabled: cfg.enabled !== false, soon: cfg.soon_enabled !== false, echoAlways: Boolean(cfg.echo_always),
      langAlerts: cfg.lang_self === 'es' ? 'es' : 'en',
      echoLow: Boolean(cfg.echo_low_sealed), echoSoon: Boolean(cfg.echo_soon_sealed),
      topicUrl: `${ntfyBase(env)}/${cfg.self_topic}`,
      lastCheck: night.last_tick_at || null,
    },
    reading, readError, screens, zones: FAMILY_ZONES,
  });
}

async function manageAction(env, store, user, form, deps) {
  const night = await ensureNight(store, user);
  const cfg = { ...(night.cfg || {}) };
  const action = String(form.get('action') || '');
  if (action === 'settings') {
    const low = num(form.get('low'), 55, 120);
    const severe = num(form.get('severe'), 40, 100);
    const high = num(form.get('high'), 120, 400);
    const ns = num(form.get('night_start'), 0, 23);
    const ne = num(form.get('night_end'), 0, 23);
    if (low == null || severe == null || high == null || ns == null || ne == null) return { error: 'numbers' };
    if (severe >= low || high <= low + 20) return { error: 'order' };
    const tz = FAMILY_ZONES.includes(form.get('time_zone')) ? form.get('time_zone') : cfg.time_zone || 'America/New_York';
    const person = String(form.get('person') || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    Object.assign(cfg, {
      low_mgdl: low, severe_mgdl: severe, high_mgdl: high, night_start: ns, night_end: ne, time_zone: tz,
      treat_plan: String(form.get('treat_plan') || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140) || null,
      enabled: form.get('enabled') === 'yes', soon_enabled: form.get('soon') === 'yes', echo_always: form.get('echo_always') === 'yes',
      lang_self: form.get('lang_alerts') === 'es' ? 'es' : 'en',
    });
    await store.patchNight(user.id, { cfg });
    await store.patchUser(user.id, {
      ...(user.source === 'dexcom' && person ? { person } : {}),
      units: form.get('units') === 'mmol/L' ? 'mmol/L' : 'mg/dL',
      meta: { ...(user.meta || {}), targets: { low, high } },
    });
    return { message: 'saved' };
  }
  if (action === 'pair') {
    const code = normalCode(form.get('code'));
    if (!code) return { error: 'code' };
    const name = String(form.get('name') || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Screen';
    const r = await store.claimScreen(code, name, user.id);
    return r ? { message: 'paired' } : { error: 'nocode' };
  }
  if (action === 'unpair') {
    const id = String(form.get('id') || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return { error: 'bad' };
    await store.removeScreen(id, user.id);
    return { message: 'unpaired' };
  }
  if (action === 'echo') {
    const low = String(form.get('echo_low') || '').trim();
    const soon = String(form.get('echo_soon') || '').trim();
    if (!low && !soon) return { error: 'echo_missing' };
    if ((low && !ECHO_URL.test(low)) || (soon && !ECHO_URL.test(soon))) return { error: 'echo_bad' };
    if (low) cfg.echo_low_sealed = await seal(store, { url: low });
    if (soon) cfg.echo_soon_sealed = await seal(store, { url: soon });
    await store.patchNight(user.id, { cfg });
    return { message: 'echo_saved' };
  }
  if (action === 'echo_clear') {
    delete cfg.echo_low_sealed; delete cfg.echo_soon_sealed;
    await store.patchNight(user.id, { cfg });
    return { message: 'echo_cleared' };
  }
  if (action === 'test_alert') {
    const who = user.person || 'su94r';
    const msg = inLanguage({
      title: `${who}: su94r test alert`, message: 'If you can read this, su94r backup alerts reach this phone. Dexcom Follow stays the main alarm.', priority: 4, tags: ['white_check_mark'],
      es: { title: `${who}: alerta de prueba de su94r`, message: 'Si puedes leer esto, las alertas de respaldo de su94r llegan a este teléfono. Dexcom Follow sigue siendo la alarma principal.' },
    }, cfg.lang_self === 'es' ? 'es' : 'en');
    try { await (deps.familyPush || ((topic, m) => ntfyPush(env, topic, m)))(cfg.self_topic, msg); } catch { return { error: 'push' }; }
    return { message: 'test_sent' };
  }
  if (action === 'test_echo') {
    const row = await familyRow(store, user, { ...night, cfg });
    if (!row.echo_low_url) return { error: 'echo_missing' };
    try { await (deps.ring || defaultRing)(row.echo_low_url); } catch { return { error: 'echo_ring' }; }
    return { message: 'echo_rang' };
  }
  return { error: 'bad' };
}

export async function familyRoute(path, request, url, env, store, deps, { html, json, langOf }) {
  if (path === 'sugar/ack') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const id = url.searchParams.get('u') || '';
    const night = /^[0-9a-f-]{36}$/.test(id) ? await store.nightFor(id) : null;
    const user = night && await store.userById(id);
    if (!user) return json({ error: 'unknown or used' }, 404);
    const row = await familyRow(store, user, night);
    const state = await acknowledge(row, url.searchParams.get('t'), Date.now());
    if (!state) return json({ error: 'unknown or used' }, 404);
    await store.patchNight(id, { state });
    return json({ ok: true, message: 'Got it. Alerts for this low stop; a severe low still tells you once.' });
  }
  if (path === 'sugar/family') {
    if (request.method === 'GET') return html(familySignInPage({ lang: langOf(url, request) }));
    if (request.method !== 'POST') return json({ error: 'GET or POST' }, 405);
    const form = await request.formData();
    const lang = form.get('lang') === 'es' ? 'es' : 'en';
    const r = await signIn(form, store, deps, { lang, requireConsent: false });
    if (r.error) return html(familySignInPage({ lang, error: r.error, email: r.email, source: r.source, person: r.person }), 400);
    await ensureNight(store, r.user);
    const token = randomToken(24);
    await store.putToken({ hash: await sha256(token), user_id: r.user.id, kind: 'manage', expires_at: new Date(Date.now() + MANAGE_TTL).toISOString() });
    return html(await manageView(env, store, r.user, token, deps, { lang, message: r.created ? 'created' : null }));
  }
  // sugar/manage: every change is a form post carrying the 30-minute settings token.
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const form = await request.formData();
  const lang = form.get('lang') === 'es' ? 'es' : 'en';
  const s = await manageSession(store, form.get('m'));
  if (!s) return html(familySignInPage({ lang, error: 'expired' }), 401);
  const r = await manageAction(env, store, s.user, form, deps);
  const user = await store.userById(s.user.id);
  return html(await manageView(env, store, user, s.token, deps, { lang, ...r }), r.error ? 400 : 200);
}
