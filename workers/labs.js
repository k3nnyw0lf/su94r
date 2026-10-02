// Lab results (A1c and others), typed into the phone app (app/labs in app.js). The 14-day report
// and the doctor's link show them next to the GMI su94r estimates (doctor.js reportFor).
//
// Table public.su94r_labs (migration 20261002r_su94r_labs.sql), service role only.

const YEAR = 365 * 864e5;

export function labStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_labs`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Lab results are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Lab store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    /** One person's results since a date, newest first. */
    list: (pid, since = Date.now() - 3 * YEAR) => call(`?select=id,pid,taken_on,kind,name,value,unit&pid=eq.${q(pid)}&taken_on=gte.${q(new Date(since).toISOString().slice(0, 10))}&order=taken_on.desc,created_at.desc&limit=200`),
    add: (row) => call('', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }),
    remove: (pid, id) => call(`?pid=eq.${q(pid)}&id=eq.${q(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}

/** Checks what the app sends; returns the row to save or { error }. */
export function labRow(pid, body, now = Date.now()) {
  const kind = body.kind === 'a1c' ? 'a1c' : 'other';
  const value = Number(String(body.value ?? '').replace(',', '.'));
  const takenOn = String(body.takenOn || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(takenOn) || Number.isNaN(Date.parse(takenOn))) return { error: 'Pick the date of the test.' };
  if (Date.parse(takenOn) > now + 864e5 || Date.parse(takenOn) < now - 20 * YEAR) return { error: 'That date does not look right.' };
  if (!Number.isFinite(value)) return { error: 'Type the result as a number.' };
  if (kind === 'a1c') {
    if (value < 3 || value > 20) return { error: 'An A1c is a percentage between 3 and 20.' };
    return { pid, kind, name: 'A1c', value: Math.round(value * 10) / 10, unit: '%', taken_on: takenOn };
  }
  const name = String(body.name || '').replace(/[^\p{L}\p{N} '().,/+-]/gu, '').trim().slice(0, 40);
  if (!name) return { error: 'Name the test, for example LDL cholesterol.' };
  const unit = String(body.unit || '').replace(/[^\p{L}\p{N} %/.µ-]/gu, '').trim().slice(0, 16);
  return { pid, kind, name, value: Math.round(value * 100) / 100, unit, taken_on: takenOn };
}

/** For the report: the last year's results and the latest A1c. */
export function labsForReport(rows, now = Date.now()) {
  const year = rows.filter((r) => Date.parse(r.taken_on) >= now - YEAR);
  const a1c = rows.find((r) => r.kind === 'a1c') || null;
  return { labs: year.slice(0, 12).map((r) => ({ takenOn: r.taken_on, name: r.name, value: Number(r.value), unit: r.unit || '' })), a1c: a1c ? { takenOn: a1c.taken_on, value: Number(a1c.value) } : null };
}
