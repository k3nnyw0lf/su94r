// Tests for the server-side CGM routes (workers/cgm-core.js, run by the Supabase
// function su94r-cgm) and the su94r-proxy Worker that forwards to them, against
// a fake LibreLinkUp.
//
// The regressions that matter: the monitor's /glucose/latest must return
// readings the escalation ladder accepts (it silently got nothing before);
// the PWA's stored {token, apiBase} must keep working now that LibreLinkUp
// demands an account-id header; and every secret-guarded route must refuse
// when its secret is missing rather than fall open.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import proxy, { nightscoutEntriesUrl, FORWARDED } from '../workers/proxy.js';
import { APP_PATHS } from '../workers/app.js';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { describePerson } from '../workers/alexa.js';
import { validateSeries } from '../src/lib/cgm/validate.js';

const NOW = Date.now();
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64url({ alg: 'HS256' })}.${b64url({ id: 'user-1' })}.sig`;
const ACCOUNT_ID = createHash('sha256').update('user-1').digest('hex');
const fmt = (t) => { const d = new Date(t); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${ap}`; };
const meas = (t, mg, trend = 3) => ({ FactoryTimestamp: fmt(t), ValueInMgPerDl: mg, Value: mg, GlucoseUnits: 1, TrendArrow: trend });

describe('the proxy forwards every phone-app route', () => {
  // A route missing here answers "proxy alive" instead of reaching the server (app/history, app/links).
  it.each([...APP_PATHS])('%s', (p) => expect(FORWARDED.has(`/${p}`)).toBe(true));
});

let latestMg = 128;
let calls = [];
function fakeLibre(url, init = {}) {
  const u = new URL(url);
  const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ host: u.host, path: u.pathname, version: h.version, account: h['account-id'] });
  const res = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  if (u.pathname === '/llu/auth/login') {
    const { password } = JSON.parse(init.body);
    if (password !== 'right') return res({ status: 2, error: { message: 'incorrect username/password' } });
    if (u.host === 'api.libreview.io') return res({ status: 0, data: { redirect: true, region: 'us' } });
    return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: JWT, expires: 1900000000 } } });
  }
  if (h.authorization !== `Bearer ${JWT}` || h['account-id'] !== ACCOUNT_ID) return res({ message: 'invalid or expired jwt' }, 401);
  const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: meas(NOW - 30e3, latestMg, 4) };
  if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
  if (u.pathname === '/llu/connections/p1/graph') {
    const graphData = [];
    for (let t = NOW - 12 * 3600e3; t < NOW - 5 * 60e3; t += 15 * 60e3) graphData.push(meas(t, 120));
    return res({ status: 0, data: { connection: conn, graphData } });
  }
  return res({ status: 1 }, 404);
}

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', HEALTH_INGEST_TOKEN: 'monitor-secret', DISPLAY_KEY: 'tv-key-123', ALEXA_SKILL_ID: 'amzn1.ask.skill.test' };
const CORE = new Set(['libre/login', 'libre/readings', 'glucose/latest', 'display/data', 'alexa']);
// Core routes go straight to the shared handler (as su94r-cgm runs them); the rest to the Worker.
const call = (path, init = {}, env = ENV) => {
  const req = new Request(`https://proxy.test${path}`, init);
  const route = path.split('?')[0].slice(1);
  // Alexa requests here are unsigned; the signature check has its own tests (alexa-verify.test.js).
  return CORE.has(route) ? handleCgm(route, req, env, { verifyAlexa: async () => {}, store: { ready: false } }) : proxy.fetch(req, env);
};
const post = (path, body, env) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);

beforeEach(() => {
  resetCaches();
  calls = [];
  latestMg = 128;
  vi.stubGlobal('fetch', vi.fn(fakeLibre));
});

describe('PWA LibreLinkUp routes', () => {
  it('signs in, follows the US region redirect and sends a current app version', async () => {
    const r = await (await post('/libre/login', { email: 'a', password: 'right' })).json();
    expect(r.token).toBe(JWT);
    expect(r.apiBase).toBe('https://api-us.libreview.io');
    expect(calls.every((c) => c.version && c.version !== '4.7')).toBe(true);
  });
  it('rejects a wrong password with 401', async () => {
    expect((await post('/libre/login', { email: 'a', password: 'nope' })).status).toBe(401);
  });
  it('keeps the stored {token, apiBase} working by deriving the account-id header', async () => {
    const res = await post('/libre/readings', { token: JWT, apiBase: 'https://api-us.libreview.io' });
    const r = await res.json();
    expect(res.status).toBe(200);
    expect(r.current.value).toBe(128);
    expect(r.current.timestamp).toBe(new Date(Math.floor((NOW - 30e3) / 1000) * 1000).toISOString());
    expect(r.history.length).toBeGreaterThan(40);
    expect(calls.filter((c) => c.path.startsWith('/llu/connections')).every((c) => c.account === ACCOUNT_ID)).toBe(true);
  });
  it('refuses to forward a token to a non-LibreView host', async () => {
    await post('/libre/readings', { token: JWT, apiBase: 'https://evil.example' });
    expect(calls.every((c) => c.host.endsWith('libreview.io'))).toBe(true);
  });
});

