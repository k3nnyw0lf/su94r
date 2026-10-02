// ═══════════════════════════════════════════════════════════════════════════
// CGM core — every route that has to talk to LibreLinkUp from a server.
//
// WHY THIS IS NOT IN THE CLOUDFLARE WORKER
//
// LibreView sits behind a bot shield that answers 403 to Cloudflare Workers
// (tested 2026-10-01: same request, same headers — 200 from a laptop and from a
// Supabase edge function, 403 from a Worker). That is also why the original
// su94r-proxy stopped getting Libre data. So this module runs in the Supabase
// edge function su94r-cgm, and su94r-proxy forwards these routes to it.
//
// It is plain Fetch-API JavaScript with no runtime-specific calls, so the same
// code is tested in Node (vitest) and runs in Deno (Supabase).
//
// Routes handled by handleCgm(path, request, env):
//   POST libre/login, libre/readings   the PWA's own LibreLinkUp login (its credentials)
//   GET  glucose/latest                the monitor's feed      (HEALTH_INGEST_TOKEN)
//   GET  display/data                  the big-screen data      (DISPLAY_KEY)
//   POST alexa                         the Alexa skill          (ALEXA_SKILL_ID + Amazon's signature)
//   POST voice/sync                    su94r Mini <-> voice doses (DISPLAY_KEY, SUPABASE_*)
//   POST pair/start, pair/poll         a screen asks for a code and waits (no secret: codes expire)
//   POST pair/claim                    su94r Mini enters a screen's code (DISPLAY_KEY)
//   GET  screen/data                   a paired screen's data (its own bearer token)
//   GET  screens, POST screens/remove  list and remove paired screens (DISPLAY_KEY)
//   inbox/*, inboxes                   health inbox for phone apps (inbox.js)
//   mcp/new, mcp/<token>               the AI connector, MCP over HTTP (mcp.js)
//   ns/new, ns/*                       Nightscout-style feed for watch faces and widgets (nightscout.js)
//   connect, connect/status, connect/session   su94r Mini connects with its LibreLinkUp sign-in (owner.js)
//   night/tick, night/setup, night/test, night/ack   low alerts on the phone, every 5 min (night.js)
//   tg/*                               the same alerts on Telegram, chats linked by a tap (telegram.js)
// Where DISPLAY_KEY is named, a connected su94r Mini's own key works too.
// Server-side routes also need LLU_EMAIL and LLU_PASSWORD. Anything unset → 503.
// ═══════════════════════════════════════════════════════════════════════════

import { login as lluLogin, getConnections, getGraph, toPoint, sensorOf, LibreError, DEFAULT_VERSION } from '../extension/libre.js';
import { handleAlexa } from './alexa.js';
import { doseStore, asMarkers, WINDOW_MS } from './doses.js';
import { screenStore, pairStart, pairPoll, pairClaim, screenFor, shareNew, shareClaim } from './screens.js';
import { inboxStore, inboxRoute } from './inbox.js';
import { mcpRoute } from './mcp.js';
import { nightscoutRoute, makeNsLink } from './nightscout.js';
import { ownerStore, connectRoute, isOwnerKey } from './owner.js';
import { nightStore, nightRoute } from './night.js';
import { forecastStore, cleanForecasts } from './forecast.js';
import { telegramStore, telegramRoute, telegramAlert, telegramLinkFor, askMeal } from './telegram.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, Mcp-Session-Id, Mcp-Protocol-Version',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

// Constant-time comparison for secrets in URLs and headers.
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The LibreLinkUp token is a JWT whose payload carries the user id; the account-id
// header is its SHA-256. Deriving it here keeps the PWA's stored {token, apiBase} working.
async function accountIdFromToken(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const id = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '='))).id;
    return id ? await sha256Hex(id) : null;
  } catch {
    return null;
  }
}

const iso = (t) => new Date(t).toISOString();

// ─── Server-side LibreLinkUp session (for monitor, display, Alexa) ──────────

let memSession = null;
let memSnapshot = null;
let memFromOwner = false;            // the session came from su94r Mini (owner.js), not a stored password
let lastSaved = { token: null, at: 0 };

/** Test hook: forget cached sessions and snapshots. */
export function resetCaches() {
  memSession = null;
  memSnapshot = null;
  memFromOwner = false;
  lastSaved = { token: null, at: 0 };
}

