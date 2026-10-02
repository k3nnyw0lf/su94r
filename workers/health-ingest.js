// ═══════════════════════════════════════════════════════════════════════════
// Apple Health → su94r ingest endpoint.
//
// Add this route to the existing su94r-proxy Worker. An iOS Shortcut reads
// HealthKit samples on a schedule and POSTs them here; the Worker validates a
// shared secret and writes to Supabase using the service-role key.
//
// Why a Worker rather than posting to Supabase directly from the Shortcut:
// the Shortcut would have to carry a key. The anon key can't write without
// opening up RLS, and the service-role key must never leave the server. The
// Worker holds the service-role key as a secret and the Shortcut only ever
// carries a rotatable ingest token.
//
// Required Worker secrets:
//   wrangler secret put HEALTH_INGEST_TOKEN     # random string, also in the Shortcut
//   wrangler secret put SUPABASE_SERVICE_KEY    # service_role key
//   wrangler secret put SUPABASE_URL
// ═══════════════════════════════════════════════════════════════════════════

/** HealthKit sample types the Shortcut is allowed to send. */
const ALLOWED_TYPES = new Set([
  'heartRate', 'heartRateVariability', 'restingHeartRate',
  'steps', 'activeEnergy', 'basalEnergy', 'exerciseMinutes', 'standHours',
  'sleepAnalysis', 'respiratoryRate', 'oxygenSaturation',
  'bodyMass', 'bodyFatPercentage', 'vo2Max',
  'bloodGlucose', 'workout',
  // Google Health only — Apple has no equivalent. Minutes spent sitting, which
  // is the metric that actually characterises a desk job.
  'sedentaryMinutes',
  // Body composition from a smart scale. muscleMass and visceralFat are the
  // two worth watching here: on a desk worker adding resistance training,
  // scale weight can sit flat while composition moves in the right direction,
  // and visceral fat tracks insulin resistance more closely than BMI does.
  'muscleMass', 'boneMass', 'bodyWater', 'visceralFat', 'bmi', 'basalMetabolicRate',
]);

const MAX_SAMPLES = 2000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

/**
 * Constant-time-ish comparison. Worker CPU time is short enough that a naive
 * === leaks little, but there is no reason to be sloppy about a bearer token.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Normalises one incoming sample. Returns null if it is unusable, so a single
 * malformed row from Shortcuts never fails the whole batch.
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  if (!ALLOWED_TYPES.has(type)) return null;

  const value = Number(raw.value);
  if (!Number.isFinite(value)) return null;

  const ts = raw.timestamp ? new Date(raw.timestamp) : null;
  if (!ts || Number.isNaN(ts.getTime())) return null;

  // Reject anything implausibly far in the future — a mis-set clock shouldn't
  // poison the correlation windows.
  if (ts.getTime() > Date.now() + 6 * 3600_000) return null;

  return {
    type,
    value,
    unit: typeof raw.unit === 'string' ? raw.unit.slice(0, 24) : null,
    recorded_at: ts.toISOString(),
    source: typeof raw.source === 'string' ? raw.source.slice(0, 64) : 'apple-health',
  };
}

export async function handleHealthIngest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.HEALTH_INGEST_TOKEN || !safeEqual(token, env.HEALTH_INGEST_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const incoming = Array.isArray(body) ? body : Array.isArray(body?.samples) ? body.samples : null;
  if (!incoming) return json({ error: 'expected an array of samples' }, 400);
  if (incoming.length > MAX_SAMPLES) return json({ error: `max ${MAX_SAMPLES} samples per request` }, 413);

  const rows = incoming.map(normalize).filter(Boolean);
  const rejected = incoming.length - rows.length;

  // An empty batch is the normal case when the phone was locked and HealthKit
  // returned nothing. That is not an error — report it and move on.
  if (!rows.length) return json({ accepted: 0, rejected, note: 'nothing to write' });

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/health_samples`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      // Same sample re-sent by an overlapping Shortcut run is ignored rather
      // than duplicated — see the unique index in docs/apple-health.md.
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'supabase write failed', status: res.status, detail: detail.slice(0, 300) }, 502);
  }

  return json({ accepted: rows.length, rejected });
}

/** Wire into the proxy Worker's existing router. */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health/ingest') return handleHealthIngest(request, env);
    return json({ error: 'not found' }, 404);
  },
};