describe('/glucose/latest (night monitor feed)', () => {
  const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
  it('returns readings the escalation ladder accepts', async () => {
    const res = await call('/glucose/latest', auth('monitor-secret'));
    const readings = await res.json();
    expect(res.status).toBe(200);
    const { valid, rejected } = validateSeries(readings, { now: Date.now() });
    expect(rejected).toHaveLength(0);
    expect(valid.at(-1).value).toBe(128);
  });
  it('refuses a wrong token', async () => {
    expect((await call('/glucose/latest', auth('guess'))).status).toBe(401);
  });
  it('fails closed when its secret is unset', async () => {
    expect((await call('/glucose/latest', auth('undefined'), { ...ENV, HEALTH_INGEST_TOKEN: undefined })).status).toBe(503);
  });
  it('says the server login is missing instead of guessing', async () => {
    const res = await call('/glucose/latest', auth('monitor-secret'), { ...ENV, LLU_PASSWORD: undefined });
    expect(res.status).toBe(503);
  });
});

describe('display (TVs, Echo Show, tablets)', () => {
  it('serves a self-contained page that carries its key', async () => {
    const page = await call('/d/tv-key-123');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('"tv-key-123"');
    expect(html).not.toMatch(/<script src=/);
  });
  it('gives data only for the right key, and fails closed when DISPLAY_KEY is unset', async () => {
    expect((await call('/display/data?key=wrong')).status).toBe(401);
    // No display key and no connected su94r Mini: every key is refused.
    expect((await call('/display/data?key=x', {}, { ...ENV, DISPLAY_KEY: undefined })).status).toBe(401);
  });
  it('returns everyone with 12 hours of history', async () => {
    const r = await (await call('/display/data?key=tv-key-123')).json();
    expect(r.people).toHaveLength(1);
    expect(r.people[0].latest.mg).toBe(128);
    expect(r.people[0].history.length).toBeGreaterThan(40);
    expect(JSON.stringify(r)).not.toContain('p1');
  });
});

describe('/alexa', () => {
  const alexa = (over = {}) => ({
    version: '1.0',
    context: { System: { application: { applicationId: 'amzn1.ask.skill.test' }, device: { supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
    request: { type: 'LaunchRequest', timestamp: new Date().toISOString(), ...over },
  });
  it('speaks the reading and shows it on an Echo Show', async () => {
    const r = await (await post('/alexa', alexa())).json();
    expect(r.response.outputSpeech.text).toMatch(/^You are at 128 milligrams per deciliter and rising/);
    expect(r.response.directives[0].type).toBe('Alexa.Presentation.APL.RenderDocument');
  });
  it('leads with a warning when low', async () => {
    latestMg = 62;
    const r = await (await post('/alexa', alexa())).json();
    expect(r.response.outputSpeech.text).toMatch(/^Warning\. You are low at 62/);
  });
  it('rejects other skills and replayed requests', async () => {
    const other = alexa();
    other.context.System.application.applicationId = 'amzn1.ask.skill.other';
    expect((await post('/alexa', other)).status).toBe(403);
    expect((await post('/alexa', alexa({ timestamp: new Date(Date.now() - 10 * 60e3).toISOString() }))).status).toBe(400);
  });
  it('fails closed when ALEXA_SKILL_ID is unset', async () => {
    expect((await post('/alexa', alexa(), { ...ENV, ALEXA_SKILL_ID: undefined })).status).toBe(503);
  });
  it('describes a stale reading honestly', () => {
    const p = { name: 'Ana Lopez', firstName: 'Ana', units: 'mg/dL', low: 70, high: 180, latest: { t: Date.now() - 30 * 60e3, mg: 140, trend: 3 } };
    expect(describePerson(p, { many: true })).toMatch(/^Ana: no new reading for 30 minutes\. The last one was 140/);
  });
});

describe('su94r-proxy forwarding', () => {
  it('forwards LibreLinkUp routes to su94r-cgm with method, auth and query intact', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { seen.push({ url, init }); return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); }));
    const env = { CGM_URL: 'https://cgm.test/functions/v1/su94r-cgm' };
    const res = await proxy.fetch(new Request('https://proxy.test/glucose/latest?x=1', { headers: { Authorization: 'Bearer t' } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(seen[0].url).toBe('https://cgm.test/functions/v1/su94r-cgm/glucose/latest?x=1');
    expect(seen[0].init.headers.get('authorization')).toBe('Bearer t');
    await proxy.fetch(new Request('https://proxy.test/libre/login', { method: 'POST', body: '{"email":"a"}', headers: { 'Content-Type': 'application/json' } }), env);
    expect(seen[1].init.method).toBe('POST');
    expect(new TextDecoder().decode(seen[1].init.body)).toBe('{"email":"a"}');
  });
  it('serves the doctor page only at /r/<64 hex>, holding nothing, and forwards its data call', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { seen.push({ url, init }); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); }));
    const env = { CGM_URL: 'https://cgm.test/functions/v1/su94r-cgm' };
    const token = 'c'.repeat(64);
    const page = await proxy.fetch(new Request(`https://proxy.test/r/${token}`), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('Referrer-Policy')).toBe('no-referrer');
    const html = await page.text();
    expect(html).toContain('Glucose report');
    expect(html).not.toContain(token);
    expect(seen).toHaveLength(0);
    expect(await (await proxy.fetch(new Request('https://proxy.test/r/short'), env)).text()).toBe('su94r CGM proxy alive');
    await proxy.fetch(new Request('https://proxy.test/doctor/data', { headers: { Authorization: `Bearer ${token}` } }), env);
    expect(seen[0].url).toBe('https://cgm.test/functions/v1/su94r-cgm/doctor/data');
    // su94r Mini's history copy and the history read reach the server too (they once got "alive").
    await proxy.fetch(new Request('https://proxy.test/history/import?key=k', { method: 'POST', body: '{}' }), env);
    await proxy.fetch(new Request('https://proxy.test/history?key=k&days=14'), env);
    expect(seen.slice(1).map((s) => s.url)).toEqual(['https://cgm.test/functions/v1/su94r-cgm/history/import', 'https://cgm.test/functions/v1/su94r-cgm/history?days=14']);
    expect(seen[1].init.headers.get('x-su94r-key')).toBe('k');
    expect(seen[0].init.headers.get('authorization')).toBe(`Bearer ${token}`);
  });
  it('fails closed when CGM_URL is unset', async () => {
    expect((await proxy.fetch(new Request('https://proxy.test/alexa', { method: 'POST', body: '{}' }), {})).status).toBe(503);
  });
});

