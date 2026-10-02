// Recent insulin doses on the server, so Alexa and su94r Mini share one memory:
// a dose said to Alexa shows up on every computer, and Alexa's double-dose check sees
// doses typed into su94r Mini. Only the last 48 hours are kept in play.
//
// Table public.su94r_doses (supabase/migrations/20261001_su94r_doses.sql): RLS on with no
// policies, so only the service-role key used here can read or write it.

const KINDS = new Set(['rapid', 'short', 'intermediate', 'basal', 'mix']);
export const WINDOW_MS = 48 * 3600e3;

export function doseStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_doses`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  const headers = (extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra });

  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('The dose store is not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: headers(init.headers) });
    if (!res.ok) throw new Error(`Dose store answered ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  const toRow = (d) => ({
    id: String(d.id),
    pid: String(d.pid),
    t: new Date(d.t).toISOString(),
    kind: d.kind,
    amount: d.amount ?? null,
    source: d.source,
    deleted: Boolean(d.deleted),
    updated_at: new Date().toISOString(),
  });
  const fromRow = (r) => ({ id: r.id, pid: r.pid, t: Date.parse(r.t), kind: r.kind, amount: r.amount == null ? null : Number(r.amount), source: r.source, deleted: r.deleted });

  return {
    ready,
    /** Non-deleted doses for one person (or everyone) in the last 48 hours. */
    async recent(pid, now = Date.now()) {
      const since = new Date(now - WINDOW_MS).toISOString();
      const who = pid ? `&pid=eq.${encodeURIComponent(pid)}` : '';
      const rows = await call(`?select=*&deleted=is.false&t=gte.${encodeURIComponent(since)}${who}&order=t.desc&limit=500`);
      return rows.map(fromRow);
    },
    async upsert(doses) {
      const rows = doses.filter(valid).map(toRow);
      if (!rows.length) return 0;
      await call('?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      return rows.length;
    },
    async markDeleted(ids) {
      const list = ids.map(String).filter((id) => /^[\w-]{1,80}$/.test(id));
      if (!list.length) return;
      await call(`?id=in.(${list.map((id) => `"${id}"`).join(',')})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted: true, updated_at: new Date().toISOString() }),
      });
    },
  };
}

export function valid(d) {
  return d && /^[\w-]{1,80}$/.test(String(d.id)) && d.pid && Number.isFinite(new Date(d.t).getTime())
    && KINDS.has(d.kind) && (d.amount == null || (Number(d.amount) > 0 && Number(d.amount) <= 300))
    && (d.source === 'alexa' || d.source === 'extension');
}

/** Doses in the marker shape su94r Mini and its double-dose guard use. */
export const asMarkers = (doses) => doses.map((d) => ({ id: d.id, p: d.pid, t: d.t, type: 'insulin', kind: d.kind, ...(d.amount != null ? { amount: d.amount } : {}), source: d.source }));
