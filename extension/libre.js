// LibreLinkUp client. This is the unofficial API the LibreLinkUp phone app uses;
// Abbott publishes no official one, so it can change without notice.

export const DEFAULT_BASE = 'https://api.libreview.io';
export const DEFAULT_VERSION = '4.16.0';
export const MGDL_PER_MMOL = 18.0182;

export class LibreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function send(base, path, { method = 'GET', body, token, accountId, version } = {}) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'cache-control': 'no-cache',
    product: 'llu.android',
    version: version || DEFAULT_VERSION,
    // LibreView sits behind a bot shield that answers 403 to requests with no User-Agent.
    // Browsers always send their own (and ignore this); Cloudflare Workers send none.
    'user-agent': 'Mozilla/5.0 (compatible; su94r; +https://su94r.com)',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (accountId) headers['account-id'] = accountId;

  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new LibreError('network', e.name === 'TimeoutError'
      ? 'LibreLinkUp did not answer in time.'
      : 'Cannot reach LibreLinkUp (offline?).');
  }

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }

  if (res.status === 429) throw new LibreError('rate', 'LibreLinkUp is rate-limiting. Retrying shortly.');
  // Only a real expired session signs the account out. A 403 from LibreView's bot
  // shield or a 400 with no explanation is treated as a passing error and retried.
  const said = String(json?.message || json?.error?.message || '');
  if (token && (res.status === 401 || ([400, 403].includes(res.status) && /jwt|token|unauthori|expired/i.test(said)))) {
    throw new LibreError('auth', 'Your LibreLinkUp session expired. Sign in again.');
  }
  if (!res.ok && !json) throw new LibreError('http', `LibreLinkUp returned HTTP ${res.status}. Retrying shortly.`);
  if (!json) throw new LibreError('http', `LibreLinkUp returned HTTP ${res.status}.`);
  return json;
}

// Returns a session object: { base, version, token, expires, userId, accountId }.
export async function login(email, password, { base = DEFAULT_BASE, version = DEFAULT_VERSION } = {}) {
  for (let hop = 0; hop < 5; hop++) {
    const j = await send(base, '/llu/auth/login', { method: 'POST', body: { email, password }, version });

    if (j.status === 920 && j.data?.minimumVersion && j.data.minimumVersion !== version) {
      version = j.data.minimumVersion;
      continue;
    }
    if (j.status === 2) throw new LibreError('credentials', 'Wrong email or password. Use your LibreLinkUp login.');
    if (j.status === 4) {
      const step = j.data?.step?.type;
      throw new LibreError('terms', step === 'verifyEmail'
        ? 'LibreLinkUp wants you to verify your email first. Check your inbox, then try again.'
        : 'LibreLinkUp needs you to accept its terms. Open the LibreLinkUp app on your phone, sign in, accept, then try again.');
    }
    if (j.status === 429) {
      const mins = Math.ceil((j.data?.data?.lockout || 300) / 60);
      throw new LibreError('locked', `Too many sign-in attempts. LibreLinkUp blocked sign-in for about ${mins} min.`);
    }
    if (j.status !== 0) {
      throw new LibreError('login', j.error?.message || `Sign-in failed (LibreLinkUp status ${j.status}).`);
    }
    if (j.data?.redirect && j.data.region) {
      base = `https://api-${j.data.region}.libreview.io`;
      continue;
    }

    const token = j.data?.authTicket?.token;
    const userId = j.data?.user?.id;
    if (!token || !userId) throw new LibreError('login', 'LibreLinkUp sent an unexpected sign-in reply.');
    return {
      base,
      version,
      token,
      expires: j.data.authTicket.expires,
      userId,
      accountId: await sha256Hex(userId),
    };
  }
  throw new LibreError('login', 'LibreLinkUp kept redirecting the sign-in. Try again later.');
}

async function authed(session, path) {
  let s = session;
  for (let attempt = 0; attempt < 2; attempt++) {
    const j = await send(s.base, path, { token: s.token, accountId: s.accountId, version: s.version });
    if (j.status === 920 && j.data?.minimumVersion && j.data.minimumVersion !== s.version) {
      s = { ...s, version: j.data.minimumVersion };
      continue;
    }
    // Every reply carries a fresh ticket; keeping it means the session never ages out while polling.
    if (j.ticket?.token) s = { ...s, token: j.ticket.token, expires: j.ticket.expires };
    if (j.status !== 0) {
      throw new LibreError('api', j.error?.message || j.message || `LibreLinkUp error (status ${j.status}).`);
    }
    return { data: j.data, session: s };
  }
  throw new LibreError('api', 'LibreLinkUp rejected the app version.');
}

export async function getConnections(session) {
  const { data, session: s } = await authed(session, '/llu/connections');
  return { connections: Array.isArray(data) ? data : [], session: s };
}

export async function getGraph(session, patientId) {
  const { data, session: s } = await authed(session, `/llu/connections/${encodeURIComponent(patientId)}/graph`);
  return {
    connection: data?.connection || null,
    graphData: data?.graphData || [],
    activeSensors: data?.activeSensors || [],
    session: s,
  };
}

// Sensor activation time ("a", unix seconds) lets us count down to the end of wear.
export function sensorOf(connection, activeSensors = []) {
  const s = connection?.sensor || activeSensors[0]?.sensor;
  let start = Number(s?.a);
  if (!Number.isFinite(start) || start <= 0) return null;
  if (start < 1e12) start *= 1000;
  const now = Date.now();
  if (start > now + 864e5 || start < now - 30 * 864e5) return null;
  return { sn: s.sn || String(start), start };
}

// Libre timestamps look like "10/1/2026 2:05:31 PM". FactoryTimestamp is UTC, Timestamp is sensor-local.
export function parseLibreTime(str, utc = true) {
  if (!str) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(String(str).trim());
  if (!m) {
    const t = Date.parse(str);
    return Number.isNaN(t) ? null : t;
  }
  const [, mo, d, y, hh, mi, se, ap] = m;
  let h = Number(hh);
  if (ap) {
    const pm = ap.toUpperCase() === 'PM';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return utc
    ? Date.UTC(+y, +mo - 1, +d, h, +mi, +se)
    : new Date(+y, +mo - 1, +d, h, +mi, +se).getTime();
}

export function toPoint(m) {
  if (!m) return null;
  const t = parseLibreTime(m.FactoryTimestamp, true) ?? parseLibreTime(m.Timestamp, false);
  let mg = Number(m.ValueInMgPerDl);
  if (!Number.isFinite(mg) || mg <= 0) {
    const v = Number(m.Value);
    if (!Number.isFinite(v) || v <= 0) return null;
    mg = m.GlucoseUnits === 0 ? v * MGDL_PER_MMOL : v;
  }
  if (!t) return null;
  return { t, mg: Math.round(mg), trend: Number.isInteger(m.TrendArrow) ? m.TrendArrow : null };
}

// GlucoseUnits: 1 = mg/dL, 0 = mmol/L.
export function unitsOf(connection) {
  const u = connection?.glucoseMeasurement?.GlucoseUnits ?? connection?.uom;
  return u === 0 ? 'mmol/L' : 'mg/dL';
}
