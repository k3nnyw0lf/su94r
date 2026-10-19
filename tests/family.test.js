// su94r family accounts (workers/sugar-family.js): a Dexcom family signs in once, sets the
// doctor's numbers, pairs its own screens, and gets the backup safety net naming the baby. Each
// family sees only itself; the owner's screens never list it.
import { describe, it, expect, beforeEach } from 'vitest';
import { sugarRoute, CONSENT_ITEMS, resetSugarCache, unseal, sugarTick } from '../workers/sugar.js';
import { familyScreenPayload } from '../workers/sugar-family.js';
import { screenStore } from '../workers/screens.js';
import { sha256 } from '../workers/screens.js';

const MIN = 60e3;
const ENV = { SUGAR_SKILL_ID: 'amzn1.ask.skill.sugar-test', SUGAR_CLIENT_ID: 'su94r-alexa', SUGAR_CLIENT_SECRET: 'secret', SUPABASE_URL: 'https://db.test', NTFY_BASE: 'https://ntfy.test' };
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 11 + 3) % 256)));
const body = async (res) => (await res.clone().json()).page;

function memStore() {
  const users = new Map(), tokens = new Map(), nights = new Map(), screens = new Map();
  let n = 0;
  const copy = (x) => (x ? structuredClone(x) : null);
  return {
    users, tokens, nights, screens, ready: true,
    async credKey() { return KEY; },
    async userById(id) { return copy(users.get(id)); },
    async userByEmailHash(h) { return copy([...users.values()].find((u) => u.email_hash === h)); },
    async userByAlexa(a) { return copy([...users.values()].find((u) => u.alexa_user === a)); },
    async widgetUsers() { return []; },
    async saveUser(row) { const u = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, meta: {}, widget_on: false, units: 'mg/dL', ...row }; users.set(u.id, u); return copy(u); },
    async patchUser(id, f) { if (users.has(id)) users.set(id, { ...users.get(id), ...structuredClone(f) }); },
    async deleteUser(id) { users.delete(id); nights.delete(id); },
    async putToken(row) { tokens.set(row.hash, { used: false, ...row }); },
    async tokenByHash(h) { return copy(tokens.get(h)); },
    async useCode() { return true; },
    async screensFor(uid) { return [...screens.values()].filter((s) => s.sugar_user === uid && !s.revoked).map(copy); },
    async claimScreen(code, name, uid) { const s = [...screens.values()].find((x) => x.code === code && !x.claimed_at); if (!s) return null; Object.assign(s, { claimed_at: new Date().toISOString(), code: null, name, sugar_user: uid, kind: 'screen' }); return { id: s.id, name }; },
    async removeScreen(id, uid) { const s = screens.get(id); if (s && s.sugar_user === uid) s.revoked = true; },
    async nightFor(uid) { return copy(nights.get(uid)); },
    async saveNight(row) { nights.set(row.user_id, { last_tick_at: null, ...structuredClone(row) }); },
    async patchNight(uid, f) { nights.set(uid, { ...nights.get(uid), ...structuredClone(f) }); },
    async familyNights() { return [...nights.values()].map((x) => ({ ...copy(x), user: copy(users.get(x.user_id)) })); },
  };
}

/** A fake Dexcom Share: one baby, readings we set. */
function dexcom({ password = 'baby-pass', points = null } = {}) {
  const state = { points: points || [{ t: Date.now() - 2 * MIN, mg: 112, trend: 3 }], logins: 0 };
  return {
    state,
    dexcomLogin: async (user, pw) => { state.logins++; if (pw !== password) throw Object.assign(new Error('bad'), { code: 'credentials' }); return { host: 'share2.dexcom.com', sessionId: 'sess', at: Date.now() }; },
    dexcomReadings: async () => state.points.slice(),
  };
}

const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const post = (path, b) => new Request(`https://cgm.test/${path}`, { method: 'POST', body: b });
const route = (path, req, store, deps = {}) => sugarRoute(path, req, ENV, { sugarStore: store, verify: async () => {}, ...deps });
const consents = Object.fromEntries(CONSENT_ITEMS.map((k) => [k, 'yes']));
const signin = (over = {}) => form({ source: 'dexcom', email: 'Parent@Example.test', password: 'baby-pass', person: 'Sofia', region: 'us', ...consents, ...over });
const tokenFrom = (html) => html.match(/name="m" value="([0-9a-f]{48})"/)?.[1];

