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
//
// The owner's own phone ('me') logs. A family member's phone reads, and logs too once the owner
// allows it (su94r_screens.can_log: su94r Mini, or the owner's phone here). Paired TVs and widgets
// (no role) and every other token get none of this.

import { screenFor } from './screens.js';
import { asMarkers } from './doses.js';
import { reportFor } from './doctor.js';
import { doubleDoseWarning, kindWord } from '../extension/insulin.js';

export const APP_PATHS = new Set(['app/me', 'app/history', 'app/report', 'app/recent', 'app/log', 'app/undo', 'app/phones', 'app/phones/allow']);
const MIN = 60e3, DAY = 864e5;
const KINDS = new Set(['rapid', 'short', 'intermediate', 'basal', 'mix', 'carbs']);
export const APP_MAX_UNITS = 100;
export const APP_MAX_GRAMS = 300;
const UNDO_MS = 30 * MIN;
const FRESH_MS = 20 * MIN;

export async function appRoute(path, request, url, env, { screens, history, doses, forecasts, snapshot, json, now = Date.now() }) {
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
    return json({ events: events.map((e) => ({ ...e, by: by(e.id), mine: e.id.startsWith(mine) && now - createdAt(e.id) < UNDO_MS })), estimates, at: now });
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
