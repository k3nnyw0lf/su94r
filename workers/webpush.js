// Low alerts that ring in the su94r phone app: Web Push (RFC 8030 delivery, RFC 8291 message
// encryption, RFC 8292 VAPID). No library, only WebCrypto, so the same code runs in the Supabase
// edge function (Deno), in Node tests and in Workers.
//
// The server makes its own VAPID key pair the first time a phone asks for it (su94r_push_key,
// service role only, the private key never leaves the server). A phone subscribes from the app
// (app/push/subscribe in app.js); its subscription is kept in su94r_push, tied to the phone's
// linked-phone row, so removing the phone in su94r Mini removes its alerts too.
//
// The night check (night.js) sends each alert to the phones of its role: the owner's own phones
// get every alert, family phones only what the care ladder sends them. A push service saying a
// subscription is gone (404/410) removes it.
//
// Table: migration 20261002p_su94r_app_push_treat.sql.

import { inLanguage } from './night.js';

const enc = new TextEncoder();

export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(s) {
  const str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(str + '='.repeat((4 - (str.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const ZERO = new Uint8Array([0]);
const ONE = new Uint8Array([1]);
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// The push services a subscription may point at; the server posts nowhere else.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([\w-]+\.)*push\.apple\.com$/, /^[\w-]+\.notify\.windows\.com$/];
export function pushEndpointOk(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && !u.username && String(endpoint).length <= 1000 && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}

const RECORD = 4096;

/** RFC 8291 + RFC 8188 (aes128gcm): the encrypted body of one push message. */
export async function encryptPush(payload, p256dh, auth, { salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2]));   // 2: the last record
  if (plain.length + 16 > RECORD) throw new Error('message too long');
  const server = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));
  // Key and nonce (HKDF with SHA-256; each output is one block, so Expand is one HMAC).
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info'), ZERO, uaPublic, asPublic, ONE));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm'), ZERO, ONE))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce'), ZERO, ONE))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([(RECORD >>> 24) & 255, (RECORD >>> 16) & 255, (RECORD >>> 8) & 255, RECORD & 255]);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** A new VAPID key pair: the public key as the app needs it, the private key as JWK to keep. */
export async function makeVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

/** The Authorization header for one push service (RFC 8292). */
export async function vapidHeader(endpoint, keys, { subject = 'https://su94r.com', now = Date.now() } = {}) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** One message to one subscription. { status, gone } — gone means remove the subscription. */
export async function sendPush(sub, message, keys, { fetchImpl = (...a) => fetch(...a), ttl = 900, urgency = 'high', now = Date.now() } = {}) {
  if (!pushEndpointOk(sub.endpoint)) return { status: 0, gone: true };
  const body = await encryptPush(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl), Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Authorization: await vapidHeader(sub.endpoint, keys, { now }),
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** What a night-check alert ({ title, message, priority, actions }) looks like as a notification. */
export function notificationFor(msg) {
  const action = (msg.actions || []).find((a) => a && a.url) || null;
  const ackUrl = action?.url || null;
  let ack = null;
  if (ackUrl) { try { const u = new URL(ackUrl); if (/^\?t=[0-9a-f]{32}$/.test(u.search)) ack = `/night/ack${u.search}`; } catch { /* no button */ } }
  const alert = (msg.priority || 3) >= 4 || (msg.tags || []).includes('white_check_mark');
  return {
    title: String(msg.title || 'su94r').slice(0, 120),
    body: String(msg.message || '').slice(0, 600),
    tag: alert ? 'su94r-alert' : 'su94r-info',     // a reminder or "Back up" replaces the alert before it
    urgent: (msg.priority || 3) >= 5,
    ack,
    ...(ack && action.label && action.label !== "I'm OK" ? { ackLabel: String(action.label).slice(0, 20) } : {}),
  };
}

export function pushStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const root = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(root && key);
  async function call(table, path, init = {}) {
    if (!ready) throw Object.assign(new Error('App alerts are not configured'), { code: 'config' });
    const res = await fetchImpl(`${root}/${table}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`App alert store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  let cached = null;
  async function keyRow() {
    let rows = await call('su94r_push_key', '?select=public_key,private_jwk&id=eq.1');
    if (!rows.length) {
      const k = await makeVapidKeys();
      await call('su94r_push_key', '?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ id: 1, public_key: k.publicKey, private_jwk: k.privateJwk }) });
      rows = await call('su94r_push_key', '?select=public_key,private_jwk&id=eq.1');   // the one that won, if two phones asked at once
    }
    return rows[0];
  }
  return {
    ready,
    async publicKey() { return (await keyRow()).public_key; },
    async keys() {
      if (!cached) {
        const row = await keyRow();
        cached = { publicKey: row.public_key, privateKey: await crypto.subtle.importKey('jwk', row.private_jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
      }
      return cached;
    },
    add: (screenId, sub) => call('su94r_push', '?on_conflict=endpoint', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ screen_id: screenId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, failures: 0, lang: sub.lang === 'es' ? 'es' : 'en' }),
    }),
    remove: (screenId, endpoint) => call('su94r_push', `?screen_id=eq.${q(screenId)}&endpoint=eq.${q(endpoint)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
    forScreen: (screenId) => call('su94r_push', `?select=id,endpoint,p256dh,auth,failures,lang&screen_id=eq.${q(screenId)}`),
    /** Subscriptions of linked phones with this role ('me' or 'family') that are still linked. */
    forRole: (role) => call('su94r_push', `?select=id,endpoint,p256dh,auth,failures,lang,su94r_screens!inner(role,revoked)&su94r_screens.role=eq.${q(role)}&su94r_screens.revoked=is.false`),
    gone: (id) => call('su94r_push', `?id=eq.${q(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
    ok: (id) => call('su94r_push', `?id=eq.${q(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ failures: 0, last_ok_at: new Date().toISOString() }) }),
    failed: (id, n) => call('su94r_push', `?id=eq.${q(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ failures: n }) }),
  };
}

/** Sends to a list of subscriptions; returns how many push services took the message. */
export async function pushTo(store, subs, msg, opts = {}) {
  if (!store?.ready || !subs.length) return 0;
  const keys = await store.keys();
  const results = await Promise.allSettled(subs.map((s) => {
    const note = notificationFor(inLanguage(msg, s.lang));
    return sendPush(s, note, keys, { ...opts, urgency: note.urgent || note.tag === 'su94r-alert' ? 'high' : 'normal' });
  }));
  let delivered = 0;
  await Promise.all(results.map(async (r, i) => {
    const sub = subs[i];
    if (r.status === 'fulfilled' && r.value.status >= 200 && r.value.status < 300) { delivered++; await store.ok(sub.id).catch(() => {}); return; }
    if (r.status === 'fulfilled' && r.value.gone) { await store.gone(sub.id).catch(() => {}); return; }
    // Kept for now; one that keeps failing is dropped after 20 tries.
    const n = (sub.failures || 0) + 1;
    await (n >= 20 ? store.gone(sub.id) : store.failed(sub.id, n)).catch(() => {});
  }));
  return delivered;
}

/** The night check's alert, to every linked phone of this role that turned app alerts on. */
export async function pushToPhones(store, role, msg, opts = {}) {
  if (!store?.ready) return 0;
  return pushTo(store, await store.forRole(role === 'family' ? 'family' : 'me'), msg, opts);
}