beforeEach(() => resetSugarCache());

describe('a Dexcom family signs in', () => {
  it('needs the consents the first time, the name to say, and Dexcom readings; then opens the settings page', async () => {
    const store = memStore(); const dx = dexcom();
    expect(await body(await route('sugar/family', post('sugar/family', signin({ adult_terms: '' })), store, dx))).toMatch(/tick every box/);
    expect(await body(await route('sugar/family', post('sugar/family', signin({ person: '' })), store, dx))).toMatch(/name Alexa should say/);
    expect(await body(await route('sugar/family', post('sugar/family', signin({ password: 'nope' })), store, dx))).toMatch(/Dexcom did not accept/);
    expect(await body(await route('sugar/family', post('sugar/family', signin()), store, dexcom({ points: [] })))).toMatch(/no readings to share yet/);
    expect(store.users.size).toBe(0);

    const page = await body(await route('sugar/family', post('sugar/family', signin()), store, dx));
    expect(page).toMatch(/Your family account is ready/);
    expect(page).toMatch(/su94r · Sofia/);
    expect(page).toMatch(/<b style="font-size:2rem">112 →<\/b>/);
    expect(tokenFrom(page)).toBeTruthy();
    const u = [...store.users.values()][0];
    expect(u).toMatchObject({ source: 'dexcom', person: 'Sofia', region: 'us', status: 'active' });
    expect(u.email_hash).toBe(await sha256('dexcom:parent@example.test'));
    expect(JSON.stringify(u)).not.toContain('baby-pass');
    expect(await unseal(store, u.libre_cred)).toEqual({ email: 'Parent@Example.test', password: 'baby-pass' });
    const night = store.nights.get(u.id);
    expect(night.cfg).toMatchObject({ enabled: true, low_mgdl: 70, severe_mgdl: 55, care_enabled: false });
    expect(night.cfg.self_topic).toMatch(/^su94r-[0-9a-f]{24}$/);
    expect(page).toContain(`https://ntfy.test/${night.cfg.self_topic}`);

    // Signing in again later needs no consents; it is the same account.
    const again = await body(await route('sugar/family', post('sugar/family', form({ source: 'dexcom', email: 'parent@example.test', password: 'baby-pass' })), store, dx));
    expect(again).toMatch(/su94r · Sofia/);
    expect(store.users.size).toBe(1);
  });
});

