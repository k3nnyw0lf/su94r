// The calendar feed: one private .ics address to subscribe to in Google Calendar, Apple Calendar or
// Outlook. It holds sensor changes (the current sensor's end and the next one's), refill dates and
// when insulin or sensors on hand likely run out (supplies.js), and doctor visits typed into the
// phone app. Calendar apps fetch it themselves every few hours; nothing is sent anywhere.
//
// Kept in su94r_screens as kind 'calendar' (one link at a time; a new one turns the old one off).
// Doctor visits: table public.su94r_appointments (migration 20261003d_su94r_insights.sql).
//
// Routes (the owner's phone; family phones that may log add and remove visits):
//   GET  app/appointments?pid=     the visits ahead; POST app/appointments/save { at, title, place },
//                                  app/appointments/remove { id }
//   GET  app/calendar              (owner's phone) whether a feed link exists; POST app/calendar/new
//                                  → { token }, app/calendar/remove
//   GET  calendar/feed             Authorization: Bearer <token> → text/calendar
//   page /cal/<token>.ics          served by su94r-proxy (the token moves into the header)

import { sha256, randomToken } from './screens.js';

const MIN = 60e3, DAY = 864e5;
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function appointmentStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_appointments`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Appointments are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Appointment store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    /** One person's visits from a time on, soonest first. */
    async from(pid, t) { return (await call(`?select=id,pid,at,title,place&pid=eq.${q(pid)}&at=gte.${q(new Date(t).toISOString())}&order=at.asc&limit=50`)).map((r) => ({ ...r, at: Date.parse(r.at) })); },
    add: (row) => call('', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) }),
    remove: (pid, id) => call(`?pid=eq.${q(pid)}&id=eq.${q(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}

/** A visit from the app, checked: the row to save, or { error }. */
export function appointmentRow(pid, body, now = Date.now()) {
  const at = Date.parse(String(body.at || ''));
  if (!Number.isFinite(at)) return { error: 'Pick the date and time of the visit.' };
  if (at < now - DAY || at > now + 400 * DAY) return { error: 'That date does not look right.' };
  const title = clean(body.title, 80);
  if (!title) return { error: 'Say who the visit is with, for example Dr. Lee.' };
  return { pid, at: new Date(at).toISOString(), title, place: clean(body.place, 120) };
}

// ---- the .ics file (RFC 5545) ----

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (day) => day.replace(/-/g, '');
/** Lines longer than 75 octets are folded (a space starts each continuation). */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * The feed's events: [{ uid, title, start, end } | { uid, title, day }]. people: snapshot people;
 * supplies: supplyStatus() rows per pid; visits: appointments per pid.
 */
export function feedEvents({ people = [], sensorDays = 14, supplies = {}, visits = {}, now = Date.now(), lang = 'en' }) {
  const es = lang === 'es';
  const many = people.length > 1;
  const who = (p) => (many ? ` (${p.firstName || p.name})` : '');
  const ev = [];
  for (const p of people) {
    if (p.sensorStart) {
      const end = p.sensorStart + sensorDays * DAY;
      if (end > now - DAY) ev.push({ uid: `sensor-${p.pid}-${p.sensorStart}`, title: (es ? 'Cambiar el sensor' : 'Change the sensor') + who(p), start: end - 30 * MIN, end });
      ev.push({ uid: `sensor-${p.pid}-${p.sensorStart}-next`, title: (es ? 'Cambiar el sensor (el siguiente, aproximado)' : 'Change the sensor (the next one, about)') + who(p), start: end + sensorDays * DAY - 30 * MIN, end: end + sensorDays * DAY });
    }
    for (const s of supplies[p.pid] || []) {
      const what = s.item === 'sensors' ? (es ? 'sensores' : 'sensors') : (es ? 'insulina' : 'insulin');
      if (s.refillOn) ev.push({ uid: `refill-${p.pid}-${s.item}-${s.refillOn}`, title: (es ? `Surtir ${what}` : `Refill ${what}`) + who(p), day: s.refillOn });
      if (s.daysLeft != null && s.daysLeft <= 60) {
        const day = new Date(now + s.daysLeft * DAY).toISOString().slice(0, 10);
        ev.push({ uid: `runout-${p.pid}-${s.item}`, title: (es ? `Se acaban: ${what} (aproximado)` : `${what[0].toUpperCase()}${what.slice(1)} runs out (about)`) + who(p), day });
      }
    }
    for (const v of visits[p.pid] || []) ev.push({ uid: `visit-${v.id}`, title: v.title + who(p), start: v.at, end: v.at + 60 * MIN, place: v.place || '' });
  }
  return ev;
}

export function icsFeed(events, { now = Date.now(), name = 'su94r' } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//su94r//calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.uid}@su94r`, `DTSTAMP:${stamp(now)}`);
    if (e.day) {
      const next = new Date(Date.parse(`${e.day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
      L.push(`DTSTART;VALUE=DATE:${dateOnly(e.day)}`, `DTEND;VALUE=DATE:${dateOnly(next)}`, 'TRANSP:TRANSPARENT');
    } else L.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
    L.push(`SUMMARY:${icsText(e.title)}`);
    if (e.place) L.push(`LOCATION:${icsText(e.place)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

/** calendar/feed: the .ics for a calendar link's token, or null when it is not one. */
export async function calendarFeed(screen, { snapshot, night, supplies, doses, appointments, supplyStatus, now = Date.now() }) {
  if (!screen || screen.kind !== 'calendar') return null;
  let people = [];
  try { people = (await snapshot()).people || []; } catch { /* the visits still show */ }
  const row = night?.ready ? await night.get().catch(() => null) : null;
  const sup = {}, visits = {};
  for (const p of people) {
    try {
      const rows = supplies?.ready ? await supplies.list(p.pid) : [];
      if (rows.length) {
        const oldest = Math.min(now - 7 * DAY, ...rows.map((r) => Date.parse(r.set_at)));
        const list = doses?.ready ? await doses.between(p.pid, oldest, now + MIN) : [];
        sup[p.pid] = supplyStatus(rows, { doses: list, sensorStarts: row?.state?._sensors?.[p.pid] || [], sensorDays: row?.sensor_days || 14, now, tz: row?.time_zone });
      }
    } catch { /* without supplies */ }
    try { if (appointments?.ready) visits[p.pid] = await appointments.from(p.pid, now - 30 * DAY); } catch { /* without visits */ }
  }
  const lang = row?.lang_self === 'es' ? 'es' : 'en';
  return icsFeed(feedEvents({ people, sensorDays: row?.sensor_days || 14, supplies: sup, visits, now, lang }), { now, name: 'su94r' });
}

/** app/calendar, app/calendar/new, app/calendar/remove (the caller checked it is the owner's phone). */
export async function calendarManage(sub, request, { screens, json }) {
  const links = async () => (await screens.list()).filter((s) => s.kind === 'calendar');
  if (sub === 'app/calendar' && request.method === 'GET') {
    const l = (await links())[0];
    return json({ link: l ? { since: l.created_at, lastSeen: l.last_seen || null } : null });
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  for (const old of await links()) await screens.update(old.id, { revoked: true });
  if (sub === 'app/calendar/remove') return json({ ok: true });
  const token = randomToken();
  const now = Date.now();
  await screens.insert({ id: crypto.randomUUID(), secret_hash: await sha256(randomToken()), token_hash: await sha256(token), kind: 'calendar', name: 'Calendar feed', claimed_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * 365 * DAY).toISOString() });
  return json({ ok: true, token });
}
