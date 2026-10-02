// Alexa request-signature checks. Voice logging writes doses, so a forged request must be
// refused. The fixtures are a throwaway chain made with openssl (Test Root CA → Test
// Intermediate → echo-api.amazon.com); the real Amazon roots are checked separately.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { verifyAlexaSignature, certUrlOk, AlexaVerifyError } from '../workers/alexa-verify.js';
import { ALEXA_ROOTS } from '../workers/alexa-roots.js';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/alexa/${f}`, import.meta.url), 'utf8');
const ROOT = fx('root.pem');
const LEAF_KEY = fx('leaf.key');
const URL_OK = 'https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem';
const body = JSON.stringify({ version: '1.0', request: { type: 'IntentRequest', timestamp: new Date().toISOString() } });
const sign = (text, key = LEAF_KEY) => crypto.sign('sha256', Buffer.from(text), key).toString('base64');
const headers = (sig, url = URL_OK) => new Headers({ SignatureCertChainUrl: url, 'Signature-256': sig });
const run = (h, b, chain = 'chain.pem', extra = {}) =>
  verifyAlexaSignature(h, b, { roots: [ROOT], fetchText: async () => fx(chain), ...extra });

describe('Alexa request signatures', () => {
  it('accepts a correctly signed request', async () => {
    await expect(run(headers(sign(body)), body)).resolves.toBeUndefined();
  });
  it('refuses a body changed after signing', async () => {
    await expect(run(headers(sign(body)), body.replace('IntentRequest', 'LaunchRequest'))).rejects.toThrow(/signature does not match/);
  });
  it('refuses a request signed by a key that is not the certificate\'s', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(run(headers(sign(body, privateKey)), body)).rejects.toThrow(AlexaVerifyError);
  });
  it('refuses a chain that does not reach a trusted root', async () => {
    await expect(run(headers(sign(body)), body, 'chain.pem', { roots: ALEXA_ROOTS })).rejects.toThrow(/Amazon root/);
  });
  it('refuses a certificate made out to another name', async () => {
    await expect(run(headers(sign(body)), body, 'wrongname.pem')).rejects.toThrow(/echo-api.amazon.com/);
  });
  it('refuses an expired certificate', async () => {
    await expect(run(headers(sign(body)), body, 'chain.pem', { now: Date.UTC(2040, 0, 1) })).rejects.toThrow(/expired/);
  });
  it('refuses missing headers', async () => {
    await expect(run(new Headers({}), body)).rejects.toThrow(/missing/);
  });
  it('only fetches certificates from Amazon\'s echo.api bucket', async () => {
    expect(certUrlOk('https://s3.amazonaws.com/echo.api/echo-api-cert.pem')).toBe(true);
    expect(certUrlOk('https://S3.AMAZONAWS.COM/echo.api/x.pem')).toBe(true);
    expect(certUrlOk('https://s3.amazonaws.com:443/echo.api/x.pem')).toBe(true);
    for (const bad of [
      'http://s3.amazonaws.com/echo.api/x.pem',
      'https://s3.amazonaws.com/EcHo.aPi/x.pem',
      'https://s3.amazonaws.com/invalid.path/x.pem',
      'https://s3.amazonaws.com:563/echo.api/x.pem',
      'https://evil.example.com/echo.api/x.pem',
      'https://s3.amazonaws.com/echo.api/../evil/x.pem',
    ]) expect(certUrlOk(bad), bad).toBe(false);
    await expect(run(headers(sign(body), 'https://evil.example.com/echo.api/x.pem'), body)).rejects.toThrow(/certificate URL/);
  });
  it('the bundled Amazon roots parse and verify their own signatures (RSA and elliptic curve)', async () => {
    // Each root is self-signed, so treating it as both the chain and the trust anchor
    // exercises every signature type the real chains use.
    expect(ALEXA_ROOTS.length).toBe(5);
    const { __test } = await import('../workers/alexa-verify.js');
    for (const pem of ALEXA_ROOTS) expect(await __test.selfSigned(pem)).toBe(true);
  });
});
