// The learner's estimate, for "Alexa, ask my sugar where I'm heading".
//
// The learner runs in su94r Mini (extension/learner.js), on the computer that has the history.
// With each dose exchange (voice/sync, about once a minute) su94r Mini sends, per person, the
// estimate for 30 and 60 minutes ahead with its 80% range, but only when the learner has
// passed its accuracy check (the same check that lets it draw the estimate line); otherwise it
// sends only that it is not trusted yet. Alexa reads it when it is fresh, and never turns it
// into a dosing suggestion.
//
// Table public.su94r_forecast (migration 20261002f_su94r_voice_carbs.sql), service role only.

const FRESH_MS = 20 * 60e3;

export function forecastStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_forecast`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('The forecast store is not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Forecast store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  return {
    ready,
    async save(list) {
      if (!list.length) return;
      const now = new Date().toISOString();
      await call('?on_conflict=pid', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(list.map((f) => ({ pid: f.p, at: new Date(f.at).toISOString(), data: f, updated_at: now }))),
      });
    },
    async get(pid) {
      const rows = await call(`?select=*&pid=eq.${encodeURIComponent(pid)}`);
      return rows[0]?.data || null;
    },
  };
}

const mgOk = (v) => Number.isFinite(v) && v >= 30 && v <= 450;
const pointOk = (q) => q == null || (mgOk(q.mg) && mgOk(q.lo) && mgOk(q.hi) && q.lo <= q.mg && q.mg <= q.hi);

/** What su94r Mini sent, kept only if it is shaped right (numbers in range, recent). */
export function cleanForecasts(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).slice(0, 12).flatMap((f) => {
    if (!f || typeof f.p !== 'string' || f.p.length > 80 || !Number.isFinite(f.at) || now - f.at > 60 * 60e3 || f.at > now + 5 * 60e3) return [];
    if (!f.trusted) return [{ p: f.p, at: f.at, trusted: false }];
    if (!mgOk(f.mg) || !pointOk(f.h30) || !pointOk(f.h60) || (!f.h30 && !f.h60)) return [];
    const pick = (q) => (q ? { mg: Math.round(q.mg), lo: Math.round(q.lo), hi: Math.round(q.hi) } : null);
    return [{ p: f.p, at: f.at, mg: Math.round(f.mg), trusted: true, horizon: Math.min(60, Number(f.horizon) || 60), h30: pick(f.h30), h60: pick(f.h60) }];
  });
}

/** The spoken answer. Plain numbers and ranges; no advice beyond keeping fast sugar close. */
export function speakForecast(f, { units = 'mg/dL', name = '', now = Date.now() } = {}) {
  const who = name ? `${name}'s` : 'your';
  if (!f || now - f.at > FRESH_MS) {
    return `I don't have a fresh estimate for ${name || 'you'}. su94r Mini makes it on your computer from your own history, and it has not sent one in the last 20 minutes.`;
  }
  if (!f.trusted) {
    return `su94r Mini's learner has not earned trust yet for ${name || 'you'}, so I won't guess. It needs more days of readings with doses and meals logged, and it has to beat a simple guess on days it did not learn from.`;
  }
  const mmol = units === 'mmol/L';
  const v = (mg) => (mmol ? (mg / 18.0182).toFixed(1) : String(Math.round(mg)));
  const part = (q, when) => (q ? `${when}, likely about ${v(q.mg)}, between ${v(q.lo)} and ${v(q.hi)}` : null);
  const parts = [part(f.h30, 'In half an hour'), part(f.h60, 'In an hour')].filter(Boolean);
  const lows = [f.h30, f.h60].filter(Boolean).map((q) => q.lo);
  const lowEnd = Math.min(...lows);
  const care = lowEnd < 70 ? ` The low end of that range is under ${mmol ? '3.9' : '70'}, so keep fast sugar close.` : '';
  return `${parts.join('. ')}.${care} This is an estimate from ${who} own past data, not a reason to dose.`;
}