const owners = (env) => env.OWNER_STORE || ownerStore(env);

async function serverSession(env) {
  if (memSession) return memSession;
  if (env.LLU_EMAIL && env.LLU_PASSWORD) {
    if (env.CACHE) {
      const cached = await env.CACHE.get('llu-session', 'json');
      if (cached?.token && (!cached.expires || cached.expires * 1000 > Date.now() + 3600e3)) return (memSession = cached);
    }
    memSession = await lluLogin(env.LLU_EMAIL, env.LLU_PASSWORD);
    memFromOwner = false;
    // Optional KV-style cache (env.CACHE): one write per sign-in, months apart.
    if (env.CACHE) await env.CACHE.put('llu-session', JSON.stringify(memSession));
    return memSession;
  }
  // No stored password: the LibreLinkUp sign-in su94r Mini handed over when it connected.
  const store = owners(env);
  const row = store.ready ? await store.get().catch(() => null) : null;
  if (!row?.session?.token) throw new LibreError('config', 'This su94r server has no LibreLinkUp sign-in yet: connect su94r Mini to it (Settings → Alexa and screens).');
  memFromOwner = true;
  return (memSession = row.session);
}

/** A handed-over session is refreshed by LibreLinkUp on every call; keep the newest (at most every 10 minutes). */
function keepFresh(env, session) {
  if (!memFromOwner || !session?.token || session.token === lastSaved.token || Date.now() - lastSaved.at < 10 * 60e3) return;
  lastSaved = { token: session.token, at: Date.now() };
  owners(env).saveSession(session).catch(() => {});
}

async function withSession(env, call) {
  try {
    const r = await call(await serverSession(env));
    memSession = r.session;
    keepFresh(env, r.session);
    return r;
  } catch (e) {
    if (e.code !== 'auth') throw e;
    memSession = null;
    if (memFromOwner) {
      // No password to sign in again with: su94r Mini hands over a fresh sign-in on its next visit.
      throw new LibreError('auth', 'The LibreLinkUp sign-in su94r Mini handed over has ended. Open su94r Mini (it reconnects by itself) or connect again in Settings.');
    }
    if (env.CACHE) await env.CACHE.delete('llu-session');
    const r = await call(await serverSession(env));
    memSession = r.session;
    return r;
  }
}

/** su94r Mini just connected or refreshed: use its session now, and show fresh data. */
function adoptSession(env, session) {
  if (env.LLU_EMAIL && env.LLU_PASSWORD) return;
  memSession = session;
  memFromOwner = true;
  memSnapshot = null;
  lastSaved = { token: session.token, at: Date.now() };
}

