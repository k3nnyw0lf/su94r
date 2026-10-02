// The su94r phone app's server side. The page itself (workers/app-page.js) is served by
// su94r-proxy at /app/; it uses the token the phone got when it scanned a share code from
// su94r Mini (screens.js: kind 'screen' with role 'me' or 'family').
//
//   GET  app/me                     who this phone is, the people, whether it may log
//   GET  app/history?days=14        readings from the server's own history (history.js), 1–90 days
//   GET  app/report?pid=            the 14-day report (doctor.js reportFor)
//   GET  app/recent                 doses and meals of the last 48 hours, and fresh estimates
//   POST app/log                    { kind, amount, minutesAgo, pid, confirm } → logs, or asks to confirm
//   POST app/undo                   { id } → removes a dose this phone logged in the last 30 minutes
//   GET  app/phones                 (owner's phone) the family phones and whether each may log
//   POST app/phones/allow           (owner's phone) { id, canLog }
//   GET  app/push/key               the server's public key for app alerts (webpush.js)
//   POST app/push/subscribe         { endpoint, keys: { p256dh, auth } } this phone's alerts on
//   POST app/push/unsubscribe       { endpoint }
//   POST app/push/test              a test alert to this phone
//   POST app/treat                  { grams, pid } a low treated: logs the carbs, stops the reminders,
//                                   rechecks after the owner's plan's minutes (night.js)
//
// The owner's own phone ('me') logs. A family member's phone reads, and logs too once the owner
// allows it (su94r_screens.can_log: su94r Mini, or the owner's phone here). Paired TVs and widgets
// (no role) and every other token get none of this.

import { screenFor } from './screens.js';
import { asMarkers } from './doses.js';
import { reportFor } from './doctor.js';
import { doubleDoseWarning, kindWord } from '../extension/insulin.js';
import { pushTo, pushEndpointOk } from './webpush.js';
import { startTreatment, NIGHT_DEFAULTS } from './night.js';

export const APP_PATHS = new Set(['app/me', 'app/history', 'app/report', 'app/recent', 'app/log', 'app/undo', 'app/phones', 'app/phones/allow',
  'app/push/key', 'app/push/subscribe', 'app/push/unsubscribe', 'app/push/test', 'app/treat']);
const MIN = 60e3, DAY = 864e5;
const KINDS = new Set(['rapid', 'short', 'intermediate', 'basal', 'mix', 'carbs']);
export const APP_MAX_UNITS = 100;
export const APP_MAX_GRAMS = 300;
const UNDO_MS = 30 * MIN;
const FRESH_MS = 20 * MIN;