describe('the family settings page', () => {
  async function opened(extra = {}) {
    const store = memStore(); const dx = { ...dexcom(), ...extra };
    const page = await body(await route('sugar/family', post('sugar/family', signin()), store, dx));
    const m = tokenFrom(page);
    const u = [...store.users.values()][0];
    const act = (fields) => route('sugar/manage', post('sugar/manage', form({ m, ...fields })), store, dx);
    return { store, dx, m, u, act };
  }

  it('saves the doctor\'s numbers (checked), the name, night hours and alert choices', async () => {
    const { store, u, act } = await opened();
    expect(await body(await act({ action: 'settings', low: 80, severe: 85, high: 250, night_start: 21, night_end: 7, time_zone: 'America/Chicago', person: 'Sofia' }))).toMatch(/Urgent low must be under low/);
    const ok = await body(await act({ action: 'settings', low: 80, severe: 60, high: 220, night_start: 21, night_end: 7, time_zone: 'America/Chicago', person: 'Sofía', treat_plan: '5 g glucose gel, recheck in 15 min', enabled: 'yes', soon: 'yes', lang_alerts: 'es' }));
    expect(ok).toMatch(/Saved\./);
    expect(store.nights.get(u.id).cfg).toMatchObject({ low_mgdl: 80, severe_mgdl: 60, high_mgdl: 220, night_start: 21, time_zone: 'America/Chicago', treat_plan: '5 g glucose gel, recheck in 15 min', enabled: true, soon_enabled: true, echo_always: false, lang_self: 'es' });
    expect(store.users.get(u.id)).toMatchObject({ person: 'Sofía', meta: { targets: { low: 80, high: 220 } } });
  });

  it('pairs its own screen by code, lists and removes it', async () => {
    const { store, u, act } = await opened();
    store.screens.set('11111111-1111-1111-1111-111111111111', { id: '11111111-1111-1111-1111-111111111111', code: 'K7Q-4MD', claimed_at: null, revoked: false });
    expect(await body(await act({ action: 'pair', code: 'zzz', name: 'Tesla' }))).toMatch(/does not look right/);
    expect(await body(await act({ action: 'pair', code: 'ABC-DEF', name: 'Tesla' }))).toMatch(/No screen is waiting/);
    const paired = await body(await act({ action: 'pair', code: 'k7q 4md', name: 'Tesla' }));
    expect(paired).toMatch(/Screen added/);
    expect(paired).toMatch(/<li>Tesla/);
    expect(store.screens.get('11111111-1111-1111-1111-111111111111')).toMatchObject({ sugar_user: u.id, name: 'Tesla', kind: 'screen' });
    expect(await body(await act({ action: 'unpair', id: '11111111-1111-1111-1111-111111111111' }))).toMatch(/Screen removed/);
    expect(store.screens.get('11111111-1111-1111-1111-111111111111').revoked).toBe(true);
  });

  it('keeps Echo trigger links sealed, only virtualsmarthome links; tests the alert phones and the Echo', async () => {
    const pushed = [], rang = [];
    const { store, u, act } = await opened({ familyPush: async (topic, msg) => { pushed.push({ topic, msg }); }, ring: async (url) => { rang.push(url); } });
    expect(await body(await act({ action: 'echo', echo_low: 'https://evil.test/x' }))).toMatch(/not a virtualsmarthome/);
    const link = 'https://www.virtualsmarthome.xyz/url_routine_trigger/activate.php?trigger=abc123def456&token=secret-token-here&response=html';
    expect(await body(await act({ action: 'echo', echo_low: link }))).toMatch(/Echo links saved/);
    expect(JSON.stringify(store.nights.get(u.id))).not.toContain('secret-token-here');
    expect(await body(await act({ action: 'test_echo' }))).toMatch(/The Echo trigger rang/);
    expect(rang).toEqual([link]);
    expect(await body(await act({ action: 'test_alert' }))).toMatch(/Test alert sent/);
    expect(pushed[0].topic).toBe(store.nights.get(u.id).cfg.self_topic);
    expect(pushed[0].msg.title).toBe('Sofia: su94r test alert');
  });

  it('a settings token lasts 30 minutes, then it asks to sign in again', async () => {
    const { store, act } = await opened();
    for (const t of store.tokens.values()) t.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await body(await act({ action: 'test_alert' }))).toMatch(/closed after 30 minutes/);
  });
});



