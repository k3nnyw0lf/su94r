// The Echo Show home-screen tile (an Alexa widget). The tile itself is an APL
// package inside the skill (docs/alexa/dataStorePackages/su94r-glucose); it shows
// whatever sits on the device under namespace "su94r", key "glucose". This file
// builds that object from a snapshot person and sends it with Amazon's Data Store
// API (POST /v1/datastore/commands), using the skill's own messaging credentials
// (SU94R_ALEXA_CLIENT_ID / SU94R_ALEXA_CLIENT_SECRET: developer console → My Sugar
// → Build → Permissions → Alexa Skill Messaging). Alexa tells the skill when the
// tile is added (Alexa.DataStore.PackageManager.UsagesInstalled); alexa.js keeps
// that Amazon user id in su94r_night.alexa_widget_user, and the night tick sends
// each new reading to it.

export const WIDGET_NS = 'su94r';
export const WIDGET_KEY = 'glucose';
const ARROWS = ['', '↓', '↘', '→', '↗', '↑'];
const W = 300, H = 100, SPAN = 3 * 3600e3;
const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const STORE_URL = 'https://api.amazonalexa.com/v1/datastore/commands';

export const widgetReady = (env) => Boolean(env.ALEXA_CLIENT_ID && env.ALEXA_CLIENT_SECRET);

const shown = (mg, units) => (mg < 40 ? 'LO' : mg > 400 ? 'HI' : units === 'mmol/L' ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));

/** What the tile shows for one person: the number, arrow, colour, time and the last 3 hours as path data (300 × 100). */
export function widgetContent(p, now = Date.now()) {
  const l = p?.latest;
  if (!l) return { has: false, title: p?.firstName || 'Glucose' };
  const status = l.mg < 55 ? 'urgent' : l.mg < p.low ? 'low' : l.mg > p.high ? 'high' : 'in';
  // The change over the last 15 minutes, from the reading closest to 15 minutes before this one (within 5).
  const ref = (p.history || []).filter((q) => Math.abs(q.t - (l.t - 15 * 60e3)) <= 5 * 60e3)
    .sort((a, b) => Math.abs(a.t - (l.t - 15 * 60e3)) - Math.abs(b.t - (l.t - 15 * 60e3)))[0];
  const d = ref ? l.mg - ref.mg : null;
  const delta = d == null ? '' : `${d < 0 ? '−' : '+'}${p.units === 'mmol/L' ? Math.abs(d / 18.0182).toFixed(1) : Math.abs(Math.round(d))}`;
  const pts = (p.history || []).filter((q) => q.t >= now - SPAN && q.t <= now).sort((a, b) => a.t - b.t);
  const hi = Math.max(300, ...pts.map((q) => q.mg));
  const x = (t) => (((t - (now - SPAN)) / SPAN) * W).toFixed(0);
  const y = (v) => (H - ((Math.min(hi, Math.max(40, v)) - 40) / (hi - 40)) * H).toFixed(0);
  // A point every 5 minutes is plenty for a tile and keeps the command small.
  const thin = pts.filter((q, i) => i === pts.length - 1 || !pts[i + 1] || Math.floor(q.t / 300e3) !== Math.floor(pts[i + 1].t / 300e3));
  return {
    has: true,
    title: p.firstName || 'Glucose',
    value: shown(l.mg, p.units),
    units: p.units,
    arrow: ARROWS[l.trend] || '',
    status,
    color: { urgent: '#ff5d55', low: '#ff5d55', high: '#e3a33b', in: '#3fb950' }[status],
    t: l.t,
    delta,
    line: thin.length > 1 ? thin.map((q, i) => `${i ? 'L' : 'M'}${x(q.t)},${y(q.mg)}`).join(' ') : '',
    band: `M0,${y(p.high)} L${W},${y(p.high)} L${W},${y(p.low)} L0,${y(p.low)} Z`,
  };
}

let cached = null;   // { token, until } for the life of the function instance
export const resetWidgetToken = () => { cached = null; };

async function accessToken(env, fetchImpl, now) {
  if (cached && cached.until > now) return cached.token;
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // Pasted secrets often carry a space or line break; Amazon then answers invalid_client.
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(env.ALEXA_CLIENT_ID).trim(), client_secret: String(env.ALEXA_CLIENT_SECRET).trim(), scope: 'alexa::datastore' }).toString(),
  });
  if (!res.ok) {
    const why = await res.json().then((j) => String(j.error || '').replace(/[^a-z_]/gi, '').slice(0, 40)).catch(() => '');
    throw new Error(`token ${res.status}${why ? ` ${why}` : ''}`);
  }
  const j = await res.json();
  cached = { token: j.access_token, until: now + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return cached.token;
}

/** Sends `content` to every Echo of the Amazon user `userId`. Returns { ok, status, results }. */
export async function pushWidget(env, userId, content, { fetchImpl = (...a) => fetch(...a), now = Date.now() } = {}) {
  if (!widgetReady(env)) return { ok: false, error: 'not configured' };
  if (!userId) return { ok: false, error: 'no tile installed' };
  const send = async () => fetchImpl(STORE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken(env, fetchImpl, now)}` },
    body: JSON.stringify({
      commands: [{ type: 'PUT_OBJECT', namespace: WIDGET_NS, key: WIDGET_KEY, content }],
      target: { type: 'USER', id: userId },
      attemptDeliveryUntil: new Date(now + 15 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }),
  });
  let res = await send();
  if (res.status === 401) { cached = null; res = await send(); }
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, results: (j.results || []).map((r) => r.type) };
}

/** In the night tick: send a new reading (or the same one every 30 minutes, so a tile added offline catches up). */
export async function widgetTick(env, row, people, state, { push = pushWidget, now = Date.now() } = {}) {
  const p = people[0];
  if (!row?.alexa_widget_user || !widgetReady(env) || !p?.latest) return null;
  const meta = state._meta || {};
  if (meta.widgetT === p.latest.t && now - (meta.widgetAt || 0) < 30 * 60e3) return null;
  const r = await push(env, row.alexa_widget_user, widgetContent(p, now), { now });
  if (r.ok) state._meta = { ...(state._meta || {}), widgetT: p.latest.t, widgetAt: now };
  return { label: 'echo tile', ok: r.ok, ...(r.ok ? {} : { error: String(r.error || r.status) }) };
}