// Everyone this follower account can see, with 12 hours of history. Cached for
// 55 s so a TV, an Echo Show and the monitor polling together cost one fetch.
export async function snapshot(env, { maxPeople = 12 } = {}) {
  if (memSnapshot && Date.now() - memSnapshot.at < 55e3) return memSnapshot;
  const { connections } = await withSession(env, (s) => getConnections(s));
  const people = [];
  for (const c of connections.slice(0, maxPeople)) {
    let history = [];
    let sensor = sensorOf(c);
    try {
      const g = await withSession(env, (s) => getGraph(s, c.patientId));
      history = g.graphData.map(toPoint).filter(Boolean);
      sensor = sensorOf(g.connection, g.activeSensors) || sensor;
    } catch (e) {
      if (e.code === 'auth' || e.code === 'config') throw e;
    }
    const latest = toPoint(c.glucoseMeasurement);
    if (latest && !history.some((p) => Math.abs(p.t - latest.t) < 60e3)) history.push(latest);
    history.sort((a, b) => a.t - b.t);
    people.push({
      pid: c.patientId,   // internal: matches doses to people; never sent to a screen
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed',
      firstName: c.firstName || '',
      units: (c.glucoseMeasurement?.GlucoseUnits ?? c.uom) === 0 ? 'mmol/L' : 'mg/dL',
      low: Number.isFinite(c.targetLow) ? c.targetLow : 70,
      high: Number.isFinite(c.targetHigh) ? c.targetHigh : 180,
      latest,
      history,
      sensorStart: sensor?.start ?? null,
    });
  }
  memSnapshot = { at: Date.now(), people };
  return memSnapshot;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

async function libreLogin(request) {
  const { email, password } = await request.json();
  try {
    const s = await lluLogin(email, password);
    return json({ token: s.token, apiBase: s.base, accountId: s.accountId, version: s.version });
  } catch (e) {
    return json({ error: e.message, code: e.code }, e.code === 'credentials' ? 401 : 502);
  }
}

async function libreReadings(request) {
  const { token, apiBase, accountId } = await request.json();
  if (!token) return json({ error: 'Not logged in' }, 401);
  const session = {
    base: apiBase && /^https:\/\/api(-[a-z0-9]+)?\.libreview\.io$/.test(apiBase) ? apiBase : 'https://api.libreview.io',
    token,
    accountId: accountId || (await accountIdFromToken(token)),
    version: DEFAULT_VERSION,
  };
  try {
    const { connections } = await getConnections(session);
    const conn = connections[0];
    if (!conn) return json({ error: 'No CGM connections found' }, 404);
    const g = await getGraph(session, conn.patientId);
    const latest = toPoint(conn.glucoseMeasurement);
    const history = g.graphData.map(toPoint).filter(Boolean);
    return json({
      current: latest
        ? { value: latest.mg, trend: latest.trend, timestamp: iso(latest.t), unit: 'mg/dL', source: 'libre' }
        : null,
      history: history.reverse().map((p) => ({ value: p.mg, trend: p.trend, timestamp: iso(p.t) })),
    });
  } catch (e) {
    return json({ error: e.message, code: e.code }, e.code === 'auth' ? 401 : 502);
  }
}

async function glucoseLatest(request, env) {
  if (!env.HEALTH_INGEST_TOKEN) return json({ error: 'HEALTH_INGEST_TOKEN is not set' }, 503);
  const auth = request.headers.get('Authorization') || '';
  if (!safeEqual(auth, `Bearer ${env.HEALTH_INGEST_TOKEN}`)) return json({ error: 'unauthorized' }, 401);
  try {
    const snap = await snapshot(env, { maxPeople: 1 });
    const p = snap.people[0];
    if (!p) return json({ error: 'No one is sharing with the server LibreLinkUp account' }, 404);
    return json(p.history.map((q) => ({ value: q.mg, trend: q.trend, timestamp: iso(q.t), source: 'libre' })));
  } catch (e) {
    return json({ error: e.message, code: e.code }, e.code === 'config' ? 503 : 502);
  }
}

/** The display key (a server secret) or a connected su94r Mini's own key. */
async function displayKeyOk(env, key, deps = {}) {
  if (env.DISPLAY_KEY && safeEqual(key, env.DISPLAY_KEY)) return true;
  return isOwnerKey(deps.screens || screenStore(env), key);
}

async function displayData(url, env, deps) {
  if (!(await displayKeyOk(env, url.searchParams.get('key'), deps))) return json({ error: 'unauthorized' }, 401);
  return displayPayload(env);
}

async function displayPayload(env, extra = {}) {
  try {
    const snap = await snapshot(env);
    const since = Date.now() - 12 * 3600e3;
    return json({
      at: snap.at,
      people: snap.people.map((p) => ({
        name: p.name, units: p.units, low: p.low, high: p.high, sensorStart: p.sensorStart,
        latest: p.latest,
        history: p.history.filter((q) => q.t >= since).map((q) => [q.t, q.mg]),
      })),
      ...extra,
    });
  } catch (e) {
    return json({ error: e.message, code: e.code }, e.code === 'config' ? 503 : 502);
  }
}


// su94r Mini sends its recent insulin markers and the ids of doses it deleted, and gets
// back the doses said to Alexa. Deletions are only ever explicit: a computer that has
// not yet received another computer's dose must not erase it.
async function voiceSync(request, url, env, deps) {
  if (!(await displayKeyOk(env, url.searchParams.get('key'), deps))) return json({ error: 'unauthorized' }, 401);
  const store = deps.store || doseStore(env);
  if (!store.ready) return json({ error: 'The dose store is not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
  const now = Date.now();
  const markers = (Array.isArray(body?.markers) ? body.markers : [])
    .filter((m) => m?.type === 'insulin' && Number.isFinite(m.t) && now - m.t < WINDOW_MS && m.t < now + 15 * 60e3)
    .slice(0, 500);
  await store.upsert(markers.map((m) => ({
    id: m.id, pid: m.p, t: m.t, kind: m.kind || 'rapid', amount: m.amount ?? null,
    source: m.source === 'alexa' ? 'alexa' : 'extension',
  })));
  const removed = (Array.isArray(body?.removed) ? body.removed : []).slice(0, 500);
  if (removed.length) await store.markDeleted(removed);
  // The learner's estimates ride along (forecast.js); a failure here never blocks the doses.
  const forecasts = cleanForecasts(body?.forecasts, now);
  const fstore = deps.forecasts || forecastStore(env);
  if (forecasts.length && fstore.ready) await fstore.save(forecasts).catch(() => {});
  // Doses that did not come from a computer: said to Alexa or logged in Telegram.
  const doses = (await store.recent(null, now)).filter((d) => d.source === 'alexa' || d.source === 'telegram');
  return json({ doses: asMarkers(doses), at: now });
}

async function screensRoute(path, request, url, env, deps) {
  const store = deps.screens || screenStore(env);
  if (!store.ready) return json({ error: 'Screens are not configured' }, 503);
  if (path === 'pair/start') return json(await pairStart(request, store));
  if (path === 'pair/poll') return json(await pairPoll(request, store));
  if (path === 'screen/data' || path === 'screen/glance') {
    const screen = await screenFor(request, store, url.searchParams.get('token'));
    // An AI connector's token reads through MCP only, never the screen feeds (names, sensor dates).
    if (!screen || screen.kind === 'ai') return json({ error: 'unauthorized' }, 401);
    if (path === 'screen/glance') return glance(env, Number(url.searchParams.get('n')) || 0);
    return displayPayload(env, { screen: { name: screen.name, kind: screen.kind } });
  }
  if (path === 'share/claim') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const r = await shareClaim(request, store);
    if (!r.ok) return json(r, 400);
    // The phone also gets its own watch / widget link (GlucoDataHandler on a Pixel Watch).
    const ns = await makeNsLink(store, `${r.name} (watch)`).catch(() => null);
    return json({ ...r, nsToken: ns?.token || null });
  }
  if (path === 'share/extras') {
    // A shared phone (its own token) asks what else it can set up: its alert topic.
    const screen = await screenFor(request, store, '');
    if (!screen || !screen.role) return json({ error: 'unauthorized' }, 401);
    const night = deps.night || nightStore(env);
    let alerts = null;
    if (night.ready) {
      const row = await night.get().catch(() => null);
      const topic = row && (screen.role === 'family' ? row.care_topic : row.self_topic);
      if (topic) alerts = { topic, url: `${(env.NTFY_BASE || 'https://ntfy.sh').replace(/\/$/, '')}/${topic}`, role: screen.role, on: screen.role === 'family' ? Boolean(row.care_enabled) : Boolean(row.enabled) };
    }
    // And a one-time Telegram link for the same role, when the su94r bot is set up.
    const telegram = await telegramLinkFor(deps.telegram || telegramStore(env), screen.role).catch(() => null);
    return json({ name: screen.name, role: screen.role, alerts, telegram });
  }
  // The rest manage screens and need the display key (or a connected su94r Mini's key).
  if (!(await displayKeyOk(env, url.searchParams.get('key'), deps))) return json({ error: 'unauthorized' }, 401);
  if (path === 'share/new') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    return json(await shareNew(request, store));
  }
  if (path === 'pair/claim') return json(await pairClaim(request, store));
  if (path === 'screens') return json({ screens: await store.list() });
  if (path === 'screens/remove') {
    const { id } = await request.json().catch(() => ({}));
    if (!id) return json({ error: 'id needed' }, 400);
    await store.update(String(id), { revoked: true, token_once: null });
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}
const SCREEN_ROUTES = new Set(['pair/start', 'pair/poll', 'pair/claim', 'screen/data', 'screen/glance', 'screens', 'screens/remove', 'share/new', 'share/claim', 'share/extras']);

// One person, flattened for widget apps (KWGT, Scriptable): ready-made text and a colour.
async function glance(env, n) {
  try {
    const snap = await snapshot(env);
    const p = snap.people[Math.max(0, Math.min(n, snap.people.length - 1))];
    if (!p || !p.latest) return json({ error: 'no reading yet' }, 404);
    const l = p.latest;
    const mins = Math.max(0, Math.round((Date.now() - l.t) / 60e3));
    const stale = mins > 10;
    const mmol = p.units === 'mmol/L';
    const fmt = (mg) => (mg < 40 ? 'LO' : mg > 400 ? 'HI' : mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
    const ref = p.history.find((q) => Math.abs(q.t - (l.t - 15 * 60e3)) <= 4 * 60e3);
    const d = ref ? l.mg - ref.mg : null;
    const delta = d == null ? '' : `${d < 0 ? '\u2212' : '+'}${mmol ? Math.abs(d / 18.0182).toFixed(1) : Math.abs(Math.round(d))}`;
    const state = stale ? 'stale' : l.mg < 55 ? 'urgent' : l.mg < p.low ? 'low' : l.mg > p.high ? 'high' : 'in';
    const color = { stale: '#6e7681', urgent: '#ff5d55', low: '#ff5d55', high: '#e3a33b', in: '#3fb950' }[state];
    return json({
      name: p.firstName || p.name, value: fmt(l.mg), units: p.units, mg: l.mg, trend: l.trend,
      arrow: ['', '\u2193', '\u2198', '\u2192', '\u2197', '\u2191'][l.trend] || '',
      delta, minutes: mins, ago: mins < 1 ? 'just now' : `${mins} min ago`, state, color, t: l.t,
    });
  } catch (e) {
    return json({ error: e.message, code: e.code }, e.code === 'config' ? 503 : 502);
  }
}

export async function handleCgm(path, request, env, deps = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  try {
    if (path === 'libre/login' && request.method === 'POST') return await libreLogin(request);
    if (path === 'libre/readings' && request.method === 'POST') return await libreReadings(request);
    if (path === 'glucose/latest') return await glucoseLatest(request, env);
    if (path === 'display/data') return await displayData(url, env, deps);
    if (path === 'alexa' && request.method === 'POST') return await handleAlexa(request, env, () => snapshot(env), { store: deps.store || doseStore(env), verify: deps.verifyAlexa, forecasts: deps.forecasts || forecastStore(env) });
    if (path === 'voice/sync' && request.method === 'POST') return await voiceSync(request, url, env, deps);
    if (SCREEN_ROUTES.has(path)) return await screensRoute(path, request, url, env, deps);
    const keyOk = (k) => displayKeyOk(env, k, deps);
    const connect = await connectRoute(path, request, url, env, {
      owner: owners(env), screens: deps.screens || screenStore(env), json, keyOk,
      verify: (s) => getConnections(s),
      onSession: (s) => adoptSession(env, s),
    });
    if (connect) return connect;
    const inbox = await inboxRoute(path, request, url, env, { store: deps.inbox || inboxStore(env), json, keyOk });
    if (inbox) return inbox;
    const mcp = await mcpRoute(path, request, url, env, {
      screens: deps.screens || screenStore(env), json, keyOk,
      snapshot: () => snapshot(env),
      doses: () => (deps.store || doseStore(env)).recent(null),
    });
    if (mcp) return mcp;
    const tgStore = deps.telegram || telegramStore(env);
    const night = await nightRoute(path, request, url, env, {
      store: deps.night || nightStore(env), json, keyOk, snapshot: () => snapshot(env), push: deps.push,
      telegram: (role, msg) => telegramAlert(tgStore, role, msg, { api: deps.tgApi }),
    });
    if (night) return night;
    const tg = await telegramRoute(path, request, url, env, {
      store: tgStore, json, keyOk, snapshot: () => snapshot(env), night: deps.night || nightStore(env), api: deps.tgApi,
      doses: deps.store || doseStore(env), meal: deps.meal || ((bot, dataUrl) => askMeal(env, bot, dataUrl)), fetchImpl: deps.fetchImpl,
    });
    if (tg) return tg;
    const ns = await nightscoutRoute(path, request, url, env, { screens: deps.screens || screenStore(env), json, keyOk, snapshot: () => snapshot(env) });
    if (ns) return ns;
    return json({ error: 'not found' }, 404);
  } catch (err) {
    // The route and the error text only (never request data), so a failing route can be found.
    console.error(`su94r-cgm ${path} failed: ${String(err?.message || err).slice(0, 200)}`);
    return json({ error: String(err?.message || err).slice(0, 300) }, 500);
  }
}
