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
// The graph is drawn twice: 300 × 100 for the normal tile, 300 × 200 for the right half of the wide one.
const W = 300, H = 100, HW = 200, SPAN = 3 * 3600e3;
const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const STORE_URL = 'https://api.amazonalexa.com/v1/datastore/commands';

export const widgetReady = (env) => Boolean(env.ALEXA_CLIENT_ID && env.ALEXA_CLIENT_SECRET);

const shown = (mg, units) => (mg < 40 ? 'LO' : mg > 400 ? 'HI' : units === 'mmol/L' ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));

/** The owner's night hours from the su94r_night row (the tile dims then, except during a low). */
export const nightHours = (row) => ({
  nightStart: Number.isFinite(row?.night_start) ? row.night_start : 22,
  nightEnd: Number.isFinite(row?.night_end) ? row.night_end : 7,
});

/** What the tile shows for one person: the number, arrow, colour, change, the last 12 hours' range and time in range,
 * sensor hours left, active insulin and last carbs (when given), and the last 3 hours as path data (300 × 100). */
export function widgetContent(p, now = Date.now(), { nightStart = 22, nightEnd = 7, sensorDays = 14, extra = null } = {}) {
  const l = p?.latest;
  if (!l) return { has: false, title: p?.firstName || 'Glucose', nightStart, nightEnd };
  const status = l.mg < 55 ? 'urgent' : l.mg < p.low ? 'low' : l.mg > p.high ? 'high' : 'in';
  // The change over 15 minutes: from the reading nearest to 15 minutes before this one (8 to 22
  // minutes back, so a missed reading does not hide it), scaled to 15 minutes.
  const ref = (p.history || []).filter((q) => { const back = l.t - q.t; return back >= 8 * 60e3 && back <= 22 * 60e3; })
    .sort((a, b) => Math.abs(l.t - a.t - 15 * 60e3) - Math.abs(l.t - b.t - 15 * 60e3))[0];
  const d = ref ? ((l.mg - ref.mg) * 15 * 60e3) / (l.t - ref.t) : null;
  const dv = d == null ? '' : p.units === 'mmol/L' ? Math.abs(d / 18.0182).toFixed(1) : String(Math.round(Math.abs(d)));
  const delta = d == null ? '' : `${Number(dv) === 0 ? '' : d < 0 ? '−' : '+'}${dv}`;
  const pts = (p.history || []).filter((q) => q.t >= now - SPAN && q.t <= now).sort((a, b) => a.t - b.t);
  // The scale follows the readings (a quiet 140–160 afternoon is not a flat line) and always
  // keeps the target band in view.
  const mgs = pts.map((q) => q.mg);
  const lo = Math.max(40, Math.min(p.low - 15, ...mgs.map((m) => m - 15)));
  const hi = Math.min(400, Math.max(p.high + 15, ...mgs.map((m) => m + 15)));
  const x = (t) => (((t - (now - SPAN)) / SPAN) * W).toFixed(0);
  const y = (v, h = H) => (h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h).toFixed(0);
  // The last 12 hours (what the sensor's graph holds): time in range, lowest and highest.
  const day = (p.history || []).filter((q) => q.t >= now - 12 * 3600e3 && q.t <= now);
  const tir = day.length >= 12 ? Math.round((day.filter((q) => q.mg >= p.low && q.mg <= p.high).length / day.length) * 100) : null;
  const sensorEnds = p.sensorStart ? p.sensorStart + sensorDays * 24 * 3600e3 : null;
  const meal = extra?.meal && now - extra.meal.t < 6 * 3600e3 ? extra.meal : null;
  // A point every 5 minutes is plenty for a tile and keeps the command small.
  const thin = pts.filter((q, i) => i === pts.length - 1 || !pts[i + 1] || Math.floor(q.t / 300e3) !== Math.floor(pts[i + 1].t / 300e3));
  const path = (h) => (thin.length > 1 ? thin.map((q, i) => `${i ? 'L' : 'M'}${x(q.t)},${y(q.mg, h)}`).join(' ') : '');
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
    nightStart,
    nightEnd,
    tir,
    lo12: day.length ? shown(Math.min(...day.map((q) => q.mg)), p.units) : '',
    hi12: day.length ? shown(Math.max(...day.map((q) => q.mg)), p.units) : '',
    sensorH: sensorEnds && sensorEnds > now ? Math.round((sensorEnds - now) / 3600e3) : null,
    iob: extra?.iob > 0.05 ? Math.round(extra.iob * 10) / 10 : null,
    mealG: meal && Number.isFinite(meal.g) ? Math.round(meal.g) : null,
    mealT: meal ? meal.t : null,
    range: `${shown(p.low, p.units)}–${shown(p.high, p.units)}`,
    line: path(H),
    band: `M0,${y(p.high)} L${W},${y(p.high)} L${W},${y(p.low)} L0,${y(p.low)} Z`,
    lineW: path(HW),
    bandW: `M0,${y(p.high, HW)} L${W},${y(p.high, HW)} L${W},${y(p.low, HW)} L0,${y(p.low, HW)} Z`,
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
export async function widgetTick(env, row, people, state, { push = pushWidget, extra = null, now = Date.now() } = {}) {
  const p = people[0];
  if (!row?.alexa_widget_user || !widgetReady(env) || !p?.latest) return null;
  const meta = state._meta || {};
  if (meta.widgetT === p.latest.t && now - (meta.widgetAt || 0) < 30 * 60e3) return null;
  const r = await push(env, row.alexa_widget_user, widgetContent(p, now, { ...nightHours(row), sensorDays: row?.sensor_days || 14, extra }), { now });
  if (r.ok) state._meta = { ...(state._meta || {}), widgetT: p.latest.t, widgetAt: now };
  return { label: 'echo tile', ok: r.ok, ...(r.ok ? {} : { error: String(r.error || r.status) }) };
}
