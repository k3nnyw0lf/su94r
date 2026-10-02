// A Nightscout-compatible read-only feed, so watch faces and phone apps that read Nightscout
// (GlucoDataHandler on a Pixel Watch, xDrip+ followers, Juggluco, Sugarmate-style widgets)
// can show your su94r glucose without being given your LibreLinkUp password.
//
// su94r Mini makes the link (POST ns/new with the display key). In the app, set the
// Nightscout URL to https://<your su94r server>/ns and the token (or API secret) to the token.
// It is stored like a paired widget, so it shows in the screens list and is removed there.
//
// Routes: ns/pebble, ns/api/v1/entries/current.json, ns/api/v1/entries/sgv.json,
// ns/api/v1/entries.json, ns/api/v1/status.json. Auth: ?token=<token>, or an api-secret
// header holding the SHA-1 of the token (how Nightscout clients send a secret).

import { randomToken, sha256 } from './screens.js';

// LibreLinkUp trend (1 falling fast … 5 rising fast) → Nightscout direction and number.
const DIRECTION = { 1: 'SingleDown', 2: 'FortyFiveDown', 3: 'Flat', 4: 'FortyFiveUp', 5: 'SingleUp' };
const TREND_NUM = { DoubleUp: 1, SingleUp: 2, FortyFiveUp: 3, Flat: 4, FortyFiveDown: 5, SingleDown: 6, DoubleDown: 7, 'NOT COMPUTABLE': 8 };

async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const entry = (p) => {
  const direction = DIRECTION[p.trend] || 'NONE';
  return { _id: `su94r-${p.t}`, type: 'sgv', sgv: Math.round(p.mg), date: p.t, dateString: new Date(p.t).toISOString(), direction, trend: TREND_NUM[direction] ?? 0, device: 'su94r', noise: 1 };
};

/** The person's readings, newest first, each with a direction (the latest has LibreLinkUp's own). */
function series(person) {
  const hist = [...person.history].sort((a, b) => b.t - a.t);
  return hist.map((p, i) => {
    if (p.trend) return p;
    const older = hist.slice(i + 1).find((q) => p.t - q.t >= 10 * 60e3 && p.t - q.t <= 20 * 60e3);
    if (!older) return { ...p, trend: 3 };
    const perMin = (p.mg - older.mg) / ((p.t - older.t) / 60e3);
    return { ...p, trend: perMin <= -2 ? 1 : perMin <= -1 ? 2 : perMin < 1 ? 3 : perMin < 2 ? 4 : 5 };
  });
}

/** A new token for a watch or app that reads Nightscout; stored like a paired widget. */
export async function makeNsLink(screens, name) {
  const token = randomToken();
  const id = crypto.randomUUID();
  const label = String(name || 'Watch (Nightscout link)').replace(/[^\p{L}\p{N} '.()-]/gu, '').trim().slice(0, 40) || 'Watch (Nightscout link)';
  const now = new Date().toISOString();
  await screens.insert({ id, secret_hash: await sha256(await sha1(token)), token_hash: await sha256(token), kind: 'widget', name: label, expires_at: now, claimed_at: now });
  return { id, token, name: label };
}

/** Handles ns/* routes; null when the path is not one. */
export async function nightscoutRoute(path, request, url, env, { screens, json, keyOk, snapshot }) {
  if (path !== 'ns' && !path.startsWith('ns/')) return null;
  if (!screens.ready) return json({ error: 'not configured' }, 503);
  if (path === 'ns/new') {
    if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const { name } = await request.json().catch(() => ({}));
    return json(await makeNsLink(screens, name));
  }

  // Auth: the token itself (?token=), or its SHA-1 as api-secret (matched by the stored hash of the SHA-1).
  const q = (url.searchParams.get('token') || request.headers.get('x-ns-token') || '').trim();
  const secretHeader = (request.headers.get('api-secret') || '').trim().toLowerCase();
  let row = null;
  if (/^[0-9a-f]{64}$/.test(q)) row = await screens.byToken(await sha256(q));
  else if (/^[0-9a-f]{40}$/.test(secretHeader)) row = await screens.bySecret(await sha256(secretHeader));
  if (!row || row.kind !== 'widget') return json({ status: 401, message: 'Unauthorized' }, 401);
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 60e3) screens.update(row.id, { last_seen: new Date().toISOString() }).catch(() => {});

  const sub = path.slice(3).replace(/\/$/, '');
  if (sub === 'api/v1/status.json' || sub === 'api/v1/status') {
    return json({ status: 'ok', name: 'su94r', version: '15.0.0-su94r', serverTime: new Date().toISOString(), apiEnabled: true, settings: { units: 'mg/dl', thresholds: { bgHigh: 260, bgTargetTop: 180, bgTargetBottom: 70, bgLow: 55 } } });
  }
  const snap = await snapshot();
  const n = Math.max(0, Math.min(Number(url.searchParams.get('n')) || 0, snap.people.length - 1));
  const person = snap.people[n];
  if (!person?.latest) return json([], 200);
  const all = series(person);
  if (sub === 'pebble') {
    const [now, prev] = all;
    const delta = prev && now.t - prev.t <= 20 * 60e3 ? now.mg - prev.mg : null;
    return json({
      status: [{ now: Date.now() }],
      bgs: [{ sgv: String(Math.round(now.mg)), trend: TREND_NUM[DIRECTION[now.trend]] ?? 0, direction: DIRECTION[now.trend] || 'NONE', datetime: now.t, bgdelta: delta == null ? '0' : `${delta >= 0 ? '+' : ''}${Math.round(delta)}` }],
      cals: [],
    });
  }
  if (sub === 'api/v1/entries/current.json' || sub === 'api/v1/entries/current') return json([entry(all[0])]);
  if (sub === 'api/v1/entries/sgv.json' || sub === 'api/v1/entries.json' || sub === 'api/v1/entries/sgv' || sub === 'api/v1/entries') {
    const count = Math.max(1, Math.min(Number(url.searchParams.get('count')) || 10, 288));
    const gt = Number(url.searchParams.get('find[date][$gt]') || url.searchParams.get('find[date][$gte]')) || 0;
    return json(all.filter((p) => p.t > gt).slice(0, count).map((p) => entry(p)));
  }
  return json({ status: 404, message: 'Not found' }, 404);
}
