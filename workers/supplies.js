// Supplies: insulin and sensors on hand, counted down as doses are logged and sensors are
// started, with a reminder when they run low or the refill date comes. Set in the phone app
// (app/supplies in app.js); the night check (night.js) gives the reminders, by day, once a day
// per item.
//
// Insulin is counted in units from the logged doses of the same kind (priming is not counted,
// so the real number runs a little lower); sensors by the new sensors LibreLinkUp reports.
//
// Table public.su94r_supplies (migration 20261002q_su94r_nudges_supplies.sql), service role only.

import { localParts } from './nudges.js';

const DAY = 864e5;
export const SUPPLY_ITEMS = {
  rapid: { label: 'Rapid insulin', unit: 'units' },
  basal: { label: 'Long-acting insulin', unit: 'units' },
  short: { label: 'Regular insulin', unit: 'units' },
  intermediate: { label: 'NPH insulin', unit: 'units' },
  mix: { label: 'Pre-mixed insulin', unit: 'units' },
  sensors: { label: 'Sensors', unit: 'sensors' },
};

export function supplyStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_supplies`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Supplies are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Supply store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    list: (pid) => call(`?select=*${pid ? `&pid=eq.${q(pid)}` : ''}&order=item.asc`),
    save: (row) => call('?on_conflict=pid,item', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }) }),
    remove: (pid, item) => call(`?pid=eq.${q(pid)}&item=eq.${q(item)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}

/** Checks what the app sends; returns the row to save or { error }. */
export function supplyRow(pid, body, now = Date.now()) {
  const item = String(body.item || '');
  if (!SUPPLY_ITEMS[item]) return { error: 'Pick insulin or sensors.' };
  const onHand = Number(body.onHand), warnAt = body.warnAt == null || body.warnAt === '' ? 0 : Number(body.warnAt);
  if (!Number.isFinite(onHand) || onHand < 0 || onHand > 100000) return { error: 'Type how many you have on hand.' };
  if (!Number.isFinite(warnAt) || warnAt < 0 || warnAt > 100000) return { error: 'The reminder level is not a number.' };
  const refill = body.refillOn ? String(body.refillOn) : null;
  if (refill && !/^\d{4}-\d{2}-\d{2}$/.test(refill)) return { error: 'The refill date is not a date.' };
  return { pid, item, on_hand: Math.round(onHand * 10) / 10, warn_at: Math.round(warnAt * 10) / 10, refill_on: refill, set_at: new Date(now).toISOString() };
}

/**
 * Where each item stands. doses: [{ t, kind, amount }] since the oldest set_at; sensorStarts:
 * sensor start times seen by the night check; sensorDays: how long a sensor lasts.
 */
export function supplyStatus(rows, { doses = [], sensorStarts = [], sensorDays = 14, now = Date.now(), tz = 'America/New_York' } = {}) {
  const today = localParts(now, tz).date;
  const soon = localParts(now + 3 * DAY, tz).date;
  return rows.map((r) => {
    const info = SUPPLY_ITEMS[r.item] || { label: r.item, unit: '' };
    const setAt = Date.parse(r.set_at);
    let used, perDay;
    if (r.item === 'sensors') {
      used = sensorStarts.filter((s) => s > setAt).length;
      perDay = 1 / (Number(sensorDays) || 14);
    } else {
      const mine = doses.filter((d) => d.kind === r.item && Number(d.amount) > 0);
      used = mine.filter((d) => d.t >= setAt).reduce((s, d) => s + Number(d.amount), 0);
      perDay = mine.filter((d) => d.t >= now - 7 * DAY).reduce((s, d) => s + Number(d.amount), 0) / 7;
    }
    const left = Math.max(0, Math.round((Number(r.on_hand) - used) * 10) / 10);
    return {
      pid: r.pid, item: r.item, label: info.label, unit: info.unit, onHand: Number(r.on_hand), left, warnAt: Number(r.warn_at) || 0,
      perDay: Math.round(perDay * 10) / 10, daysLeft: perDay > 0 ? Math.floor(left / perDay) : null,
      refillOn: r.refill_on || null, low: left <= (Number(r.warn_at) || 0), refillDue: Boolean(r.refill_on && r.refill_on >= today && r.refill_on <= soon),
    };
  });
}

/** The reminders due now (by day, once a day per item): [{ key, title, message }]. */
export function supplyReminders(statuses, { reminded = {}, now = Date.now(), tz = 'America/New_York' } = {}) {
  const { date, minute } = localParts(now, tz);
  if (minute < 9 * 60 || minute >= 20 * 60) return { reminders: [], date };
  const out = [];
  for (const s of statuses) {
    const key = `${s.pid}:${s.item}`;
    if (reminded[key] === date || (!s.low && !s.refillDue)) continue;
    const left = `${s.left} ${s.left === 1 && s.unit === 'sensors' ? 'sensor' : s.unit} left${s.daysLeft != null ? `, about ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} at your recent use` : ''}`;
    out.push(s.refillDue
      ? { key, title: `Refill due ${s.refillOn}: ${s.label.toLowerCase()}`, message: `${left}.` }
      : { key, title: `Running low: ${s.label.toLowerCase()}`, message: `${left}. Update the count in the su94r app when you restock.` });
  }
  return { reminders: out, date };
}
