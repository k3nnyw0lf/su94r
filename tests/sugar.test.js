// The public su94r skill (workers/sugar.js): account linking with a LibreLinkUp follower,
// consents, OAuth tokens, per-person reading, tiles and deletion.
import { describe, it, expect, beforeEach } from 'vitest';
import { sugarRoute, CONSENT_ITEMS, resetSugarCache, unseal, seal } from '../workers/sugar.js';
import { sha256 } from '../workers/screens.js';
import { servePage } from '../workers/sugar-page.js';

// su94r-cgm hands pages and redirects to the proxy as JSON (Supabase turns HTML into text/plain).
const body = async (res) => (await res.clone().json()).page;
const where = async (res) => (await res.clone().json()).location;

const MIN = 60e3;
const ENV = { SUGAR_SKILL_ID: 'amzn1.ask.skill.sugar-test', SUGAR_CLIENT_ID: 'su94r-alexa', SUGAR_CLIENT_SECRET: 'a long made-up client secret', SUGAR_ALEXA_CLIENT_ID: 'cid', SUGAR_ALEXA_CLIENT_SECRET: 'csec' };
const REDIRECT = 'https://pitangui.amazon.com/api/skill/link/M3GHKK9H1L7LLL';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7 + 1)));

function memStore() {
  const users = new Map(), tokens = new Map();
  let n = 0;
  const copy = (x) => (x ? structuredClone(x) : null);
  return {
    users, tokens, ready: true,
    async credKey() { return KEY; },
    async userById(id) { return copy(users.get(id)); },
    async userByEmailHash(h) { return copy([...users.values()].find((u) => u.email_hash === h)); },
    async userByAlexa(a) { return copy([...users.values()].find((u) => u.alexa_user === a)); },
    async widgetUsers() { return [...users.values()].filter((u) => u.widget_on && u.status === 'active').map(copy); },
    async saveUser(row) {
      const old = [...users.values()].find((u) => u.email_hash === row.email_hash);
      const u = { meta: {}, widget_on: false, alexa_user: null, ...(old || { id: `u${++n}` }), ...row };
      users.set(u.id, u); return copy(u);
    },
    async patchUser(id, f) { if (users.has(id)) users.set(id, { ...users.get(id), ...structuredClone(f) }); },
    async deleteUser(id) { users.delete(id); for (const [h, t] of tokens) if (t.user_id === id) tokens.delete(h); },
    async putToken(row) { tokens.set(row.hash, { used: false, ...row }); },
    async tokenByHash(h) { return copy(tokens.get(h)); },
    async useCode(h) { const t = tokens.get(h); if (!t || t.used) return false; t.used = true; return true; },
  };
}

