// ═══════════════════════════════════════════════════════════════════════════
// su94r-proxy — the one public address for the PWA, the night monitor, screens
// and Alexa.
//
// Until this file, the deployed proxy existed only on Cloudflare (no source in
// the repo) and had drifted from everything that depends on it:
//   • LibreLinkUp now requires app version ≥4.12 and an account-id header, and
//     its bot shield refuses Cloudflare Workers outright (403). The old proxy
//     could not get Libre data at all.
//   • The glucose monitor calls /glucose/latest — a route the old proxy never
//     had, so every five-minute check saw "fetch failed".
//   • /health/ingest and /google/* were written "to add to the proxy" and
//     documented at this URL, but never wired in.
//
// Routes that must reach LibreLinkUp are forwarded to the Supabase edge
// function su94r-cgm (workers/cgm-core.js), which LibreView does not block and
// which holds the LibreLinkUp, display and Alexa secrets:
//   POST /libre/login, /libre/readings     the PWA
//   GET  /glucose/latest                   the monitor
//   GET  /display/data                     what the big-screen page polls
//   POST /alexa                            the Alexa skill
// Served here:
//   GET  /display?key=…, /d/<key>          big-screen page (TV, Echo Show, tablet)
//   GET  /tv                               the same page, paired with a short code instead of a key
//   POST /dexcom/*, /nightscout/readings   unchanged from the deployed proxy
//   POST /health/ingest, /google/*         Apple Health and Google Health intake
//
// Vars: CGM_URL (wrangler.proxy.toml). Secrets for /health and /google:
//   HEALTH_INGEST_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_*
// ═══════════════════════════════════════════════════════════════════════════

import { handleHealthIngest } from './health-ingest.js';
import { handleStart, handleCallback, handleSync } from './google-health.js';
import { displayPage } from './display.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const FORWARDED = new Set(['/libre/login', '/libre/readings', '/glucose/latest', '/display/data', '/alexa', '/voice/sync',
  '/pair/start', '/pair/poll', '/pair/claim', '/screen/data', '/screens', '/screens/remove']);

async function forward(request, url, env) {
  if (!env.CGM_URL) return json({ error: 'CGM_URL is not set' }, 503);
  const headers = new Headers();
  // Alexa's signature headers must arrive untouched, with the body byte for byte.
  for (const h of ['content-type', 'authorization', 'signaturecertchainurl', 'signature-256']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const res = await fetch(`${env.CGM_URL}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
  });
  const out = new Headers(CORS);
  out.set('Content-Type', res.headers.get('content-type') || 'application/json');
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers: out });
}

// Unchanged from the deployed proxy apart from input checks and JSON-safe responses.
async function dexcomLogin(request) {
  const { username, password, server } = await request.json();
  const host = server === 'ous' ? 'shareous1.dexcom.com' : 'share2.dexcom.com';
  const res = await fetch(`https://${host}/ShareWebServices/Services/General/AuthenticatePublisherAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountName: username, password, applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db' }),
  });
  return json({ sessionId: await res.json(), host });
}

async function dexcomReadings(request) {
  const { sessionId, host } = await request.json();
  if (!/^share(2|ous1)\.dexcom\.com$/.test(host || '')) return json({ error: 'bad host' }, 400);
  const res = await fetch(`https://${host}/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(sessionId)}&minutes=180&maxCount=36`);
  const readings = await res.json();
  const trendMap = { 1: 3, 2: 5, 3: 5, 4: 4, 5: 3, 6: 2, 7: 2, 8: 1, 9: 3 };
  return json({
    current: { value: readings[0]?.Value, trend: trendMap[readings[0]?.Trend] || 3, timestamp: readings[0]?.DT, source: 'dexcom' },
    history: readings.map((r) => ({ value: r.Value, trend: trendMap[r.Trend] || 3, timestamp: r.DT })),
  });
}

/**
 * Builds the entries URL with the URL API, so a "?" or "#" in what the user typed
 * cannot change which path or query reaches their Nightscout. Keeps a sub-path
 * (some sites live under /ns/), drops any query, fragment or user:password.
 */
export function nightscoutEntriesUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const base = new URL(u.origin + u.pathname.replace(/\/*$/, '/'));
  const out = new URL('api/v1/entries.json', base);
  out.searchParams.set('count', '36');
  return out.toString();
}

async function nightscoutReadings(request) {
  const { url: nsUrl, token } = await request.json();
  const endpoint = nightscoutEntriesUrl(nsUrl);
  if (!endpoint) return json({ error: 'Nightscout URL must be a plain https:// address' }, 400);
  const res = await fetch(endpoint, { headers: token ? { 'api-secret': String(token) } : {} });
  if (!res.ok) return json({ error: `Nightscout answered ${res.status}` }, 502);
  const entries = await res.json();
  if (!Array.isArray(entries)) return json({ error: 'Nightscout did not return a list of entries' }, 502);
  const dirMap = { Flat: 3, FortyFiveDown: 2, FortyFiveUp: 4, SingleDown: 1, SingleUp: 5, DoubleDown: 1, DoubleUp: 5, NOT_COMPUTABLE: 3 };
  return json({
    current: { value: entries[0]?.sgv, trend: dirMap[entries[0]?.direction] || 3, timestamp: new Date(entries[0]?.dateString).toISOString(), source: 'nightscout' },
    history: entries.map((e) => ({ value: e.sgv, trend: dirMap[e.direction] || 3, timestamp: new Date(e.dateString).toISOString() })),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (FORWARDED.has(path)) return await forward(request, url, env);
      if (path === '/tv' || path === '/tv/') {
        // Pairing screen: shows a code; su94r Mini enters it; the screen keeps its own token.
        return new Response(displayPage('', { pair: true }), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
        });
      }
      if (path === '/display' || path.startsWith('/d/')) {
        // The page holds no data; it shows what /display/data returns for its key,
        // and the key is checked there (by su94r-cgm).
        const key = path.startsWith('/d/') ? decodeURIComponent(path.slice(3)) : url.searchParams.get('key') || '';
        return new Response(displayPage(key), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
        });
      }
      if (path === '/dexcom/login' && request.method === 'POST') return await dexcomLogin(request);
      if (path === '/dexcom/readings' && request.method === 'POST') return await dexcomReadings(request);
      if (path === '/nightscout/readings' && request.method === 'POST') return await nightscoutReadings(request);
      if (path === '/health/ingest') return await handleHealthIngest(request, env);
      if (path === '/google/start') return await handleStart(request, env);
      if (path === '/google/callback') return await handleCallback(request, env);
      if (path === '/google/sync') return await handleSync(request, env);
      return new Response('su94r CGM proxy alive', { headers: CORS });
    } catch (err) {
      return json({ error: String(err?.message || err).slice(0, 300) }, 500);
    }
  },
};