it('answers unknown paths with the old alive message', async () => {
  expect(await (await call('/')).text()).toBe('su94r CGM proxy alive');
});

describe('nightscoutEntriesUrl', () => {
  it('keeps a sub-path and ignores any query or fragment the user typed', () => {
    expect(nightscoutEntriesUrl('https://ns.example.com/ns/')).toBe('https://ns.example.com/ns/api/v1/entries.json?count=36');
    expect(nightscoutEntriesUrl('https://ns.example.com?count=99999#x')).toBe('https://ns.example.com/api/v1/entries.json?count=36');
  });
  it('refuses http, embedded passwords and junk', () => {
    for (const bad of ['http://ns.example.com', 'https://a:b@ns.example.com', 'javascript:alert(1)', '', null]) {
      expect(nightscoutEntriesUrl(bad)).toBeNull();
    }
  });
});

describe('meal photos through Workers AI (/ai/meal)', () => {
  it('runs only with a proof su94r-cgm confirms, and only on an image', async () => {
    const { default: worker } = await import('../workers/proxy.js');
    const ai = { calls: [], async run(model, input) { this.calls.push({ model, input }); return { response: '{"food":true,"total_g":40}' }; } };
    const good = 'b'.repeat(64);
    const fetchMock = vi.fn(async (url, init) => new Response('{}', { status: String(url).endsWith('/tg/proof') && init.headers['x-su94r-proof'] === good ? 200 : 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { AI: ai, CGM_URL: 'https://cgm.test' };
    const ask = (proof, image) => worker.fetch(new Request('https://proxy.test/ai/meal', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(proof ? { 'x-su94r-proof': proof } : {}) }, body: JSON.stringify({ image, prompt: 'p' }) }), env);
    expect((await ask(null, 'data:image/jpeg;base64,AAAA')).status).toBe(401);
    expect((await ask('c'.repeat(64), 'data:image/jpeg;base64,AAAA')).status).toBe(401);
    expect(ai.calls).toHaveLength(0);
    expect((await ask(good, 'https://example.com/x.jpg')).status).toBe(400);
    const r = await ask(good, 'data:image/jpeg;base64,AAAA');
    expect(r.status).toBe(200);
    expect((await r.json()).text).toBe('{"food":true,"total_g":40}');
    expect(ai.calls[0].model).toBe('@cf/mistralai/mistral-small-3.1-24b-instruct');
    expect(ai.calls[0].input.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA');
    ai.run = async () => ({ response: { food: true, total_g: 30 } });   // sometimes already parsed
    expect((await (await ask(good, 'data:image/jpeg;base64,AAAA')).json()).text).toBe('{"food":true,"total_g":30}');
  });
});
