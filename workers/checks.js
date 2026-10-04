// Things logged besides insulin and carbs: meter (fingerstick) readings, ketones, weight, exercise
// and pills. Meter readings are compared with the sensor at that moment; ketones are read against
// common guidance; pills feed the pill reminders (night.js reminders); weight and exercise feed
// goals and medals.
//
// Table public.su94r_checks (migration 20261004b_su94r_checks.sql), service role only. Values are
// kept in mg/dL (meter), mmol/L (blood ketones), kg (weight) and minutes (exercise).

const MIN = 60e3, DAY = 864e5;
export const CHECK_KINDS = ['meter', 'ketone', 'weight', 'exercise', 'med'];
export const URINE = ['negative', 'trace', 'small', 'moderate', 'large'];
export const ACTIVITIES = ['walk', 'run', 'bike', 'swim', 'gym', 'sport', 'yoga', 'other'];
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function checkStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_checks`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Checks are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Check store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  const fromRow = (r) => ({ id: r.id, pid: r.pid, t: Date.parse(r.t), kind: r.kind, value: r.value == null ? null : Number(r.value), unit: r.unit || '', label: r.label || '', by: r.by || '', source: r.source || 'phone' });
  return {
    ready,
    /** One person's entries between two times (all kinds, or the ones listed), oldest first. */
    async between(pid, from, to, kinds = null) {
      const k = kinds ? `&kind=in.(${kinds.map(q).join(',')})` : '';
      return (await call(`?select=*&pid=eq.${q(pid)}&deleted=is.false${k}&t=gte.${q(new Date(from).toISOString())}&t=lt.${q(new Date(to).toISOString())}&order=t.asc&limit=2000`)).map(fromRow);
    },
    async get(id) { const r = (await call(`?select=*&id=eq.${q(id)}`))[0]; return r && !r.deleted ? fromRow(r) : null; },
    /** Saves entries; one already kept (same id: a resend after lost signal, or su94r Mini again) stays as it is. */
    add: (rows) => (rows.length ? call('?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows) }) : Promise.resolve()),
    remove: (ids) => (ids.length ? call(`?id=in.(${ids.map((i) => `"${String(i).replace(/"/g, '')}"`).join(',')})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ deleted: true }) }) : Promise.resolve()),
  };
}

/** What the app sent, checked and converted: the row to save, or { error }. */
export function checkRow({ id, pid, t, kind, value, unit, label, by, source = 'phone' }, now = Date.now()) {
  if (!CHECK_KINDS.includes(kind)) return { error: 'Pick what to log.' };
  if (!(t > now - DAY - MIN && t <= now + 5 * MIN)) return { error: 'The time must be within the last 24 hours.' };
  const n = value === '' || value == null ? null : Number(String(value).replace(',', '.'));
  const row = { id, pid, t: new Date(t).toISOString(), kind, value: null, unit: '', label: '', by: clean(by, 40), source };
  if (kind === 'meter') {
    const mg = unit === 'mmol/L' ? n * 18.0182 : n;
    if (!(mg >= 20 && mg <= 600)) return { error: 'A meter reading is between 20 and 600 mg/dL (1.1 to 33.3 mmol/L).' };
    return { ...row, value: Math.round(mg), unit: 'mg/dL' };
  }
  if (kind === 'ketone') {
    if (URINE.includes(label)) return { ...row, label, unit: 'urine' };
    if (!(n >= 0 && n <= 8)) return { error: 'Blood ketones are between 0 and 8 mmol/L.' };
    return { ...row, value: Math.round(n * 10) / 10, unit: 'mmol/L' };
  }
  if (kind === 'weight') {
    const kg = unit === 'lb' ? n * 0.45359237 : n;
    if (!(kg >= 20 && kg <= 400)) return { error: 'That weight does not look right.' };
    return { ...row, value: Math.round(kg * 10) / 10, unit: 'kg' };
  }
  if (kind === 'exercise') {
    if (!(n >= 1 && n <= 600)) return { error: 'Exercise is between 1 and 600 minutes.' };
    return { ...row, value: Math.round(n), unit: 'min', label: ACTIVITIES.includes(label) ? label : 'other' };
  }
  const name = clean(label, 60);
  if (!name) return { error: 'Pick the medicine.' };
  return { ...row, label: name, value: n != null && n > 0 && n < 10000 ? n : null, unit: clean(unit, 12) };
}

/**
 * A meter reading against the sensor's reading closest in time (within 7 minutes): the difference,
 * and whether it is outside 20 mg/dL (meter under 100) or 20% (100 and over), the usual yardstick
 * for CGM accuracy.
 */
