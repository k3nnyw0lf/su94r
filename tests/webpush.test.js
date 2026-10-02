// Web Push (workers/webpush.js). What must hold: the message encryption matches RFC 8291's worked
// example byte for byte and decrypts as a browser would; the VAPID header verifies with the public
// key; the server posts only to real push services; a subscription the push service says is gone
// is removed; night alerts keep their "I'm OK" button as a same-site address.

import { describe, it, expect } from 'vitest';
import { encryptPush, fromB64u, b64u, makeVapidKeys, vapidHeader, pushEndpointOk, notificationFor, pushTo } from '../workers/webpush.js';

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
async function hmac(key, data) { return new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data)); }
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const ecdhPrivate = (d, pub) => subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d, x: b64u(fromB64u(pub).slice(1, 33)), y: b64u(fromB64u(pub).slice(33, 65)), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);

/** What the phone's browser does with a push body (RFC 8291 receiver side). */
async function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256));
  const ikm = await hmac(await hmac(auth, shared), cat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.slice(21 + idlen)));
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, end));
}

describe('message encryption (RFC 8291)', () => {
  // RFC 8291, section 5 / appendix A.
  const V = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('matches the RFC\'s worked example byte for byte', async () => {
    const serverKeys = { privateKey: await ecdhPrivate(V.asPrivate, V.asPublic), publicKey: await subtle.importKey('raw', fromB64u(V.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, true, []) };
    const body = await encryptPush(V.plaintext, V.uaPublic, V.auth, { salt: fromB64u(V.salt), serverKeys });
    expect(b64u(body)).toBe(V.body);
  });

  it('a phone decrypts what the server sends, with fresh keys every time', async () => {
    const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = JSON.stringify({ title: 'Low: 62 ↓', body: 'Treat with fast sugar.', ack: '/night/ack?t=' + 'a'.repeat(32) });
    const one = await encryptPush(msg, b64u(uaPublic), b64u(auth));
    const two = await encryptPush(msg, b64u(uaPublic), b64u(auth));
    expect(b64u(one)).not.toBe(b64u(two));
    expect(await decrypt(one, ua.privateKey, uaPublic, auth)).toBe(msg);
    await expect(encryptPush('x'.repeat(5000), b64u(uaPublic), b64u(auth))).rejects.toThrow(/too long/);
    await expect(encryptPush('x', 'AAAA', b64u(auth))).rejects.toThrow(/bad subscription/);
  });
});

describe('VAPID', () => {
  it('signs a 12-hour claim for the push service, verifiable with the public key', async () => {
    const k = await makeVapidKeys();
    const keys = { publicKey: k.publicKey, privateKey: await subtle.importKey('jwk', k.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    const now = Date.UTC(2026, 9, 2, 12);
    const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, { now });
    const [, jwt, pub] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
    expect(pub).toBe(k.publicKey);
    const [head, claims, sig] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64u(claims)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://su94r.com' });
    const verifyKey = await subtle.importKey('raw', fromB64u(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, fromB64u(sig), enc.encode(`${head}.${claims}`))).toBe(true);
    expect(JSON.stringify(k.privateJwk)).not.toContain(k.publicKey);
  });
});

describe('where and what it sends', () => {
  it('posts only to real push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QX', 'https://wns2-bl2p.notify.windows.com/w/?token=x']) expect(pushEndpointOk(ok)).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com:8443/x', 'nonsense']) expect(pushEndpointOk(bad)).toBe(false);
  });

  it('an alert keeps its "I\'m OK" button as a same-site address; reminders replace each other', () => {
    const n = notificationFor({ title: 'Low: 62', message: 'Treat.', priority: 5, actions: [{ url: 'https://x.supabase.co/functions/v1/su94r-cgm/night/ack?t=' + 'b'.repeat(32) }] });
    expect(n).toEqual({ title: 'Low: 62', body: 'Treat.', tag: 'su94r-alert', urgent: true, ack: '/night/ack?t=' + 'b'.repeat(32) });
    expect(notificationFor({ title: 'Back up', message: '', priority: 3, tags: ['white_check_mark'] }).tag).toBe('su94r-alert');
    expect(notificationFor({ title: 'Sunday summary', priority: 3 })).toMatchObject({ tag: 'su94r-info', urgent: false, ack: null });
    expect(notificationFor({ title: 'x', actions: [{ url: 'https://evil.com/?t=zz' }] }).ack).toBeNull();
  });

  it('removes subscriptions the push service says are gone, counts the delivered ones', async () => {
    const k = await makeVapidKeys();
    const keys = { publicKey: k.publicKey, privateKey: await subtle.importKey('jwk', k.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = b64u(await subtle.exportKey('raw', ua.publicKey)), auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const subs = [
      { id: 's1', endpoint: 'https://fcm.googleapis.com/fcm/send/ok', p256dh, auth },
      { id: 's2', endpoint: 'https://fcm.googleapis.com/fcm/send/gone', p256dh, auth },
      { id: 's3', endpoint: 'https://evil.example/hook', p256dh, auth },
      { id: 's4', endpoint: 'https://fcm.googleapis.com/fcm/send/busy', p256dh, auth, failures: 2 },
    ];
    const log = [];
    const store = { ready: true, keys: async () => keys, ok: async (id) => log.push(['ok', id]), gone: async (id) => log.push(['gone', id]), failed: async (id, n) => log.push(['failed', id, n]) };
    const posted = [];
    const fetchImpl = async (url, init) => { posted.push({ url, init }); return new Response(null, { status: url.endsWith('/ok') ? 201 : url.endsWith('/gone') ? 410 : 503 }); };
    const n = await pushTo(store, subs, { title: 'Low: 62', message: 'Treat.', priority: 5 }, { fetchImpl });
    expect(n).toBe(1);
    expect(posted.map((p) => p.url)).not.toContain('https://evil.example/hook');
    expect(posted[0].init.headers).toMatchObject({ TTL: '900', Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    expect(log.sort()).toEqual([['failed', 's4', 3], ['gone', 's2'], ['gone', 's3'], ['ok', 's1']].sort());
  });
});
