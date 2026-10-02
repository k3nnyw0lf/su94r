// The server keeps the glucose history (90 days), so reports, the phone app, the doctor's link
// and "how was my night?" work with every computer off.
//
// The night check (night.js tick, every 5 minutes) saves what LibreLinkUp shows: the latest
// reading and the graph (about 12 hours at 15-minute steps). su94r Mini can also copy the
// longer history it has kept on the computer (history/import, once). Readings older than 90
// days are removed once a day.
//
// Table public.su94r_readings (migration 20261002l_su94r_readings.sql), service role only.
//
// Routes:
//   POST history/import?key=<owner>     { pid, points: [[t, mg], …] } up to 5000 per call
//   GET  history?key=<owner>&days=14    { people, points: { pid: [[t, mg], …] } }

const MIN = 60e3, DAY = 24 * 60 * MIN;
export const KEEP_DAYS = 90;
const PAGE = 1000;                                     // PostgREST answers at most 1000 rows at a time

export function historyStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_readings`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('History is not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`History store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  return {
    ready,
    /** Saves readings; ones already kept (same person and minute) are left alone. */
    async save(rows) {
      const clean = rows.filter((r) => r.pid && Number.isFinite(r.t) && r.mg >= 20 && r.mg <= 600)
        .map((r) => ({ pid: String(r.pid), t: new Date(Math.round(r.t / MIN) * MIN).toISOString(), mg: Math.round(r.mg), trend: Number.isInteger(r.trend) ? r.trend : null }));
      for (let i = 0; i < clean.length; i += 1000) {
        await call('?on_conflict=pid,t', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(clean.slice(i, i + 1000)) });
      }
      return clean.length;
    },
    /** Readings of one person between two times, oldest first: [{ t, mg, trend }]. */
    async range(pid, from, to = Date.now()) {
      const out = [];
      for (let offset = 0; offset < 200000; offset += PAGE) {
        const rows = await call(`?select=t,mg,trend&pid=eq.${q(pid)}&t=gte.${q(new Date(from).toISOString())}&t=lt.${q(new Date(to).toISOString())}&order=t.asc&limit=${PAGE}&offset=${offset}`);
        for (const r of rows) out.push({ t: Date.parse(r.t), mg: r.mg, trend: r.trend });
        if (rows.length < PAGE) break;
      }
      return out;
    },
    prune: (now = Date.now()) => call(`?t=lt.${q(new Date(now - KEEP_DAYS * DAY).toISOString())}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}

/** What the night check saves from a snapshot: every person's graph points and latest reading. */
export function rowsFromSnapshot(people) {
  const rows = [];
  for (const p of people || []) {
    for (const h of p.history || []) rows.push({ pid: p.pid, t: h.t, mg: h.mg, trend: h.trend ?? null });
    if (p.latest) rows.push({ pid: p.pid, t: p.latest.t, mg: p.latest.mg, trend: p.latest.trend ?? null });
  }
  return rows;
}

// ---- plain-language answers: "how was my night?" and "how was my week?" ----

function hourIn(t, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t)); } catch { return new Date(t).getHours(); }
}
function clock(t, tz) {
  try { return new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch { return new Date(t).toISOString().slice(11, 16); }
}

/** Last night (22:00–07:00 local, ending before now) as words; describes, never advises. */
export function nightSummary(points, { now = Date.now(), tz = 'America/New_York', low = 70, high = 180, fmt = (mg) => `${Math.round(mg)}` } = {}) {
  // The night that ended most recently: readings between 10 PM and 7 AM, within the last 20 hours.
  const night = points.filter((p) => p.t > now - 20 * 60 * MIN && p.t <= now && (hourIn(p.t, tz) >= 22 || hourIn(p.t, tz) < 7));
  if (night.length < 6) return 'I do not have enough readings from last night to say.';
  const share = (f) => Math.round((night.filter(f).length / night.length) * 100);
  const lowest = night.reduce((a, b) => (b.mg < a.mg ? b : a));
  const highest = night.reduce((a, b) => (b.mg > a.mg ? b : a));
  const lows = [];
  let inLow = false;
  for (const p of night) { if (p.mg < low && !inLow) { lows.push(p); inLow = true; } else if (p.mg >= low) inLow = false; }
  // When the readings start late in the night, say from when.
  const first = night[0];
  const startsLate = (() => { const h = hourIn(first.t, tz); return h >= 0 && h < 7 && night.every((p) => hourIn(p.t, tz) < 7); })() && hourIn(first.t, tz) >= 1;
  const parts = [`${startsLate ? `From ${clock(first.t, tz)}, when my readings start, ` : 'Last night '}you were in range ${share((p) => p.mg >= low && p.mg <= high)}% of the time.`];
  parts.push(lows.length
    ? `You went low ${lows.length === 1 ? 'once' : `${lows.length} times`}, lowest ${fmt(lowest.mg)} at ${clock(lowest.t, tz)}.`
    : `No lows; the lowest was ${fmt(lowest.mg)} at ${clock(lowest.t, tz)}.`);
  parts.push(`The highest was ${fmt(highest.mg)} at ${clock(highest.t, tz)}.`);
  return parts.join(' ');
}

/** The last 7 days in one line. */
export function weekLine(points, { now = Date.now(), low = 70, high = 180, fmt = (mg) => `${Math.round(mg)}` } = {}) {
  const pts = points.filter((p) => p.t > now - 7 * DAY && p.t <= now);
  if (pts.length < 50) return 'I do not have enough readings from this week yet.';
  const span = now - pts.reduce((a, p) => Math.min(a, p.t), now);
  if (span < 2 * DAY) return `I only have ${Math.max(1, Math.round(span / (60 * MIN)))} hours of readings so far. Ask again in a few days, or open the report in su94r Mini.`;
  const pct = (f) => Math.round((pts.filter(f).length / pts.length) * 100);
  const mean = pts.reduce((s, p) => s + p.mg, 0) / pts.length;
  return `This week: ${pct((p) => p.mg >= low && p.mg <= high)}% in range, ${pct((p) => p.mg < low)}% below, ${pct((p) => p.mg > high)}% above; average ${fmt(mean)}, GMI ${(3.31 + 0.02392 * mean).toFixed(1)}%.`;
}

// ---- routes ----

export async function historyRoute(path, request, url, env, { store, json, keyOk, snapshot }) {
  if (path !== 'history' && path !== 'history/import') return null;
  if (!store.ready) return json({ error: 'not configured' }, 503);
  if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);

  if (path === 'history/import') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await request.json().catch(() => ({}));
    const pid = String(body.pid || '');
    const pts = Array.isArray(body.points) ? body.points.slice(0, 5000) : [];
    if (!/^[\w-]{1,80}$/.test(pid) || !pts.length) return json({ error: 'pid and points needed' }, 400);
    const now = Date.now();
    const rows = pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > now - KEEP_DAYS * DAY && p[0] <= now + 5 * MIN)
      .map(([t, mg]) => ({ pid, t, mg }));
    return json({ ok: true, saved: await store.save(rows) });
  }

  const days = Math.min(KEEP_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 14));
  const snap = await snapshot().catch(() => ({ people: [] }));
  const people = (snap.people || []).map((p) => ({ pid: p.pid, name: p.name, firstName: p.firstName, units: p.units, low: p.low, high: p.high }));
  const now = Date.now();
  const points = {};
  for (const p of people) points[p.pid] = (await store.range(p.pid, now - days * DAY, now + MIN)).map((r) => [r.t, r.mg]);
  return json({ days, people, points });
}
