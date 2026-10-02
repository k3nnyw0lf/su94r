// ═══════════════════════════════════════════════════════════════════════════
// Google Health API → su94r.
//
// The Android counterpart to the iOS Shortcuts bridge, and strictly better:
// this is server-to-server OAuth, so it keeps working while the phone is
// locked. The iOS path cannot, because HealthKit is encrypted at lock — which
// is exactly when overnight-low detection matters most.
//
// Reads Pixel Watch / Fitbit / third-party data and writes it into the same
// health_samples table the Shortcuts bridge uses. Both sources coexist; the
// `source` column tells them apart.
//
// Replaces two dead ends: the Google Fit API (deprecated, closed to new
// signups since May 2024) and the legacy Fitbit Web API (deprecated Sept 2026).
//
// Required Worker secrets:
//   wrangler secret put GOOGLE_CLIENT_ID
//   wrangler secret put GOOGLE_CLIENT_SECRET
//   wrangler secret put GOOGLE_REDIRECT_URI    # https://<worker>/google/callback
//   wrangler secret put HEALTH_INGEST_TOKEN    # shared with health-ingest.js
//   wrangler secret put SUPABASE_URL
//   wrangler secret put SUPABASE_SERVICE_KEY
// ═══════════════════════════════════════════════════════════════════════════

const API = 'https://health.googleapis.com/v4';
const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';

/** Read-only scopes only. su94r never writes back to Google Health. */
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];

/**
 * Google data type → su94r sample type, plus how to pull a number and a
 * timestamp out of the point.
 *
 * Two shapes exist: "sample" points carry sampleTime.physicalTime, "interval"
 * and session points carry interval.startTime. int64 fields arrive as STRINGS
 * over JSON, so everything goes through Number().
 */
const SYNC_MAP = [
  {
    dataType: 'heart-rate', field: 'heartRate', type: 'heartRate', unit: 'count/min',
    at: p => p.sampleTime?.physicalTime,
    value: p => Number(p.beatsPerMinute),
  },
  {
    dataType: 'heart-rate-variability', field: 'heartRateVariability', type: 'heartRateVariability', unit: 'ms',
    at: p => p.sampleTime?.physicalTime,
    // Prefer RMSSD; fall back to SDNN when the device only reports that.
    value: p => Number(p.rootMeanSquareOfSuccessiveDifferencesMilliseconds ?? p.standardDeviationMilliseconds),
  },
  {
    dataType: 'steps', field: 'steps', type: 'steps', unit: 'count',
    at: p => p.interval?.startTime,
    value: p => Number(p.count),
  },
  {
    dataType: 'active-energy-burned', field: 'activeEnergyBurned', type: 'activeEnergy', unit: 'kcal',
    at: p => p.interval?.startTime,
    value: p => Number(p.energy?.kilocalories ?? p.kilocalories),
  },
  {
    dataType: 'active-zone-minutes', field: 'activeZoneMinutes', type: 'exerciseMinutes', unit: 'min',
    at: p => p.interval?.startTime,
    value: p => Number(p.activeZoneMinutes),
  },
  {
    // The metric that actually describes a desk job. Stored as minutes sat.
    dataType: 'sedentary-period', field: 'sedentaryPeriod', type: 'sedentaryMinutes', unit: 'min',
    at: p => p.interval?.startTime,
    value: p => durationMinutes(p.interval?.startTime, p.interval?.endTime),
  },
  {
    dataType: 'oxygen-saturation', field: 'oxygenSaturation', type: 'oxygenSaturation', unit: '%',
    at: p => p.sampleTime?.physicalTime,
    value: p => Number(p.percentage ?? p.oxygenSaturationPercentage),
  },
  {
    dataType: 'weight', field: 'weight', type: 'bodyMass', unit: 'kg',
    at: p => p.sampleTime?.physicalTime,
    // The Google Health API sends grams (weightGrams).
    value: p => (p.weightGrams != null ? Number(p.weightGrams) / 1000 : Number(p.weightKilograms ?? p.kilograms)),
  },
  {
    dataType: 'blood-glucose', field: 'bloodGlucose', type: 'bloodGlucose', unit: 'mg/dL',
    at: p => p.sampleTime?.physicalTime,
    value: p => Number(p.bloodGlucoseMilligramsPerDeciliter),
  },
  {
    dataType: 'sleep', field: 'sleep', type: 'sleepAnalysis', unit: 'min',
    at: p => p.interval?.startTime,
    value: p => durationMinutes(p.interval?.startTime, p.interval?.endTime),
  },
  {
    dataType: 'exercise', field: 'exercise', type: 'workout', unit: 'min',
    at: p => p.interval?.startTime,
    value: p => durationMinutes(p.interval?.startTime, p.interval?.endTime),
  },
];

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

function durationMinutes(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return NaN;
  return Math.round((b - a) / 60000);
}

// ─── Stateless CSRF state ───────────────────────────────────────────────────
// No KV dependency: the state is a timestamp plus an HMAC over it, keyed on the
// ingest token. Verifying it proves we issued it and that it is recent.

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison for tokens and signatures. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeState(env) {
  const ts = Date.now().toString();
  return `${ts}.${await hmac(env.HEALTH_INGEST_TOKEN, ts)}`;
}