export function sensorVsMeter(mg, t, points) {
  const near = (points || []).filter((p) => Math.abs(p.t - t) <= 7 * MIN).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  if (!near) return null;
  const diff = near.mg - mg;
  const pct = Math.round((diff / mg) * 100);
  return { cgm: near.mg, diff, pct, off: mg < 100 ? Math.abs(diff) > 20 : Math.abs(pct) > 20 };
}

/** Blood ketones (mmol/L) or a urine result, read against Diabetes UK's guidance. */
export function ketoneLevel(c) {
  if (c.unit === 'urine') return { moderate: 'high', large: 'urgent', small: 'raised', trace: 'normal', negative: 'normal' }[c.label] || 'normal';
  const v = c.value;
  if (v >= 3) return 'urgent';
  if (v >= 1.6) return 'high';
  if (v >= 0.6) return 'raised';
  return 'normal';
}
export const KETONE_WORDS = {
  normal: ['Normal (under 0.6 mmol/L).', 'Normal (menos de 0.6 mmol/L).'],
  raised: ['Raised (0.6 to 1.5): test again in 2 hours, and follow your sick-day plan.', 'Elevadas (0.6 a 1.5): mide otra vez en 2 horas y sigue tu plan para días de enfermedad.'],
  high: ['High (1.6 to 2.9): risk of DKA. Contact your diabetes team or doctor now.', 'Altas (1.6 a 2.9): riesgo de cetoacidosis. Contacta ya a tu equipo de diabetes o a tu médico.'],
  urgent: ['3.0 or above: go to the emergency room now.', '3.0 o más: ve a urgencias ahora.'],
};

/** For the report: meter checks against the sensor, and ketones. */
export function checksForReport(checks, points) {
  const meters = checks.filter((c) => c.kind === 'meter').map((c) => ({ t: c.t, mg: c.value, ...(sensorVsMeter(c.value, c.t, points) || {}) }));
  const compared = meters.filter((m) => m.cgm != null);
  const within = compared.filter((m) => !m.off).length;
  const mard = compared.length ? Math.round(compared.reduce((s, m) => s + Math.abs(m.pct), 0) / compared.length) : null;
  const ketones = checks.filter((c) => c.kind === 'ketone').map((c) => ({ t: c.t, value: c.value, unit: c.unit, label: c.label, level: ketoneLevel(c) }));
  return { meters: meters.slice(-20), compared: compared.length, within, mard, ketones: ketones.slice(-20) };
}

/**
 * Usual times of each pill (not insulin): the times set in su94r Mini, or learned from the last
 * 14 days (a time of day logged on 5 or more days, within an hour and a half). [{ name, minute }].
 */
export function pillTimes(meds, logs, { tz = 'America/New_York', now = Date.now() } = {}) {
  const minuteOf = (t) => { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t).map((x) => [x.type, x.value])); return Number(p.hour) * 60 + Number(p.minute); } catch { return new Date(t).getHours() * 60 + new Date(t).getMinutes(); } };
  const dayOf = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
  const out = [];
  for (const m of (meds || []).filter((x) => x && x.name && !x.isInsulin)) {
    const set = (m.times || []).map((s) => /^(\d{1,2}):(\d{2})$/.exec(String(s).trim())).filter(Boolean).map((x) => Number(x[1]) * 60 + Number(x[2])).filter((x) => x >= 0 && x < 1440);
    if (set.length) { for (const minute of set) out.push({ name: m.name, minute, set: true }); continue; }
    const mine = (logs || []).filter((l) => l.kind === 'med' && l.t > now - 14 * DAY && sameMed(l.label, m.name));
    const used = new Set();
    for (const l of mine.slice().sort((a, b) => minuteOf(a.t) - minuteOf(b.t))) {
      if (used.has(l.id)) continue;
      const c = minuteOf(l.t);
      const near = mine.filter((x) => !used.has(x.id) && Math.abs(minuteOf(x.t) - c) <= 90);
      const days = new Set(near.map((x) => dayOf(x.t)));
      if (days.size >= 5) {
        near.forEach((x) => used.add(x.id));
        const ms = near.map((x) => minuteOf(x.t)).sort((a, b) => a - b);
        out.push({ name: m.name, minute: ms[Math.floor(ms.length / 2)], set: false });
      }
    }
  }
  return out;
}

/** The same medicine: one name contains the other's first word ("Metformin" and "metformin 500 MG Oral Tablet"). */
export function sameMed(a, b) {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  const fx = x.split(/[\s,]+/)[0], fy = y.split(/[\s,]+/)[0];
  return x.includes(fy) || y.includes(fx);
}