export async function appRoute(path, request, url, env, { screens, history, doses, forecasts, snapshot, json, night = null, push = null, notify = null, now = Date.now() }) {
  if (!APP_PATHS.has(path)) return null;
  if (!screens.ready) return json({ error: 'not configured' }, 503);
  const screen = await screenFor(request, screens, '');
  if (!screen || screen.kind !== 'screen' || (screen.role !== 'me' && screen.role !== 'family')) return json({ error: 'unauthorized' }, 401);
  const owner = screen.role === 'me';
  const canLog = owner || screen.can_log === true;
  let list = null;
  const people = async () => {
    if (!list) { try { list = (await snapshot()).people || []; } catch { list = []; } }
    return list;
  };
  const pidFor = async (want) => { const l = await people(); return (l.find((p) => p.pid === want) || l[0])?.pid || ''; };

  if (path === 'app/me') {
    return json({
      name: screen.name || '', role: screen.role, canLog,
      people: (await people()).map((p) => ({ pid: p.pid, name: p.firstName || p.name, units: p.units, low: p.low, high: p.high, sensorStart: p.sensorStart || null })),
    });
  }

  if (path === 'app/history') {
    if (!history?.ready) return json({ error: 'The server history is not set up' }, 503);
    const days = Math.min(90, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 1)));
    const points = {};
    for (const p of await people()) {
      const rows = await history.range(p.pid, now - days * DAY, now + MIN);
      // Past two weeks, one reading per 15 minutes is plenty for a phone screen.
      const step = days > 14 ? 15 * MIN : 0;
      let last = -Infinity;
      points[p.pid] = [];
      for (const r of rows) if (r.t - last >= step) { points[p.pid].push([r.t, r.mg]); last = r.t; }
    }
    return json({ days, points });
  }

  if (path === 'app/report') {
    const pid = await pidFor(url.searchParams.get('pid'));
    if (!pid) return json({ error: 'No one to report on yet.' }, 404);
    return json(await reportFor(pid, { history, doses, snapshot, now }));
  }

  if (path === 'app/recent') {
    const l = await people();
    const known = new Set(l.map((p) => p.pid));
    let events = [];
    try { if (doses?.ready) events = asMarkers((await doses.recent(null, now)).filter((d) => known.has(d.pid))); } catch { /* none */ }
    const estimates = {};
    for (const p of l) {
      try {
        const f = forecasts?.ready ? await forecasts.get(p.pid) : null;
        if (f && f.trusted && now - f.at <= FRESH_MS) estimates[p.pid] = { at: f.at, mg: f.mg, h30: f.h30 || null, h60: f.h60 || null };
      } catch { /* no estimate */ }
    }
    const mine = `app-${screen.id.slice(0, 8)}-`;
    // Which phone logged what ("phone · Mom"), from the linked phones' names.
    const names = {};
    try { for (const s of await screens.list()) if (s.kind === 'screen' && s.role) names[`app-${String(s.id).slice(0, 8)}-`] = s.name || ''; } catch { /* without names */ }
    const by = (id) => (id.startsWith('app-') ? names[id.slice(0, 13)] || '' : '');
    // The low treatment plan, an open low per person, and a treatment waiting for its recheck.
    let row = null;
    try { if (night?.ready) row = await night.get(); } catch { /* without */ }
    const st = row?.state || {};
    const lows = {}, treating = {};
    for (const p of l) {
      const ep = st[p.pid];
      if (ep && ep.since) lows[p.pid] = { since: ep.since, acked: Boolean(ep.ackAt), lastMg: ep.lastMg ?? null };
      const tr = (st._treat || {})[p.pid];
      if (tr && now - tr.t < 3 * 60 * MIN) treating[p.pid] = { t: tr.t, grams: tr.grams, by: tr.by || '', recheckAt: tr.recheckAt, done: Boolean(tr.done) };
    }
    const plan = { grams: row?.treat_grams ?? NIGHT_DEFAULTS.treat_grams, minutes: row?.treat_minutes ?? NIGHT_DEFAULTS.treat_minutes, text: row?.treat_plan || '' };
    return json({ events: events.map((e) => ({ ...e, by: by(e.id), mine: e.id.startsWith(mine) && now - createdAt(e.id) < UNDO_MS })), estimates, lows, treating, plan, at: now });
  }

  // The owner's phone decides which family phones may log.
  if (path === 'app/phones' || path === 'app/phones/allow') {
    if (!owner) return json({ error: 'Only the owner\'s own phone can change this.' }, 403);
    if (path === 'app/phones') {
      const phones = (await screens.list()).filter((s) => s.kind === 'screen' && s.role === 'family')
        .map((s) => ({ id: s.id, name: s.name || 'Family phone', canLog: s.can_log === true, lastSeen: s.last_seen || null }));
      return json({ phones });
    }
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const b = await request.json().catch(() => ({}));
    if (!b.id) return json({ error: 'id needed' }, 400);
    return (await screens.allowLog(String(b.id), b.canLog === true)) ? json({ ok: true, canLog: b.canLog === true }) : json({ ok: false, error: 'Only a family member\'s phone can be allowed to log.' }, 404);
  }

  // App alerts: any linked phone (family phones get what the care ladder sends them).
  if (path.startsWith('app/push/')) {
    if (!push?.ready) return json({ error: 'App alerts are not set up on the server.' }, 503);
    if (path === 'app/push/key') return json({ key: await push.publicKey() });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const b = await request.json().catch(() => ({}));
    if (path === 'app/push/subscribe') {
      const endpoint = String(b.endpoint || ''), p256dh = String(b.keys?.p256dh || ''), auth = String(b.keys?.auth || '');
      if (!pushEndpointOk(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
        return json({ ok: false, error: 'This browser gave an alert address su94r does not send to.' }, 400);
      }
      await push.add(screen.id, { endpoint, p256dh, auth });
      return json({ ok: true });
    }
    if (path === 'app/push/unsubscribe') { await push.remove(screen.id, String(b.endpoint || '')); return json({ ok: true }); }
    const sent = await pushTo(push, await push.forScreen(screen.id), {
      title: 'su94r test alert', priority: 4,
      message: owner ? 'Lows ring on this phone, with an "I\'m OK" button.' : 'This phone rings when a low is not handled.',
    });
    return sent ? json({ ok: true }) : json({ ok: false, error: 'The test did not go out. Turn app alerts off and on again.' }, 502);
  }

  // Logging: the owner's own phone, and family phones the owner allowed.
  if (!canLog) return json({ error: 'This phone can\'t log yet. The owner can allow it in su94r Mini (Share to another phone) or in their own su94r app (More).' }, 403);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!doses?.ready) return json({ error: 'The dose store is not set up' }, 503);
  const body = await request.json().catch(() => ({}));

  if (path === 'app/log') {
    const kind = String(body.kind || '');
    const carbs = kind === 'carbs';
    const raw = Number(body.amount);
    const amount = carbs ? Math.round(raw) : Math.round(raw * 2) / 2;
    const minutesAgo = Math.round(Number(body.minutesAgo) || 0);
    if (!KINDS.has(kind)) return json({ ok: false, error: 'Pick insulin or carbs.' }, 400);
    if (!(amount > 0) || amount > (carbs ? APP_MAX_GRAMS : APP_MAX_UNITS)) {
      return json({ ok: false, error: carbs ? `Carbs must be between 1 and ${APP_MAX_GRAMS} g.` : `Insulin must be between 0.5 and ${APP_MAX_UNITS} units.` }, 400);
    }
    if (minutesAgo < 0 || minutesAgo > 24 * 60) return json({ ok: false, error: 'The time must be within the last 24 hours.' }, 400);
    const pid = await pidFor(String(body.pid || ''));
    if (!pid) return json({ ok: false, error: 'No one to log for yet.' }, 400);
    const t = now - minutesAgo * MIN;
    if (!carbs && body.confirm !== true) {
      let warning = null;
      try { warning = doubleDoseWarning(asMarkers(await doses.recent(pid, now)), pid, { t, kind }, {}, now); } catch { /* a warning, never a block */ }
      if (warning) return json({ ok: false, confirm: true, warning });
    }
    const id = `app-${screen.id.slice(0, 8)}-${now.toString(36)}`;
    await doses.upsert([{ id, pid, t, kind, amount, source: 'phone' }]);
    const what = carbs ? `${amount} g of carbs` : `${amount} ${amount === 1 ? 'unit' : 'units'} of ${kindWord(kind)} insulin`;
    return json({ ok: true, id, t, text: `Logged ${what}${minutesAgo ? `, ${minutesAgo} min ago` : ''}.` });
  }

  if (path === 'app/treat') {
    const grams = Math.round(Number(body.grams));
    if (!(grams >= 1 && grams <= 100)) return json({ ok: false, error: 'Between 1 and 100 g.' }, 400);
    if (!night?.ready) return json({ ok: false, error: 'Low alerts are not set up on the server.' }, 503);
    const pid = await pidFor(String(body.pid || ''));
    if (!pid) return json({ ok: false, error: 'No one to log for yet.' }, 400);
    const person = (await people()).find((p) => p.pid === pid) || {};
    const row = await night.get();
    const id = `app-${screen.id.slice(0, 8)}-${now.toString(36)}`;
    await doses.upsert([{ id, pid, t: now, kind: 'carbs', amount: grams, source: 'phone' }]);
    const t = startTreatment(row, pid, { now, grams, by: screen.name, mg: person.latest?.mg ?? null });
    await night.patch({ state: t.state });
    // Caregivers who were told about this low hear that it is being handled.
    if (t.ep?.careRung && row.care_enabled && notify) {
      const at = new Date(now).toLocaleTimeString('en-US', { timeZone: row.time_zone || 'America/New_York', hour: 'numeric', minute: '2-digit' });
      await notify(row, 'family', { title: `${person.firstName || person.name || 'They'} ${person.firstName || person.name ? 'is' : 'are'} treating the low`, message: `${grams} g at ${at}${screen.name ? ` (logged on ${screen.name})` : ''}.`, priority: 3, tags: ['white_check_mark'] }).catch(() => {});
    }
    return json({ ok: true, id, recheckAt: t.recheckAt, text: `Logged ${grams} g. Reminders stop; recheck in ${Math.round((t.recheckAt - now) / MIN)} min.` });
  }

  if (path === 'app/undo') {
    const id = String(body.id || '');
    if (!id.startsWith(`app-${screen.id.slice(0, 8)}-`) || !(now - createdAt(id) < UNDO_MS)) {
      return json({ ok: false, error: 'Only a dose this phone logged in the last 30 minutes can be undone here.' }, 400);
    }
    await doses.markDeleted([id]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

/** When an app-logged dose was saved (its id ends in the time, base 36). */
function createdAt(id) {
  const t = parseInt(String(id).split('-').pop(), 36);
  return Number.isFinite(t) ? t : 0;
}