const NOW = Date.now();
const conn = (id, first, mg, mins = 2) => ({ patientId: id, firstName: first, lastName: 'X', targetLow: 70, targetHigh: 180, glucoseMeasurement: { ValueInMgPerDl: mg, TrendArrow: 3, GlucoseUnits: 1, FactoryTimestamp: stamp(NOW - mins * MIN) } });
function stamp(t) {
  const d = new Date(t); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${ap}`;
}
function libre({ people = [conn('p1', 'Ana', 132), conn('p2', 'Luis', 64)], password = 'follower-pass' } = {}) {
  const calls = { login: 0 };
  return {
    calls,
    login: async (email, pw) => { calls.login++; if (pw !== password) throw Object.assign(new Error('bad'), { code: 'credentials' }); return { token: 'llu-token', base: 'https://api.libreview.io', accountId: 'acc', expires: Math.floor(NOW / 1000) + 86400 }; },
    connections: async () => ({ connections: people }),
    graph: async () => ({ graphData: [] }),
  };
}

const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const linkFields = (over = {}) => ({ client_id: ENV.SUGAR_CLIENT_ID, redirect_uri: REDIRECT, state: 'st-123', response_type: 'code', email: 'Ken+su94r@example.test', password: 'follower-pass', ...Object.fromEntries(CONSENT_ITEMS.map((k) => [k, 'yes'])), ...over });
const post = (path, body, headers = {}) => new Request(`https://cgm.test/${path}`, { method: 'POST', body, headers });
const route = (path, req, store, deps = {}) => sugarRoute(path, req, ENV, { sugarStore: store, verify: async () => {}, ...deps });

async function linked(store, lib) {
  const res = await route('sugar/link', post('sugar/link', form(linkFields())), store, lib);
  const code = new URL(await where(res)).searchParams.get('code');
  const tok = await (await route('sugar/token', post('sugar/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: ENV.SUGAR_CLIENT_ID, client_secret: ENV.SUGAR_CLIENT_SECRET })), store)).json();
  return tok;
}
const alexaBody = (over = {}) => ({
  version: '1.0',
  context: { System: { application: { applicationId: ENV.SUGAR_SKILL_ID }, user: { userId: 'amzn1.ask.account.ALEXA1', ...(over.token ? { accessToken: over.token } : {}) }, device: { supportedInterfaces: over.screen ? { 'Alexa.Presentation.APL': {} } : {} } } },
  request: { type: over.type || 'LaunchRequest', locale: over.locale || 'en-US', timestamp: new Date().toISOString(), ...(over.intent ? { intent: over.intent } : {}) },
});

beforeEach(() => resetSugarCache());

describe('linking with a LibreLinkUp follower account', () => {
  it('the page only opens for Amazon\'s redirect and our client id, and shows every consent', async () => {
    const store = memStore();
    const ok = await route('sugar/link', new Request(`https://cgm.test/sugar/link?client_id=su94r-alexa&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&response_type=code`), store);
    expect(ok.status).toBe(200);
    const page = await body(ok);
    for (const k of CONSENT_ITEMS) expect(page).toContain(`name="${k}"`);
    expect(page).toMatch(/Which sensor?/);
    expect(page).toMatch(/With Dexcom/);
    expect(ok.headers.get('x-su94r-page')).toBe('1');
    const served = await servePage(await route('sugar/link', new Request(`https://cgm.test/sugar/link?client_id=su94r-alexa&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s`), store));
    expect(served.headers.get('content-type')).toMatch(/^text\/html/);
    expect(served.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const evil = await route('sugar/link', new Request(`https://cgm.test/sugar/link?client_id=su94r-alexa&redirect_uri=${encodeURIComponent('https://evil.test/cb')}&state=s`), store);
    expect(evil.status).toBe(400);
    const es = await body(await route('sugar/link', new Request(`https://cgm.test/sugar/link?client_id=su94r-alexa&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&lang=es`), store));
    expect(es).toMatch(/¿Qué sensor?/);
  });

  it('needs every box ticked, a follower Libre accepts, and someone sharing with it', async () => {
    const store = memStore();
    const missing = await route('sugar/link', post('sugar/link', form(linkFields({ unofficial: '' }))), store, libre());
    expect(missing.status).toBe(400);
    expect(await body(missing)).toMatch(/tick every box/);
    const bad = await route('sugar/link', post('sugar/link', form(linkFields({ password: 'nope' }))), store, libre());
    expect(await body(bad)).toMatch(/did not accept that email and password/);
    const nobody = await route('sugar/link', post('sugar/link', form(linkFields())), store, libre({ people: [] }));
    expect(await body(nobody)).toMatch(/No one shares with this follower account yet/);
    expect(store.users.size).toBe(0);
  });

  it('a good sign-in seals the login, records the consents and sends Amazon a one-time code', async () => {
    const store = memStore();
    const res = await route('sugar/link', post('sugar/link', form(linkFields())), store, libre());
    expect(res.headers.get("x-su94r-page")).toBe("1");
    const to = new URL(await where(res));
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('state')).toBe('st-123');
    const u = [...store.users.values()][0];
    expect(u.email_hash).toBe(await sha256('ken+su94r@example.test'));
    expect(JSON.stringify(u)).not.toContain('follower-pass');             // never stored in the clear
    expect(await unseal(store, u.libre_cred)).toEqual({ email: 'Ken+su94r@example.test', password: 'follower-pass' });
    expect(u.consents).toMatchObject({ version: '2026-10-19', items: CONSENT_ITEMS });
    const code = to.searchParams.get('code');
    expect(store.tokens.get(await sha256(code))).toMatchObject({ kind: 'code', redirect_uri: REDIRECT });
  });
});

describe('the OAuth token endpoint', () => {
  it('trades a code once for tokens, refreshes, and refuses a wrong client secret', async () => {
    const store = memStore();
    const res = await route('sugar/link', post('sugar/link', form(linkFields())), store, libre());
    const code = new URL(await where(res)).searchParams.get('code');
    const bad = await route('sugar/token', post('sugar/token', form({ grant_type: 'authorization_code', code, client_id: ENV.SUGAR_CLIENT_ID, client_secret: 'wrong' })), store);
    expect(bad.status).toBe(401);
    const basic = `Basic ${btoa(`${ENV.SUGAR_CLIENT_ID}:${encodeURIComponent(ENV.SUGAR_CLIENT_SECRET)}`)}`;
    const t = await (await route('sugar/token', post('sugar/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }), { Authorization: basic }), store)).json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(t.access_token).toMatch(/^[0-9a-f]{64}$/);
    const again = await route('sugar/token', post('sugar/token', form({ grant_type: 'authorization_code', code }), { Authorization: basic }), store);
    expect(again.status).toBe(400);                                          // a code works once
    const r = await (await route('sugar/token', post('sugar/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token }), { Authorization: basic }), store)).json();
    expect(r.access_token).not.toBe(t.access_token);
    expect(r.refresh_token).toBe(t.refresh_token);
  });
});

describe('the su94r skill', () => {
  it('reads only the people sharing with this person\'s follower, with a one-time reminder, in English and Spanish', async () => {
    const store = memStore(); const lib = libre();
    const { access_token } = await linked(store, lib);
    const r1 = await (await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token, screen: true }))), store, lib)).json();
    expect(r1.response.outputSpeech.text).toMatch(/Ana is at 132/);
    expect(r1.response.outputSpeech.text).toMatch(/Luis is low at 64/);
    expect(r1.response.outputSpeech.text).toMatch(/not an alarm\. Keep your Libre alarms on\.$/);
    expect(r1.response.directives[0].type).toBe('Alexa.Presentation.APL.RenderDocument');
    resetSugarCache();
    const r2 = await (await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token, locale: 'es-US' }))), store, lib)).json();
    expect(r2.response.outputSpeech.text).not.toMatch(/Recuerda/);              // said once
    expect(r2.response.outputSpeech.text).toMatch(/Ana está en 132/);
    expect([...store.users.values()][0].alexa_user).toBe('amzn1.ask.account.ALEXA1');
  });

  it('without a linked account it asks to link (LinkAccount card); a dead follower login asks to relink', async () => {
    const store = memStore(); const lib = libre();
    const r = await (await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody())), store, lib)).json();
    expect(r.response.card).toEqual({ type: 'LinkAccount' });
    const { access_token } = await linked(store, lib);
    const u = [...store.users.values()][0];
    store.users.set(u.id, { ...u, libre_session: null, libre_cred: await seal(store, { email: 'x', password: 'changed' }) });
    const r2 = await (await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token }))), store, lib)).json();
    expect(r2.response.outputSpeech.text).toMatch(/stopped working/);
    expect(store.users.get(u.id).status).toBe('needs_login');
  });

  it('a phrase it does not understand gets help, not a reading', async () => {
    const store = memStore(); const lib = libre();
    const { access_token } = await linked(store, lib);
    const r = await (await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token, type: 'IntentRequest', intent: { name: 'AMAZON.FallbackIntent' } }))), store, lib)).json();
    expect(r.response.outputSpeech.text).toMatch(/I can only read glucose/);
    expect(r.response.shouldEndSession).toBe(false);
  });

  it('a request for another skill, or an expired token, gets nothing', async () => {
    const store = memStore(); const lib = libre();
    const body = alexaBody(); body.context.System.application.applicationId = 'amzn1.ask.skill.other';
    expect((await route('sugar/alexa', post('sugar/alexa', JSON.stringify(body)), store, lib)).status).toBe(403);
    const { access_token } = await linked(store, lib);
    const t = store.tokens.get(await sha256(access_token)); t.expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await (await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token }))), store, lib)).json();
    expect(r.response.card).toEqual({ type: 'LinkAccount' });
  });

  it('adding the tile turns it on and sends the first person\'s reading with the su94r skill\'s own credentials; the tick keeps it fresh', async () => {
    const store = memStore(); const lib = libre();
    const { access_token } = await linked(store, lib);
    const pushed = [];
    const pushTile = async (env, user, content) => { pushed.push({ env, user, content }); return { ok: true }; };
    await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token, type: 'Alexa.DataStore.PackageManager.UsagesInstalled' }))), store, { ...lib, pushTile });
    const u = [...store.users.values()][0];
    expect(u.widget_on).toBe(true);
    expect(pushed[0]).toMatchObject({ env: { ALEXA_CLIENT_ID: 'cid', ALEXA_CLIENT_SECRET: 'csec' }, user: 'amzn1.ask.account.ALEXA1', content: { title: 'Ana', value: '132' } });
    resetSugarCache();
    const t = await (await route('sugar/tick', post('sugar/tick', '{}'), store, { ...lib, pushTile })).json();
    expect(t).toEqual({ users: 1, sent: 1, failed: 0 });
    resetSugarCache();
    expect(await (await route('sugar/tick', post('sugar/tick', '{}'), store, { ...lib, pushTile })).json()).toEqual({ users: 1, sent: 0, failed: 0 });   // same reading
  });

  it('turning the skill off in the Alexa app deletes the account and its tokens', async () => {
    const store = memStore(); const lib = libre();
    const { access_token } = await linked(store, lib);
    await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ token: access_token }))), store, lib);
    await route('sugar/alexa', post('sugar/alexa', JSON.stringify(alexaBody({ type: 'AlexaSkillEvent.SkillDisabled' }))), store, lib);
    expect(store.users.size).toBe(0);
    expect(store.tokens.size).toBe(0);
  });
});