async function verifyState(env, state) {
  const [ts, sig] = String(state || '').split('.');
  if (!ts || !sig) return false;
  if (!env.HEALTH_INGEST_TOKEN) return false;
  if (Date.now() - Number(ts) > 10 * 60_000) return false; // 10 minute window
  return safeEqual(await hmac(env.HEALTH_INGEST_TOKEN, ts), sig);
}

// ─── Token storage ──────────────────────────────────────────────────────────
// Refresh tokens live in Postgres behind the service-role key. They never
// touch the client, and no client-reachable key can read the table.

async function saveRefreshToken(env, refreshToken) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/google_health_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ id: 1, refresh_token: refreshToken, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw new Error(`token save failed: ${res.status} ${await res.text()}`);
}

async function loadRefreshToken(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/google_health_tokens?id=eq.1&select=refresh_token`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`token load failed: ${res.status}`);
  const rows = await res.json();
  return rows?.[0]?.refresh_token || null;
}

async function accessTokenFromRefresh(env, refreshToken) {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`refresh failed: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

// ─── Sync ───────────────────────────────────────────────────────────────────

/** Pulls one data type since `sinceIso`, following pagination. */
async function fetchDataPoints(accessToken, spec, sinceIso, maxPages = 5) {
  const rows = [];
  let pageToken = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      pageSize: '1000',
      filter: `${spec.dataType.replace(/-/g, '_')}.interval.start_time >= "${sinceIso}"`,
    });
    // Sample types filter on sample time, not interval.
    if (!spec.at({ interval: {} })) {
      params.set('filter', `${spec.dataType.replace(/-/g, '_')}.sample_time.physical_time >= "${sinceIso}"`);
    }
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(
      `${API}/users/me/dataTypes/${spec.dataType}/dataPoints?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      // A type the user has no data for, or hasn't granted, must not fail the
      // whole sync — every other type should still land.
      return { rows, error: `${spec.dataType}: ${res.status}` };
    }

    const data = await res.json();
    for (const dp of data.dataPoints || []) {
      const payload = dp[spec.field];
      if (!payload) continue;
      const value = spec.value(payload);
      const at = spec.at(payload);
      if (!Number.isFinite(value) || !at) continue;
      rows.push({
        type: spec.type,
        value,
        unit: spec.unit,
        recorded_at: new Date(at).toISOString(),
        source: 'google-health',
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return { rows, error: null };
}

async function writeSamples(env, rows) {
  if (!rows.length) return 0;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/health_samples`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`write failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// /google/start is not tied to a su94r sign-in. What stops a stranger from
// connecting their own Google account is Google itself: keep the OAuth app in
// Testing with only your account listed as a test user.
export async function handleStart(request, env) {
  if (!env.HEALTH_INGEST_TOKEN || !env.GOOGLE_CLIENT_ID) return json({ error: 'not configured' }, 503);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Without this, Google only returns a refresh token on the very first
    // consent — reconnecting later would silently yield none.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: await makeState(env),
  });
  return Response.redirect(`${OAUTH_AUTH}?${params}`, 302);
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const appUrl = env.APP_URL || 'https://su94r.com';

  if (url.searchParams.get('error')) {
    return Response.redirect(`${appUrl}/?tab=devices&google=denied`, 302);
  }
  if (!code || !(await verifyState(env, state))) {
    return Response.redirect(`${appUrl}/?tab=devices&google=badstate`, 302);
  }

  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    return Response.redirect(`${appUrl}/?tab=devices&google=notoken`, 302);
  }

  await saveRefreshToken(env, data.refresh_token);
  return Response.redirect(`${appUrl}/?tab=devices&google=connected`, 302);
}

export async function handleSync(request, env) {
  // Without a configured token, "Bearer undefined" would otherwise be accepted.
  if (!env.HEALTH_INGEST_TOKEN) return json({ error: 'not configured' }, 503);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(token, env.HEALTH_INGEST_TOKEN)) return json({ error: 'unauthorized' }, 401);

  const refresh = await loadRefreshToken(env);
  if (!refresh) return json({ error: 'not connected' }, 409);

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 2, 1), 30);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const accessToken = await accessTokenFromRefresh(env, refresh);

  let written = 0;
  const errors = [];
  for (const spec of SYNC_MAP) {
    try {
      const { rows, error } = await fetchDataPoints(accessToken, spec, since);
      if (error) errors.push(error);
      written += await writeSamples(env, rows);
    } catch (e) {
      errors.push(`${spec.dataType}: ${e.message}`);
    }
  }

  return json({ written, since, errors });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/google/start') return handleStart(request, env);
    if (pathname === '/google/callback') return handleCallback(request, env);
    if (pathname === '/google/sync') return handleSync(request, env);
    return json({ error: 'not found' }, 404);
  },

  /** Hourly pull. Cron in wrangler.toml: crons = ["0 * * * *"] */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      handleSync(
        new Request('https://internal/google/sync?days=1', {
          headers: { Authorization: `Bearer ${env.HEALTH_INGEST_TOKEN}` },
        }),
        env
      )
    );
  },
};
