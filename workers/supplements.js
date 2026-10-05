// Supplements, often from a Fullscript plan: name, dose, times and when the bottle runs out. They
// join the pill reminders (night.js, "Taken" logs them) and the app's pill list, and a refill shows
// on the app's Now tab a week ahead with Fullscript's sign-in to reorder. Fullscript's API is only
// for practitioners and partners it approves, so nothing here signs in to Fullscript: the owner
// types in what the plan says.
//
// Kept in su94r_night.supplements (migration 20261005b), changed only from the owner's phone.

import { dayIn } from './daily.js';

export const FULLSCRIPT_URL = 'https://us.fullscript.com/login';
export const MAX_SUPPLEMENTS = 30;
const DAY = 864e5;

const clean = (s, max) => String(s ?? '').replace(/[^\p{L}\p{N} '().,/+%-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** "8:00, 20:30" (or a list) as up to 4 sorted "H:MM" times; null when one is not a time. */
export function parseTimes(v) {
  const parts = (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    const s = `${Number(m[1])}:${m[2]}`;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 4).sort((a, b) => Number(a.split(':')[0]) * 60 + Number(a.split(':')[1]) - (Number(b.split(':')[0]) * 60 + Number(b.split(':')[1])));
}

/** Checks one from the app. Returns { row } or { error } (English; the app route translates). */
export function supplementRow(body, { now = Date.now(), id = null } = {}) {
  const name = clean(body?.name, 60);
  if (!name) return { error: 'Name the supplement, for example Vitamin D3.' };
  const times = parseTimes(body?.times);
  if (!times) return { error: 'Times look like 8:00 or 20:30, separated by commas.' };
  const runsOut = String(body?.runsOut || '');
  if (runsOut && (!/^\d{4}-\d{2}-\d{2}$/.test(runsOut) || Number.isNaN(Date.parse(runsOut)) || Date.parse(runsOut) < now - 60 * DAY || Date.parse(runsOut) > now + 730 * DAY)) return { error: 'That run-out date does not look right.' };
  const keep = typeof id === 'string' && /^sup-[a-z0-9]{4,20}$/.test(id) ? id : `sup-${now.toString(36)}`;
  return { row: { id: keep, name, dose: clean(body?.dose, 40), times, runsOut, fullscript: body?.fullscript !== false } };
}

/** The pill reminders' shape (checks.js pillTimes). */
export const asPills = (list) => (Array.isArray(list) ? list : []).filter((s) => s && s.name).map((s) => ({ name: s.name, times: s.times || [], supplement: true }));

/** Supplements running out within 7 days (or ran out in the last 30), soonest first. */
export function dueRefills(list, { now = Date.now(), tz = 'America/New_York' } = {}) {
  const today = dayIn(now, tz);
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && s.runsOut)
    .map((s) => ({ id: s.id, name: s.name, runsOut: s.runsOut, days: Math.round((Date.parse(`${s.runsOut}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY), fullscript: s.fullscript !== false }))
    .filter((s) => s.days <= 7 && s.days >= -30)
    .sort((a, b) => a.days - b.days);
}
