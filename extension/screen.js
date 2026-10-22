// su94r family screens in su94r Mini: a family's su94r account (Dexcom, or a Libre follower) reaches
// this browser the way it reaches their Tesla. su94r Mini asks su94r for a 6-character code, the
// family types it on their settings page (su94r.com/sugar/family → Screens), and from then on the
// server sends the family's readings. No Dexcom or Libre password is kept in this browser, and the
// family's account stays its own: nothing here reaches anyone else's su94r.

export class ScreenError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const base = (server) => String(server || '').replace(/\/+$/, '');
const net = (...a) => fetch(...a);

async function call(server, path, init, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${base(server)}/${path}`, { cache: 'no-store', ...init });
  } catch {
    throw new ScreenError('Could not reach su94r. Check the internet connection.', 'net');
  }
  const j = await res.json().catch(() => ({}));
  return { res, j };
}

const postJson = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Asks su94r for a code to type on the family's settings page: { code, secret, expiresIn }. */
export async function pairStart(server, fetchImpl = net) {
  const { res, j } = await call(server, 'pair/start', postJson({ kind: 'screen' }), fetchImpl);
  if (!res.ok || !j.code || !j.secret) throw new ScreenError(j.error || `su94r answered ${res.status}.`, 'net');
  return { code: j.code, secret: j.secret, expiresIn: j.expiresIn || 900 };
}

/** Whether the code was typed: { status: 'paired', token, name } (once), 'waiting' or 'expired'. */
export async function pairPoll(server, secret, fetchImpl = net) {
  const { res, j } = await call(server, 'pair/poll', postJson({ secret }), fetchImpl);
  if (!res.ok) throw new ScreenError(j.error || `su94r answered ${res.status}.`, 'net');
  if (j.status === 'paired' && j.token) return { status: 'paired', token: j.token, name: j.name || '' };
  if (j.status === 'waiting') return { status: 'waiting' };
  return { status: 'expired' };   // expired, unknown, or paired with the token already handed over
}

/** The family's readings, as their screens get them. A screen removed on the settings page gets 401: code 'auth'. */
export async function screenData(server, token, fetchImpl = net) {
  const { res, j } = await call(server, 'screen/data', { headers: { Authorization: `Bearer ${token}` } }, fetchImpl);
  if (res.status === 401) throw new ScreenError('This computer was removed from the family\'s su94r screens. Remove it here and pair it again.', 'auth');
  if (!res.ok || j.error) throw new ScreenError(j.error || `su94r answered ${res.status}.`, 'net');
  return j;
}

const target = (v, fallback) => (Number.isFinite(v) && v >= 40 && v <= 400 ? v : fallback);
const point = (t, mg, trend = null) => ({ t: Number(t), mg: Math.round(Number(mg)), trend: Number.isInteger(trend) && trend >= 1 && trend <= 5 ? trend : null });
const real = (q) => Number.isFinite(q.t) && Number.isFinite(q.mg) && q.mg > 0;

/** The family's people as su94r Mini's people: one id per account and place, points as { t, mg, trend }. */
export function screenPeople(acc, data) {
  return (data?.people || []).map((p, i) => {
    const l = p.latest && point(p.latest.t, p.latest.mg, p.latest.trend);
    return {
      pid: `${acc.id}-${i}`,
      name: String(p.name || 'Unnamed').slice(0, 60),
      units: p.units === 'mmol/L' ? 'mmol/L' : 'mg/dL',
      low: target(p.low, 70),
      high: target(p.high, 180),
      latest: l && real(l) ? l : null,
      history: (p.history || []).map(([t, mg]) => point(t, mg)).filter(real),
    };
  });
}

/** The account id for a screen: stable for its token, and never the token itself. */
export async function screenAccountId(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return `su94r-${[...new Uint8Array(hash)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
