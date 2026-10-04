// The su94r phone app's server side. The page itself (workers/app-page.js) is served by
// su94r-proxy at /app/; it uses the token the phone got when it scanned a share code from
// su94r Mini (screens.js: kind 'screen' with role 'me' or 'family').
//
//   GET  app/me                     who this phone is, the people, whether it may log
//   GET  app/history?days=14        readings from the server's own history (history.js), 1–90 days
//   GET  app/report?pid=            the 14-day report (doctor.js reportFor)
//   GET  app/recent                 doses and meals of the last 48 hours, and fresh estimates
//   POST app/log                    { kind, amount, minutesAgo | at, pid, confirm, cid, meal } → logs, or asks to
//                                   confirm; cid (made on the phone) makes a resend after lost signal harmless;
//                                   meal (a name, with carbs) keeps it as a favorite
//   POST app/edit                   { id, amount, kind, minutesAgo } changes a logged dose or meal
//   POST app/remove                 { id } removes one (this phone's own of the last 24 hours; the owner's
//                                   phone also any from a phone, Alexa or Telegram of the last 48 hours)
//   GET  app/food?barcode=          carbs from a barcode (food.js, Open Food Facts)
//   GET  app/meals?pid=             favorite meals; POST app/meals/remove { id }
//   GET  app/notes?pid=&days=       notes with tags (notes.js); POST app/note { text, tags, minutesAgo | at, cid },
//                                   app/notes/remove { id }
//   POST app/undo                   { id } → removes a dose this phone logged in the last 30 minutes
//   GET  app/phones                 (owner's phone) the family phones and whether each may log
//   POST app/phones/allow           (owner's phone) { id, canLog }
//   GET  app/push/key               the server's public key for app alerts (webpush.js)
//   POST app/push/subscribe         { endpoint, keys: { p256dh, auth } } this phone's alerts on
//   POST app/push/unsubscribe       { endpoint }
//   POST app/push/test              a test alert to this phone
//   POST app/treat                  { grams, pid } a low treated: logs the carbs, stops the reminders,
//                                   rechecks after the owner's plan's minutes (night.js)
//   GET  app/patterns?pid=          what repeats in the last 14 days (extension/patterns.js)
//   POST app/parse                  { text } what a spoken "4 units rapid" means (nothing is logged)
//   GET  app/labs?pid=              lab results (labs.js); POST app/labs/save, app/labs/remove
//   GET  app/supplies?pid=          insulin and sensors on hand (supplies.js)
//   POST app/supplies/save          { pid, item, onHand, warnAt, refillOn }
//   POST app/supplies/remove        { pid, item }
//   POST app/mode                   { mode: 'exercise'|'sick'|'off', hours } (night.js modes)
//   POST app/ack                    "I'm OK" for every open low (the bedside screen)
//   GET  app/emergency              (owner's phone) the emergency card (emergency.js); POST
//                                   app/emergency/save, app/emergency/new, app/emergency/remove
//
// The owner's own phone ('me') logs. A family member's phone reads, and logs too once the owner
// allows it (su94r_screens.can_log: su94r Mini, or the owner's phone here). Paired TVs and widgets
// (no role) and every other token get none of this.

import { screenFor } from './screens.js';
import { asMarkers } from './doses.js';
import { reportFor } from './doctor.js';
import { doubleDoseWarning, kindWord } from '../extension/insulin.js';
import { pushTo, pushEndpointOk } from './webpush.js';
import { startTreatment, NIGHT_DEFAULTS, activeMode, modeFields, acknowledgeAll, EXERCISE_MARGIN } from './night.js';
import { emergencyManage } from './emergency.js';
import { supplyStatus, supplyRow } from './supplies.js';
import { labRow } from './labs.js';
import { parseLog } from './tglog.js';
import { findPatterns } from '../extension/patterns.js';
import { asMarkers as markersOf } from './doses.js';
import { foodByBarcode } from './food.js';
import { noteRow } from './notes.js';

