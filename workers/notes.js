// Notes with tags, from the phone app (app/note in app.js): "ran 30 minutes", "stressful meeting",
// tagged exercise, stress, sick, alcohol, period, travel or eating out. They show on the History
// graph, in the 14-day report and the doctor's link, and the pattern finder looks at what follows
// each tag (extension/patterns.js).
//
// Table public.su94r_notes (migration 20261003c_su94r_everyday.sql), service role only.

import { NOTE_TAGS } from '../extension/patterns.js';

const MIN = 60e3, DAY = 864e5;

export function noteStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_notes`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Notes are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`Note store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  const fromRow = (r) => ({ id: r.id, pid: r.pid, t: Date.parse(r.t), text: r.text || '', tags: r.tags || [], by: r.by || '' });
  return {
    ready,
    /** One person's notes between two times, oldest first. */
    async between(pid, from, to) {
      return (await call(`?select=id,pid,t,text,tags,by&pid=eq.${q(pid)}&deleted=is.false&t=gte.${q(new Date(from).toISOString())}&t=lt.${q(new Date(to).toISOString())}&order=t.asc&limit=500`)).map(fromRow);
    },
    async get(id) { const r = (await call(`?select=id,pid,t,text,tags,by,deleted&id=eq.${q(id)}`))[0]; return r && !r.deleted ? fromRow(r) : null; },
    /** Saves a note; the same id twice (a phone sending again after losing signal) keeps one. */
    add: (row) => call('?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) }),
    remove: (id) => call(`?id=eq.${q(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ deleted: true }) }),
  };
}

/** Checks a note from the app: the row to save, or { error }. */
export function noteRow({ id, pid, t, text, tags, by }, now = Date.now()) {
  const words = String(text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
  const list = [...new Set((Array.isArray(tags) ? tags : []).map(String))].filter((x) => NOTE_TAGS.includes(x));
  if (!words && !list.length) return { error: 'Write a note or pick a tag.' };
  if (!(t > now - DAY - MIN && t <= now + 5 * MIN)) return { error: 'The time must be within the last 24 hours.' };
  return { id, pid, t: new Date(t).toISOString(), text: words, tags: list, by: String(by || '').slice(0, 40) };
}

/** For the report: the tags counted, and the last notes (newest first). */
export function notesForReport(notes) {
  const tags = {};
  for (const n of notes) for (const x of n.tags) tags[x] = (tags[x] || 0) + 1;
  return { count: notes.length, tags, recent: notes.slice().sort((a, b) => b.t - a.t).slice(0, 12).map((n) => ({ t: n.t, text: n.text, tags: n.tags })) };
}
