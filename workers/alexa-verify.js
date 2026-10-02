// Checks that a request really comes from Amazon's Alexa service, as Amazon requires for
// skills hosted outside AWS Lambda: the signing certificate's URL, its chain up to an
// Amazon root, its validity and its name (echo-api.amazon.com), and the signature over
// the exact request body. Logging a dose by voice writes data, so a forged request must
// be impossible, not merely unlikely.
//
// Plain WebCrypto plus an ASN.1 parser, so the same code runs in Node (tests) and in
// Deno (the Supabase function).

import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate, SubjectAlternativeName, BasicConstraints } from '@peculiar/asn1-x509';
import { ALEXA_ROOTS } from './alexa-roots.js';

const OID = {
  san: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  rsa: '1.2.840.113549.1.1.1',
  ec: '1.2.840.10045.2.1',
};
const SIG = {
  '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
  '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' },
};

export class AlexaVerifyError extends Error {}
const fail = (msg) => { throw new AlexaVerifyError(msg); };

const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
const pemBlocks = (text) => [...String(text).matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => b64ToBytes(m[1]));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Reads a DER length at `i` (just after the tag byte); returns [length, index of content].
function derLen(bytes, i) {
  const first = bytes[i];
  if (first < 0x80) return [first, i + 1];
  const n = first & 0x7f;
  let len = 0;
  for (let k = 0; k < n; k++) len = len * 256 + bytes[i + 1 + k];
  return [len, i + 1 + n];
}

/** The exact bytes of the to-be-signed part, as they were signed (not re-encoded). */
function tbsBytes(der) {
  const [, outerStart] = derLen(der, 1);           // Certificate ::= SEQUENCE
  const [tbsLen, tbsContent] = derLen(der, outerStart + 1);
  return der.slice(outerStart, tbsContent + tbsLen);
}

function parse(der) {
  const cert = AsnConvert.parse(der, Certificate);
  const tbs = cert.tbsCertificate;
  return {
    der,
    tbs: tbsBytes(der),
    cert,
    subject: new Uint8Array(AsnConvert.serialize(tbs.subject)),
    issuer: new Uint8Array(AsnConvert.serialize(tbs.issuer)),
    spki: new Uint8Array(AsnConvert.serialize(tbs.subjectPublicKeyInfo)),
    notBefore: tbs.validity.notBefore.getTime(),
    notAfter: tbs.validity.notAfter.getTime(),
    ext: (oid) => (tbs.extensions || []).find((e) => e.extnID === oid),
  };
}

async function importKey(c, use) {
  const alg = c.cert.tbsCertificate.subjectPublicKeyInfo.algorithm;
  if (alg.algorithm === OID.rsa) return crypto.subtle.importKey('spki', c.spki, { name: 'RSASSA-PKCS1-v1_5', hash: use.hash }, false, ['verify']);
  if (alg.algorithm === OID.ec) {
    const params = new Uint8Array(alg.parameters);
    const oidHex = [...params].map((b) => b.toString(16).padStart(2, '0')).join('');
    const namedCurve = oidHex === '06082a8648ce3d030107' ? 'P-256' : oidHex === '06052b81040022' ? 'P-384' : null;
    if (!namedCurve) fail('unsupported curve');
    return crypto.subtle.importKey('spki', c.spki, { name: 'ECDSA', namedCurve }, false, ['verify']);
  }
  return fail('unsupported key type');
}

// X.509 stores ECDSA signatures as DER SEQUENCE { r, s }; WebCrypto wants r || s.
function ecdsaRaw(der, size) {
  let [, i] = derLen(der, 1);
  const int = () => {
    const [len, start] = derLen(der, i + 1);
    let v = der.slice(start, start + len);
    i = start + len;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = int();
  const s = int();
  return new Uint8Array([...r, ...s]);
}

/** Does `issuer` sign `child`? */
async function signs(issuer, child) {
  const use = SIG[child.cert.signatureAlgorithm.algorithm];
  if (!use) return false;
  try {
    const key = await importKey(issuer, use);
    let sig = new Uint8Array(child.cert.signatureValue);
    if (use.name === 'ECDSA') sig = ecdsaRaw(sig, key.algorithm.namedCurve === 'P-384' ? 48 : 32);
    return await crypto.subtle.verify({ name: use.name, hash: use.hash }, key, sig, child.tbs);
  } catch {
    return false;
  }
}

const isCa = (c) => {
  const e = c.ext(OID.basicConstraints);
  return Boolean(e && AsnConvert.parse(e.extnValue, BasicConstraints).cA);
};

/** Amazon's rules for the SignatureCertChainUrl header. */
export function certUrlOk(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  return u.protocol === 'https:'
    && u.hostname.toLowerCase() === 's3.amazonaws.com'
    && (u.port === '' || u.port === '443')
    && u.pathname.startsWith('/echo.api/')
    && !/\/\.\.?\//.test(u.pathname);
}

const certCache = new Map();

/**
 * Throws AlexaVerifyError unless the request is signed by Alexa. `body` is the raw request
 * text. Options for tests: roots (PEM strings), now, fetchText(url).
 */
export async function verifyAlexaSignature(headers, body, { roots = ALEXA_ROOTS, now = Date.now(), fetchText } = {}) {
  const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()]);
  const url = get('SignatureCertChainUrl') || get('signaturecertchainurl');
  const signature = get('Signature-256') || get('signature-256');
  if (!url || !signature) fail('missing signature headers');
  if (!certUrlOk(url)) fail('bad certificate URL');

  // Real fetches are cached per URL (Amazon reuses a chain for months); validity is
  // still checked on every request below.
  let pem = fetchText ? await fetchText(url) : certCache.get(url);
  if (!pem) {
    const res = await fetch(url);
    if (!res.ok) fail(`could not fetch the certificate (${res.status})`);
    pem = await res.text();
    certCache.set(url, pem);
  }
  const chain = pemBlocks(pem).map(parse);
  if (!chain.length) fail('no certificates');
  const leaf = chain[0];

  for (const c of chain) if (now < c.notBefore || now > c.notAfter) fail('certificate expired or not yet valid');
  const sanExt = leaf.ext(OID.san);
  const names = sanExt ? AsnConvert.parse(sanExt.extnValue, SubjectAlternativeName).map((g) => g.dNSName).filter(Boolean) : [];
  if (!names.includes('echo-api.amazon.com')) fail('certificate is not for echo-api.amazon.com');

  // Walk up: each certificate must be signed by the next one, or by a trusted root.
  const trusted = roots.flatMap(pemBlocks).map(parse);
  let cur = leaf;
  let anchored = false;
  for (let depth = 0; depth < 6 && !anchored; depth++) {
    const root = trusted.find((r) => same(r.subject, cur.issuer));
    if (root && await signs(root, cur)) { anchored = true; break; }
    const next = chain.find((c) => c !== cur && same(c.subject, cur.issuer));
    if (!next || !isCa(next) || !(await signs(next, cur))) break;
    cur = next;
  }
  if (!anchored) fail('certificate does not chain to an Amazon root');

  const key = await importKey(leaf, { hash: 'SHA-256' });
  if (key.algorithm.name !== 'RSASSA-PKCS1-v1_5') fail('unexpected signing key');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBytes(signature), new TextEncoder().encode(body));
  if (!ok) fail('signature does not match the request');
}

// For tests: does a certificate verify its own signature (true for a root)?
export const __test = {
  selfSigned: async (pem) => {
    const [c] = pemBlocks(pem).map(parse);
    return same(c.subject, c.issuer) && signs(c, c);
  },
};
