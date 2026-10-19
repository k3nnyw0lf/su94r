// Dexcom Share: the service the Dexcom Follow app reads, for su94r family accounts.
// The Dexcom account that runs the CGM (Share turned on in the Dexcom app, with at least one
// follower) signs in: AuthenticatePublisherAccount → account id, LoginPublisherAccountById →
// session id, ReadPublisherLatestGlucoseValues → readings. Unofficial, like every Share client
// (Nightscout's bridge, xDrip+); Dexcom Follow stays the official alarm.

export const DEXCOM_APP_ID = 'd89443d2-327c-4a6f-89e5-496bbb0317db';
export const DEXCOM_HOSTS = { us: 'share2.dexcom.com', ous: 'shareous1.dexcom.com', jp: 'share.dexcom.jp' };
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

export class DexcomError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Dexcom trend (name, or its number in older answers) → su94r's 1–5 (1 ↓ falling fast … 5 ↑ rising fast).
const BY_NAME = { DoubleUp: 5, SingleUp: 5, FortyFiveUp: 4, Flat: 3, FortyFiveDown: 2, SingleDown: 1, DoubleDown: 1 };
const BY_NUMBER = [0, 5, 5, 4, 3, 2, 1, 1, 0, 0];
export function dexcomTrend(t) {
  if (typeof t === 'number') return BY_NUMBER[t] ?? 0;
  if (t in BY_NAME) return BY_NAME[t];
  return /^\d+$/.test(String(t)) ? BY_NUMBER[Number(t)] ?? 0 : 0;
}
/** "Date(1697000000000)", "/Date(1697000000000-0400)/" → epoch ms (the number is already UTC). */
export function dexcomTime(s) {
  const m = String(s ?? '').match(/(-?\d{10,})/);
  return m ? Number(m[1]) : NaN;
}

function classify(status, body) {
  const code = String(body?.Code || '');
  const text = `${code} ${body?.Message || ''}`;
  if (/MaxAttempts|locked/i.test(text)) return 'locked';
  if (/AccountPasswordInvalid|AuthenticateAccountNotFound|AuthenticatePasswordInvalid|InvalidArgument|accountName|password/i.test(text)) return 'credentials';
  if (/Session/i.test(text)) return 'auth';
  return 'dexcom';
}

async function call(host, path, body, fetchImpl) {
  const res = await fetchImpl(`https://${host}/ShareWebServices/Services/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const code = classify(res.status, data);
    const msg = code === 'credentials' ? 'Dexcom did not accept that username and password.'
      : code === 'locked' ? 'Dexcom locked the account after too many tries. Wait about 10 minutes.'
        : code === 'auth' ? 'The Dexcom session ended.' : `Dexcom answered ${res.status}.`;
    throw new DexcomError(msg, code);
  }
  return data;
}

/** Signs in to Dexcom Share. region: us (default), ous (outside the US) or jp. */
export async function dexcomLogin(username, password, { region = 'us', fetchImpl = (...a) => fetch(...a) } = {}) {
  const host = DEXCOM_HOSTS[region] || DEXCOM_HOSTS.us;
  if (!username || !password) throw new DexcomError('Enter the Dexcom username and password.', 'credentials');
  const accountId = await call(host, 'General/AuthenticatePublisherAccount', { accountName: username, password, applicationId: DEXCOM_APP_ID }, fetchImpl);
  if (typeof accountId !== 'string' || !accountId || accountId === ZERO_ID) throw new DexcomError('Dexcom did not accept that username and password.', 'credentials');
  const sessionId = await call(host, 'General/LoginPublisherAccountById', { accountId, password, applicationId: DEXCOM_APP_ID }, fetchImpl);
  if (typeof sessionId !== 'string' || !sessionId || sessionId === ZERO_ID) throw new DexcomError('Dexcom did not accept that username and password.', 'credentials');
  return { host, sessionId, at: Date.now() };
}

/** The readings of the last `minutes` (oldest first): [{ t, mg, trend }]. */
export async function dexcomReadings(session, { minutes = 720, maxCount = 144, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!session?.sessionId || !Object.values(DEXCOM_HOSTS).includes(session.host)) throw new DexcomError('No Dexcom session.', 'auth');
  const q = `sessionId=${encodeURIComponent(session.sessionId)}&minutes=${Number(minutes) || 720}&maxCount=${Number(maxCount) || 144}`;
  const list = await call(session.host, `Publisher/ReadPublisherLatestGlucoseValues?${q}`, null, fetchImpl);
  return (Array.isArray(list) ? list : [])
    .map((r) => ({ t: dexcomTime(r.WT ?? r.ST ?? r.DT), mg: Number(r.Value), trend: dexcomTrend(r.Trend) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.mg) && p.mg > 0)
    .sort((a, b) => a.t - b.t);
}