describe('the family safety net', () => {
  it('names the baby, warns before a low, alerts on the low with the doctor\'s plan, rings the Echo at night, and "I\'m OK" stops it', async () => {
    const store = memStore();
    const now = Date.now();
    const dx = dexcom({ points: [{ t: now - 12 * MIN, mg: 92, trend: 2 }, { t: now - 7 * MIN, mg: 84, trend: 2 }, { t: now - 2 * MIN, mg: 76, trend: 1 }] });
    await route('sugar/family', post('sugar/family', signin()), store, dx);
    const u = [...store.users.values()][0];
    const n = store.nights.get(u.id);
    n.cfg = { ...n.cfg, echo_always: true, treat_plan: '5 g glucose gel', time_zone: 'UTC' };   // the Echo speaks at any hour (the test must not depend on the clock)
    const link = 'https://www.virtualsmarthome.xyz/url_routine_trigger/activate.php?trigger=abc123def456&token=t0k3n';
    const { seal } = await import('../workers/sugar.js');
    n.cfg.echo_low_sealed = await seal(store, { url: link });
    n.cfg.echo_soon_sealed = await seal(store, { url: `${link}-soon` });
    const pushed = [], rang = [];
    const deps = { ...dx, familyPush: async (topic, msg) => { pushed.push({ topic, msg }); }, ring: async (url) => { rang.push(url); } };

    let r = await sugarTick(ENV, store, deps, { now });
    expect(r.families).toMatchObject({ checked: 1 });
    const soon = pushed.find((p) => /Low soon/.test(p.msg.title));
    expect(soon.topic).toBe(n.cfg.self_topic);
    expect(soon.msg.title).toMatch(/^Sofia: Low soon: 76/);
    expect(rang).toContain(`${link}-soon`);

    // 5 minutes later she is low.
    dx.state.points.push({ t: now + 3 * MIN, mg: 63, trend: 1 });
    resetSugarCache();
    r = await sugarTick(ENV, store, deps, { now: now + 5 * MIN });
    const low = pushed.find((p) => /Low: 63/.test(p.msg.title));
    expect(low.msg.title).toMatch(/^Sofia: Low: 63/);
    expect(low.msg.message).toMatch(/5 g glucose gel/);
    expect(rang).toContain(link);
    const ack = new URL(low.msg.actions[0].url);
    expect(ack.pathname).toBe('/functions/v1/su94r-cgm/sugar/ack');
    expect(ack.searchParams.get('u')).toBe(u.id);

    const res = await (await route('sugar/ack', new Request(ack.toString(), { method: 'POST' }), store, deps)).json();
    expect(res.ok).toBe(true);
    expect((await (await route('sugar/ack', new Request(ack.toString(), { method: 'POST' }), store, deps)).json()).error).toBe('unknown or used');
  });

  it('a changed Dexcom password: one "cannot read" warning saying Dexcom Follow still alarms, then no retries', async () => {
    const store = memStore();
    const dx = dexcom();
    await route('sugar/family', post('sugar/family', signin()), store, dx);
    const u = [...store.users.values()][0];
    store.users.set(u.id, { ...store.users.get(u.id), libre_session: null, libre_cred: await (await import('../workers/sugar.js')).seal(store, { email: 'x', password: 'changed' }) });
    const pushed = [];
    const deps = { ...dx, familyPush: async (topic, msg) => { pushed.push(msg); }, ring: async () => {} };
    resetSugarCache();
    await sugarTick(ENV, store, deps, { now: Date.now() });
    expect(pushed.map((m) => m.title)).toEqual(["su94r cannot read Sofia's glucose"]);
    expect(pushed[0].message).toMatch(/Dexcom Follow still sends its alarms/);
    expect(store.users.get(u.id).status).toBe('needs_login');
    const logins = dx.state.logins;
    resetSugarCache();
    await sugarTick(ENV, store, deps, { now: Date.now() + 10 * MIN });
    expect(dx.state.logins).toBe(logins);                                    // never hammers Dexcom
    expect(pushed).toHaveLength(1);                                          // and does not repeat after 10 minutes
    await sugarTick(ENV, store, deps, { now: Date.now() + 13 * 60 * MIN });
    expect(pushed).toHaveLength(2);                                          // but reminds every 12 hours
    expect(pushed[1].title).toBe("su94r cannot read Sofia's glucose");
    expect(dx.state.logins).toBe(logins);
  });
});

describe('each family sees only itself', () => {
  it('a family screen gets that family\'s person; the owner\'s screen list never includes family screens', async () => {
    const store = memStore(); const dx = dexcom();
    await route('sugar/family', post('sugar/family', signin()), store, dx);
    const u = [...store.users.values()][0];
    const data = await (await familyScreenPayload(ENV, { sugar_user: u.id, name: 'Tesla', kind: 'screen' }, 'data', { sugarStore: store, ...dx })).json();
    expect(data.people.map((p) => p.name)).toEqual(['Sofia']);
    expect(data.screen).toEqual({ name: 'Tesla', kind: 'screen' });
    const glance = await (await familyScreenPayload(ENV, { sugar_user: u.id, name: 'Phone', kind: 'widget' }, 'glance', { sugarStore: store, ...dx })).json();
    expect(glance).toMatchObject({ name: 'Sofia', value: '112', arrow: '→', state: 'in' });
    expect((await familyScreenPayload(ENV, { sugar_user: 'u-gone', name: 'X', kind: 'screen' }, 'data', { sugarStore: store, ...dx })).status).toBe(401);

    const urls = [];
    const owner = screenStore({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { fetchImpl: async (url) => { urls.push(String(url)); return new Response('[]', { status: 200 }); } });
    await owner.list();
    await owner.revokeOwner('11111111-1111-1111-1111-111111111111');
    expect(urls[0]).toMatch(/sugar_user=is\.null/);
    expect(urls[1]).toMatch(/sugar_user=is\.null/);
  });
});