export const APP_PATHS = new Set(['app/me', 'app/history', 'app/report', 'app/recent', 'app/log', 'app/undo', 'app/phones', 'app/phones/allow',
  'app/push/key', 'app/push/subscribe', 'app/push/unsubscribe', 'app/push/test', 'app/treat', 'app/supplies', 'app/supplies/save', 'app/supplies/remove',
  'app/parse', 'app/labs', 'app/labs/save', 'app/labs/remove', 'app/patterns', 'app/mode', 'app/ack',
  'app/emergency', 'app/emergency/save', 'app/emergency/new', 'app/emergency/remove',
  'app/edit', 'app/remove', 'app/food', 'app/meals', 'app/meals/remove', 'app/notes', 'app/note', 'app/notes/remove']);
const MIN = 60e3, DAY = 864e5;
const KINDS = new Set(['rapid', 'short', 'intermediate', 'basal', 'mix', 'carbs']);
export const APP_MAX_UNITS = 100;
export const APP_MAX_GRAMS = 300;
const UNDO_MS = 30 * MIN;
const FRESH_MS = 20 * MIN;

export async function appRoute(path, request, url, env, { screens, history, doses, forecasts, snapshot, json, night = null, push = null, notify = null, supplies = null, labs = null, meals = null, notes = null, fetchImpl, now = Date.now() }) {
  if (!APP_PATHS.has(path)) return null;
  if (!screens.ready) return json({ error: 'not configured' }, 503);
  const screen = await screenFor(request, screens, '');
  if (!screen || screen.kind !== 'screen' || (screen.role !== 'me' && screen.role !== 'family')) return json({ error: 'unauthorized' }, 401);
  const owner = screen.role === 'me';
  // The app sends its language; only the words change.
  const es = /^es/i.test(request.headers.get('x-su94r-lang') || '');
  const T = (en, sp) => (es ? sp : en);
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
    let tz;
    try { if (night?.ready) tz = (await night.get()).time_zone; } catch { /* default */ }
    return json(await reportFor(pid, { history, doses, snapshot, labs, notes, tz, now, lang: es ? 'es' : 'en' }));
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
    let recentNotes = [];
    try { if (notes?.ready) for (const p of l) recentNotes.push(...await notes.between(p.pid, now - 2 * DAY, now + MIN)); } catch { recentNotes = []; }
    const noteMine = `note-${screen.id.slice(0, 8)}-`;
    const mode = activeMode(row, now);
    const canEdit = (e) => canLog && ((e.id.startsWith(mine) && now - createdAt(e.id) < DAY) || (owner && e.source !== 'extension'));
    return json({ events: events.map((e) => ({ ...e, by: by(e.id), mine: e.id.startsWith(mine) && now - createdAt(e.id) < UNDO_MS, edit: canEdit(e) })), estimates, lows, treating, plan, sensorDays: row?.sensor_days || 14,
      mode: mode ? { kind: mode, until: Date.parse(row.mode_until) } : null,
      notes: recentNotes.map((n) => ({ ...n, mine: n.id.startsWith(noteMine) || owner })), at: now });
  }

  // The emergency card: the owner's own phone keeps it up to date (emergency.js).
  if (path.startsWith('app/emergency')) {
    if (!owner) return json({ error: T('Only the owner\'s own phone can change this.', 'Solo el teléfono del dueño puede cambiar esto.') }, 403);
    return emergencyManage(path.slice(4), request, { screens, night, json, snapshot, es });
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

  if (path === 'app/patterns') {
    if (!history?.ready) return json({ error: 'The server history is not set up' }, 503);
    const pid = await pidFor(url.searchParams.get('pid'));
    if (!pid) return json({ patterns: [], days: 0, note: T('No one to look at yet.', 'Todavía no hay a quién mirar.') });
    const person = (await people()).find((p) => p.pid === pid) || {};
    let tz;
    try { if (night?.ready) tz = (await night.get()).time_zone; } catch { /* default */ }
    const points = await history.range(pid, now - 14 * DAY, now + MIN);
    let events = [];
    try { if (doses?.ready) events = markersOf(await doses.between(pid, now - 14 * DAY, now)); } catch { /* none */ }
    let noted = [];
    try { if (notes?.ready) noted = await notes.between(pid, now - 14 * DAY, now + MIN); } catch { /* without notes */ }
    const mmol = person.units === 'mmol/L';
    return json(findPatterns(points, events, { now, tz, low: person.low ?? 70, high: person.high ?? 180, fmt: (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg))), unit: mmol ? 'mmol/L' : 'mg/dL', lang: es ? 'es' : 'en', notes: noted }));
  }

  if (path === 'app/food') {
    let r;
    try { r = await foodByBarcode(url.searchParams.get('barcode'), { es, ...(fetchImpl ? { fetchImpl } : {}) }); } catch { return json({ error: T('The food database did not answer. Try again, or type the carbs.', 'La base de datos de alimentos no respondió. Intenta otra vez o escribe los carbohidratos.') }, 502); }
    if (r.error) return json({ error: T('A barcode is 8 to 14 digits.', 'Un código de barras tiene de 8 a 14 dígitos.') }, 400);
    return json(r);
  }

  if (path === 'app/meals' && request.method === 'GET') {
    const pid = await pidFor(url.searchParams.get('pid'));
    let list = [];
    try { if (meals?.ready && pid) list = await meals.list(pid); } catch { /* none */ }
    return json({ meals: list.map((m) => ({ id: m.id, name: m.name, carbs: m.carbs, uses: m.uses })) });
  }

  if (path === 'app/notes' && request.method === 'GET') {
    if (!notes?.ready) return json({ notes: [] });
    const days = Math.min(90, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 2)));
    const known = await people();
    const want = url.searchParams.get('pid');
    const list = [];
    for (const p of known) if (!want || p.pid === want) list.push(...await notes.between(p.pid, now - days * DAY, now + MIN));
    const mineNote = `note-${screen.id.slice(0, 8)}-`;
    return json({ notes: list.map((n) => ({ ...n, mine: n.id.startsWith(mineNote) || owner })) });
  }

  if (path === 'app/labs') {
    if (!labs?.ready) return json({ error: 'Lab results are not set up on the server.' }, 503);
    const pid = await pidFor(url.searchParams.get('pid'));
    const rows = pid ? await labs.list(pid) : [];
    return json({ labs: rows.map((r) => ({ id: r.id, takenOn: r.taken_on, kind: r.kind, name: r.name, value: Number(r.value), unit: r.unit || '' })), canEdit: canLog });
  }

  if (path === 'app/parse') {
    // A spoken or typed "4 units rapid", "40 grams", "20 Lantus 30 minutes ago": what it would log.
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const b = await request.json().catch(() => ({}));
    const text = spokenNumbers(String(b.text || '').slice(0, 200));
    const e = parseLog(text);
    const said = String(b.text || '').slice(0, 200);
    if (!e) return json({ ok: false, heard: es ? said : text, error: T('Say an amount and what it is, for example "4 units rapid" or "40 grams".', 'Di una cantidad y qué es, por ejemplo "4 unidades de rápida" o "40 gramos".') });
    const minutesAgo = Math.min(24 * 60, Math.round((e.back || 0) / MIN));
    const heard = es ? said : text;
    return json(e.type === 'carbs'
      ? { ok: true, heard, kind: 'carbs', amount: e.grams, minutesAgo }
      : { ok: true, heard, kind: e.kind, amount: e.units, minutesAgo });
  }

  if (path === 'app/supplies') {
    if (!supplies?.ready) return json({ error: 'Supplies are not set up on the server.' }, 503);
    const pid = await pidFor(url.searchParams.get('pid'));
    const rows = pid ? await supplies.list(pid) : [];
    let row = null;
    try { if (night?.ready) row = await night.get(); } catch { /* defaults */ }
    const oldest = Math.min(now - 7 * DAY, ...rows.map((r) => Date.parse(r.set_at)));
    const list = rows.length && doses?.ready ? await doses.between(pid, oldest, now + MIN) : [];
    return json({ items: supplyStatus(rows, { doses: list, sensorStarts: row?.state?._sensors?.[pid] || [], sensorDays: row?.sensor_days || 14, now, tz: row?.time_zone }), canEdit: canLog });
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
      await push.add(screen.id, { endpoint, p256dh, auth, lang: b.lang === 'es' || es ? 'es' : 'en' });
      return json({ ok: true });
    }
    if (path === 'app/push/unsubscribe') { await push.remove(screen.id, String(b.endpoint || '')); return json({ ok: true }); }
    const sent = await pushTo(push, await push.forScreen(screen.id), {
      title: 'su94r test alert', priority: 4,
      message: owner ? 'Lows ring on this phone, with an "I\'m OK" button.' : 'This phone rings when a low is not handled.',
      es: { title: 'Alerta de prueba de su94r', message: owner ? 'Las bajas suenan en este teléfono, con un botón "Estoy bien".' : 'Este teléfono suena cuando una baja no se atiende.' },
    });
    return sent ? json({ ok: true }) : json({ ok: false, error: T('The test did not go out. Turn app alerts off and on again.', 'La prueba no salió. Apaga y vuelve a encender las alertas de la app.') }, 502);
  }

  // Logging: the owner's own phone, and family phones the owner allowed.
  if (!canLog) return json({ error: T('This phone can\'t log yet. The owner can allow it in su94r Mini (Share to another phone) or in their own su94r app (More).', 'Este teléfono todavía no puede registrar. El dueño lo puede permitir en su94r Mini (Compartir con otro teléfono) o en su propia app su94r (Más).') }, 403);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Exercise and sick-day modes, and "I'm OK" from the bedside screen (night.js).
  if (path === 'app/mode' || path === 'app/ack') {
    if (!night?.ready) return json({ ok: false, error: 'Low alerts are not set up on the server.' }, 503);
    const b = await request.json().catch(() => ({}));
    const row = await night.get();
    if (path === 'app/ack') {
      const { state, count } = acknowledgeAll(row, now);
      if (count) await night.patch({ state });
      return json({ ok: true, count, text: count ? T('Got it. Reminders for this low stop; a severe low still tells you once.', 'Entendido. Los recordatorios de esta baja paran; una baja severa avisa una vez más.') : T('Nothing to stop right now.', 'No hay nada que parar ahora.') });
    }
    let fields;
    try { fields = modeFields(b.mode, b.hours, now); } catch { return json({ ok: false, error: T('Pick exercise or sick day.', 'Elige ejercicio o día de enfermedad.') }, 400); }
    await night.patch(fields);
    const until = fields.mode_until ? Date.parse(fields.mode_until) : null;
    const at = until ? new Date(until).toLocaleTimeString(es ? 'es-US' : 'en-US', { timeZone: row.time_zone || 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '';
    const line = (row.low_mgdl ?? NIGHT_DEFAULTS.low_mgdl) + EXERCISE_MARGIN;
    const text = fields.mode === 'exercise' ? T(`Exercise mode until ${at}: Low soon warns earlier, from ${line} mg/dL.`, `Modo ejercicio hasta las ${at}: "Baja pronto" avisa antes, desde ${line} mg/dL.`)
      : fields.mode === 'sick' ? T(`Sick-day mode until ${at}: a check every 4 hours while awake.`, `Modo día de enfermedad hasta las ${at}: una revisión cada 4 horas mientras estás despierto.`)
        : T('Mode off.', 'Modo apagado.');
    return json({ ok: true, mode: fields.mode, until, text });
  }

  if (!doses?.ready) return json({ error: 'The dose store is not set up' }, 503);
  const body = await request.json().catch(() => ({}));

  // An id made on the phone (base 36 of when it was made) and a time: a log sent again after
  // losing signal is saved once, at the time it happened.
  const cid = /^[0-9a-z]{7,10}$/.test(String(body.cid || '')) ? String(body.cid) : null;
  if (cid && !(parseInt(cid, 36) > now - DAY && parseInt(cid, 36) <= now + 5 * MIN)) return json({ ok: false, error: T('That entry waited too long on the phone (over a day); log it again.', 'Ese registro esperó demasiado en el teléfono (más de un día); regístralo otra vez.') }, 400);
  const stamp = cid || now.toString(36);
  const atOk = body.at != null && Number.isFinite(Number(body.at));
  if (atOk && !(Number(body.at) > now - DAY && Number(body.at) <= now + 5 * MIN)) return json({ ok: false, error: T('The time must be within the last 24 hours.', 'La hora debe estar dentro de las últimas 24 horas.') }, 400);

  if (path === 'app/note' || path === 'app/notes/remove') {
    if (!notes?.ready) return json({ ok: false, error: 'Notes are not set up on the server.' }, 503);
    if (path === 'app/notes/remove') {
      const id = String(body.id || '');
      const n = /^[\w-]{1,80}$/.test(id) ? await notes.get(id) : null;
      if (!n) return json({ ok: false, error: T('That note is already gone.', 'Esa nota ya no está.') }, 404);
      if (!owner && !id.startsWith(`note-${screen.id.slice(0, 8)}-`)) return json({ ok: false, error: T('Only the phone that wrote it, or the owner\'s phone, can remove it.', 'Solo el teléfono que la escribió, o el del dueño, la puede quitar.') }, 403);
      await notes.remove(id);
      return json({ ok: true });
    }
    const pid = await pidFor(String(body.pid || ''));
    if (!pid) return json({ ok: false, error: 'No one to write a note for yet.' }, 400);
    const t = atOk ? Number(body.at) : now - Math.round(Number(body.minutesAgo) || 0) * MIN;
    const row = noteRow({ id: `note-${screen.id.slice(0, 8)}-${stamp}`, pid, t, text: body.text, tags: body.tags, by: screen.name }, now);
    if (row.error) return json({ ok: false, error: es ? (NOTE_ES[row.error] || row.error) : row.error }, 400);
    await notes.add(row);
    return json({ ok: true, id: row.id, text: T('Note saved.', 'Nota guardada.') });
  }

  if (path === 'app/meals/remove') {
    if (!meals?.ready) return json({ ok: false, error: 'Favorite meals are not set up on the server.' }, 503);
    const pid = await pidFor(String(body.pid || ''));
    await meals.remove(pid, String(body.id || ''));
    return json({ ok: true });
  }

  if (path === 'app/edit' || path === 'app/remove') {
    const id = String(body.id || '');
    const d = (await doses.recent(null, now)).find((x) => x.id === id);
    if (!d) return json({ ok: false, error: T('That entry is not in the last 48 hours, or was already removed.', 'Ese registro no está en las últimas 48 horas, o ya se quitó.') }, 404);
    // This phone's own of the last 24 hours; the owner's phone also any that did not come from a
    // computer (su94r Mini's own are changed in su94r Mini, which keeps them).
    const own = id.startsWith(`app-${screen.id.slice(0, 8)}-`) && now - createdAt(id) < DAY;
    if (!own && !(owner && d.source !== 'extension')) {
      return json({ ok: false, error: d.source === 'extension' ? T('That one was logged in su94r Mini: change it there.', 'Ese se registró en su94r Mini: cámbialo allí.') : T('Only the phone that logged it, or the owner\'s phone, can change it.', 'Solo el teléfono que lo registró, o el del dueño, lo puede cambiar.') }, 403);
    }
    if (path === 'app/remove') { await doses.markDeleted([id]); return json({ ok: true, text: T('Removed.', 'Quitado.') }); }
    const carbs = d.kind === 'carbs';
    const kind = carbs ? 'carbs' : (KINDS.has(String(body.kind)) && body.kind !== 'carbs' ? String(body.kind) : d.kind);
    const raw = Number(body.amount ?? d.amount);
    const amount = carbs ? Math.round(raw) : Math.round(raw * 2) / 2;
    if (!(amount > 0) || amount > (carbs ? APP_MAX_GRAMS : APP_MAX_UNITS)) return json({ ok: false, error: carbs ? T(`Carbs must be between 1 and ${APP_MAX_GRAMS} g.`, `Los carbohidratos deben estar entre 1 y ${APP_MAX_GRAMS} g.`) : T(`Insulin must be between 0.5 and ${APP_MAX_UNITS} units.`, `La insulina debe estar entre 0.5 y ${APP_MAX_UNITS} unidades.`) }, 400);
    let t = d.t;
    if (body.minutesAgo != null && body.minutesAgo !== '') {
      const m = Math.round(Number(body.minutesAgo));
      if (!(m >= 0 && m <= 24 * 60)) return json({ ok: false, error: T('The time must be within the last 24 hours.', 'La hora debe estar dentro de las últimas 24 horas.') }, 400);
      t = now - m * MIN;
    }
    const nid = `app-${screen.id.slice(0, 8)}-${now.toString(36)}`;
    await doses.upsert([{ id: nid, pid: d.pid, t, kind, amount, source: 'phone' }]);
    await doses.markDeleted([id]);
    return json({ ok: true, id: nid, text: T(`Changed to ${whatEn(kind, amount)}.`, `Cambiado a ${whatEs(kind, amount)}.`) });
  }

  if (path === 'app/log') {
    const kind = String(body.kind || '');
    const carbs = kind === 'carbs';
    const raw = Number(body.amount);
    const amount = carbs ? Math.round(raw) : Math.round(raw * 2) / 2;
    const minutesAgo = Math.round(Number(body.minutesAgo) || 0);
    if (!KINDS.has(kind)) return json({ ok: false, error: T('Pick insulin or carbs.', 'Elige insulina o carbohidratos.') }, 400);
    if (!(amount > 0) || amount > (carbs ? APP_MAX_GRAMS : APP_MAX_UNITS)) {
      return json({ ok: false, error: carbs ? T(`Carbs must be between 1 and ${APP_MAX_GRAMS} g.`, `Los carbohidratos deben estar entre 1 y ${APP_MAX_GRAMS} g.`) : T(`Insulin must be between 0.5 and ${APP_MAX_UNITS} units.`, `La insulina debe estar entre 0.5 y ${APP_MAX_UNITS} unidades.`) }, 400);
    }
    if (minutesAgo < 0 || minutesAgo > 24 * 60) return json({ ok: false, error: T('The time must be within the last 24 hours.', 'La hora debe estar dentro de las últimas 24 horas.') }, 400);
    const pid = await pidFor(String(body.pid || ''));
    if (!pid) return json({ ok: false, error: 'No one to log for yet.' }, 400);
    const t = atOk ? Number(body.at) : now - minutesAgo * MIN;
    const id = `app-${screen.id.slice(0, 8)}-${stamp}`;
    const recentDoses = await doses.recent(pid, now).catch(() => []);
    const ago = Math.max(0, Math.round((now - t) / MIN));
    // Sent again after losing signal, and already saved: nothing more to do.
    if (cid && recentDoses.some((d) => d.id === id)) return json({ ok: true, id, t, again: true, text: T(`Logged ${whatEn(kind, amount)}.`, `Registrado: ${whatEs(kind, amount)}.`) });
    if (!carbs && body.confirm !== true) {
      let warning = null;
      try { warning = doubleDoseWarning(asMarkers(recentDoses.filter((d) => d.id !== id)), pid, { t, kind }, {}, now, es ? 'es' : 'en'); } catch { /* a warning, never a block */ }
      if (warning) return json({ ok: false, confirm: true, warning });
    }
    await doses.upsert([{ id, pid, t, kind, amount, source: 'phone' }]);
    if (carbs && body.meal && meals?.ready) await meals.use(pid, String(body.meal), amount, now).catch(() => {});
    return json({ ok: true, id, t, text: T(`Logged ${whatEn(kind, amount)}${ago ? `, ${ago} min ago` : ''}.`, `Registrado: ${whatEs(kind, amount)}${ago ? `, hace ${ago} min` : ''}.`) });
  }

  if (path === 'app/treat') {
    const grams = Math.round(Number(body.grams));
    if (!(grams >= 1 && grams <= 100)) return json({ ok: false, error: T('Between 1 and 100 g.', 'Entre 1 y 100 g.') }, 400);
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
      const who = person.firstName || person.name;
      await notify(row, 'family', { title: `${who || 'They'} ${who ? 'is' : 'are'} treating the low`, message: `${grams} g at ${at}${screen.name ? ` (logged on ${screen.name})` : ''}.`, priority: 3, tags: ['white_check_mark'], es: { title: `${who || 'Tu familiar'} está tratando la baja`, message: `${grams} g a las ${at}${screen.name ? ` (registrado en ${screen.name})` : ''}.` } }).catch(() => {});
    }
    return json({ ok: true, id, recheckAt: t.recheckAt, text: T(`Logged ${grams} g. Reminders stop; recheck in ${Math.round((t.recheckAt - now) / MIN)} min.`, `Registrado: ${grams} g. Los recordatorios paran; se vuelve a revisar en ${Math.round((t.recheckAt - now) / MIN)} min.`) });
  }

  if (path === 'app/labs/save' || path === 'app/labs/remove') {
    if (!labs?.ready) return json({ ok: false, error: 'Lab results are not set up on the server.' }, 503);
    const pid = await pidFor(String(body.pid || ''));
    if (!pid) return json({ ok: false, error: 'No one to keep results for yet.' }, 400);
    if (path === 'app/labs/remove') { await labs.remove(pid, String(body.id || '')); return json({ ok: true }); }
    const row = labRow(pid, body, now);
    if (row.error) return json({ ok: false, error: es ? (LAB_ES[row.error] || row.error) : row.error }, 400);
    await labs.add(row);
    return json({ ok: true });
  }

  if (path === 'app/supplies/save' || path === 'app/supplies/remove') {
    if (!supplies?.ready) return json({ ok: false, error: 'Supplies are not set up on the server.' }, 503);
    const pid = await pidFor(String(body.pid || ''));
    if (!pid) return json({ ok: false, error: 'No one to track supplies for yet.' }, 400);
    if (path === 'app/supplies/remove') { await supplies.remove(pid, String(body.item || '')); return json({ ok: true }); }
    const row = supplyRow(pid, body, now);
    if (row.error) return json({ ok: false, error: es ? (SUPPLY_ES[row.error] || row.error) : row.error }, 400);
    await supplies.save(row);
    return json({ ok: true });
  }

  if (path === 'app/undo') {
    const id = String(body.id || '');
    if (!id.startsWith(`app-${screen.id.slice(0, 8)}-`) || !(now - createdAt(id) < UNDO_MS)) {
      return json({ ok: false, error: T('Only a dose this phone logged in the last 30 minutes can be undone here.', 'Aquí solo se puede deshacer una dosis que este teléfono registró en los últimos 30 minutos.') }, 400);
    }
    await doses.markDeleted([id]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

const whatEn = (kind, amount) => (kind === 'carbs' ? `${amount} g of carbs` : `${amount} ${amount === 1 ? 'unit' : 'units'} of ${kindWord(kind)} insulin`);
const KIND_ES = { rapid: 'rápida', short: 'regular', intermediate: 'NPH', basal: 'de acción prolongada', mix: 'premezclada' };
const whatEs = (kind, amount) => (kind === 'carbs' ? `${amount} g de carbohidratos` : `${amount} ${amount === 1 ? 'unidad' : 'unidades'} de insulina ${KIND_ES[kind]}`);
const NOTE_ES = {
  'Write a note or pick a tag.': 'Escribe una nota o elige una etiqueta.',
  'The time must be within the last 24 hours.': 'La hora debe estar dentro de las últimas 24 horas.',
};
const SUPPLY_ES = {
  'Pick insulin or sensors.': 'Elige insulina o sensores.',
  'Type how many you have on hand.': 'Escribe cuántos tienes.',
  'The reminder level is not a number.': 'El nivel del recordatorio no es un número.',
  'The refill date is not a date.': 'La fecha de surtido no es una fecha.',
};
const LAB_ES = {
  'Pick the date of the test.': 'Elige la fecha de la prueba.',
  'That date does not look right.': 'Esa fecha no parece correcta.',
  'Type the result as a number.': 'Escribe el resultado como número.',
  'An A1c is a percentage between 3 and 20.': 'La A1c es un porcentaje entre 3 y 20.',
  'Name the test, for example LDL cholesterol.': 'Escribe el nombre de la prueba, por ejemplo colesterol LDL.',
};
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** "four and a half units", "twenty five grams", "a hundred" → digits, for the text parser. */
export function spokenNumbers(text) {
  let t = String(text).toLowerCase().replace(/-/g, ' ');
  t = t.replace(/\bhalf an hour\b/g, '30 minutes').replace(/\ban hour\b/g, '1 hour').replace(/\b(a|one) hundred( and)?\b/g, '100 ');
  t = t.replace(new RegExp(`\\b(${TENS.slice(2).join('|')})(?: (${ONES.slice(1, 10).join('|')}))?\\b`, 'g'), (m, tens, one) => String(TENS.indexOf(tens) * 10 + (one ? ONES.indexOf(one) : 0)));
  t = t.replace(new RegExp(`\\b(${ONES.join('|')})\\b`, 'g'), (m) => String(ONES.indexOf(m)));
  t = t.replace(/\s+/g, ' ').replace(/\b100 (\d{1,2})\b/g, (m, n) => String(100 + Number(n)));
  t = t.replace(/(\d+) and a half\b/g, (m, n) => `${n}.5`).replace(/\ba half\b/g, '0.5');
  return t.replace(/\s+/g, ' ').trim();
}

/** When an app-logged dose was saved (its id ends in the time, base 36). */
function createdAt(id) {
  const t = parseInt(String(id).split('-').pop(), 36);
  return Number.isFinite(t) ? t : 0;
}