describe('legal pages', () => {
  it('Terms, Privacy and the separate health-data policy, with FDA\'s wording, the operator, and a review banner until reviewed', async () => {
    const store = memStore();
    const get = async (path, env = ENV) => body(await sugarRoute(path, new Request(`https://cgm.test/${path}`), env, { sugarStore: store }));
    const terms = await get('sugar/terms', { ...ENV, SUGAR_OPERATOR: 'Example LLC', SUGAR_CONTACT: 'privacy@example.test' });
    expect(terms).toMatch(/Dosing decisions should not be made based on this device\. The user should follow instructions on the continuous glucose monitoring system\./);
    expect(terms).toMatch(/INCLUDING CLAIMS BASED ON OUR OWN NEGLIGENCE/);
    expect(terms).toMatch(/operated by Example LLC/);
    expect(terms).toContain('mailto:privacy@example.test');
    expect(terms).toMatch(/Draft awaiting legal review/);
    expect(await get('sugar/terms', { ...ENV, SUGAR_LEGAL_REVIEWED: '1' })).not.toMatch(/Draft awaiting legal review/);
    const health = await get('sugar/health-data');
    expect(health).toMatch(/two separate opt-in consents/);
    expect(health).toMatch(/never sell consumer health data/);
    expect(await get('sugar/privacy')).toMatch(/do not store a history of anyone/);
    const es = body(await sugarRoute('sugar/terms', new Request('https://cgm.test/sugar/terms?lang=es'), ENV, { sugarStore: store }));
    expect(await es).toMatch(/No se deben tomar decisiones de dosis basadas en este dispositivo/);
  });
});

describe('deleting my data on the web', () => {
  it('needs the follower email and password, then removes everything', async () => {
    const store = memStore(); const lib = libre();
    await linked(store, lib);
    const wrong = await route('sugar/delete', post('sugar/delete', form({ email: 'ken+su94r@example.test', password: 'nope' })), store, lib);
    expect(wrong.status).toBe(401);
    expect(store.users.size).toBe(1);
    const ok = await route('sugar/delete', post('sugar/delete', form({ email: 'KEN+su94r@example.test', password: 'follower-pass' })), store, lib);
    expect(await body(ok)).toMatch(/Your su94r data is deleted/);
    expect(store.users.size).toBe(0);
  });
});
