// The Echo Show home-screen tile: what it shows, how it is sent (Amazon's Data
// Store API) and when (the tile being added, then each new reading in the night tick).
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { widgetContent, pushWidget, widgetTick, widgetReady, resetWidgetToken, WIDGET_NS, WIDGET_KEY } from '../workers/widget.js';
import { handleAlexa } from '../workers/alexa.js';
import { nightRoute, NIGHT_DEFAULTS } from '../workers/night.js';

const MIN = 60e3;
const NOW = Date.parse('2026-10-18T21:00:00Z');
const ENV = { ALEXA_CLIENT_ID: 'amzn1.application-oa2-client.test', ALEXA_CLIENT_SECRET: 'test-secret', ALEXA_SKILL_ID: 'amzn1.ask.skill.test' };
const person = (over = {}) => ({
  pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', low: 70, high: 180,
  latest: { t: NOW - 2 * MIN, mg: 142, trend: 4 },
  history: Array.from({ length: 40 }, (_, i) => ({ t: NOW - (39 - i) * 5 * MIN, mg: 100 + i })),
  ...over,
});
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

/** A fake Amazon: the token endpoint and the Data Store endpoint. */
function amazon({ storeStatus = [200] } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://api.amazon.com/auth/o2/token')) return json({ access_token: `tok${calls.filter((c) => c.url.includes('/auth/')).length}`, expires_in: 3600, token_type: 'bearer' });
    const status = storeStatus[Math.min(n++, storeStatus.length - 1)];
    return json(status === 200 ? { results: [{ type: 'SUCCESS' }] } : { type: 'INVALID_ACCESS_TOKEN' }, status);
  };
  return { calls, fetchImpl };
}

beforeEach(() => resetWidgetToken());

describe('what the tile shows', () => {
  it('the number, arrow, colour, time and a thinned 3-hour line inside 300 × 100', () => {
    const c = widgetContent(person(), NOW);
    expect(c).toMatchObject({ has: true, title: 'Ken', value: '142', arrow: '↗', status: 'in', color: '#3fb950', t: NOW - 2 * MIN });
    expect(c.line.startsWith('M')).toBe(true);
    const nums = c.line.match(/-?\d+/g).map(Number);
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...nums)).toBeLessThanOrEqual(300);
    expect(c.line.split('L').length).toBeLessThanOrEqual(37);          // 3 h at one point per 5 min
    expect(c.band).toMatch(/^M0,\d+ L300,\d+ L300,\d+ L0,\d+ Z$/);
    expect(JSON.stringify(c).length).toBeLessThan(16 * 1024);         // Data Store command limit
  });

  it('carries the owner\'s night hours so the tile can dim (default 22–7)', async () => {
    const { nightHours } = await import('../workers/widget.js');
    expect(widgetContent(person(), NOW)).toMatchObject({ nightStart: 22, nightEnd: 7 });
    expect(widgetContent(person(), NOW, nightHours({ night_start: 23, night_end: 6 }))).toMatchObject({ nightStart: 23, nightEnd: 6 });
    expect(nightHours(null)).toEqual({ nightStart: 22, nightEnd: 7 });
    expect(widgetContent(person({ latest: null }), NOW, nightHours({ night_start: 21, night_end: 8 }))).toEqual({ has: false, title: 'Ken', nightStart: 21, nightEnd: 8 });
    const doc = JSON.parse(readFileSync('docs/alexa/dataStorePackages/su94r-glucose/documents/document.json', 'utf8'));
    const binds = Object.fromEntries(doc.mainTemplate.bind.map((b) => [b.name, b.value]));
    expect(binds.dim).toBe('${isNight && !lowNow}');                 // a low always shows at full brightness
  });

  it('the change over 15 minutes, from the nearest reading about 15 minutes earlier', () => {
    expect(widgetContent(person(), NOW).delta).toBe('+7');                       // 142 now, 136 thirteen minutes before: +6 scaled to 15 min
    const falling = person({ latest: { t: NOW, mg: 80, trend: 1 }, history: [{ t: NOW - 16 * MIN, mg: 104 }, { t: NOW - 40 * MIN, mg: 150 }] });
    expect(widgetContent(falling, NOW).delta).toBe('−23');            // −24 over 16 min, scaled to 15
    expect(widgetContent({ ...falling, units: 'mmol/L' }, NOW).delta).toBe('−1.2');
    expect(widgetContent(person({ history: [{ t: NOW - 60 * MIN, mg: 90 }] }), NOW).delta).toBe('');   // nothing near 15 min ago
    const steady = person({ latest: { t: NOW, mg: 120, trend: 3 }, history: [{ t: NOW - 15 * MIN, mg: 120.4 }] });
    expect(widgetContent(steady, NOW).delta).toBe('0');                // no "−0"
  });

  it('the wide tile\'s extras: 12-hour time in range and low–high, sensor time left, active insulin, last carbs', () => {
    const DAY = 24 * 3600e3;
    const p = person({ sensorStart: NOW - 9 * DAY, history: Array.from({ length: 144 }, (_, i) => ({ t: NOW - (143 - i) * 5 * MIN, mg: i < 36 ? 60 : 150 })) });
    const c = widgetContent(p, NOW, { extra: { iob: 1.234, meal: { t: NOW - 70 * MIN, g: 45 } } });
    expect(c).toMatchObject({ tir: 75, lo12: '60', hi12: '150', sensorH: 120, iob: 1.2, mealG: 45, mealT: NOW - 70 * MIN, range: '70–180' });
    expect(widgetContent(p, NOW, { sensorDays: 10 }).sensorH).toBe(24);
    expect(widgetContent(p, NOW, { extra: { iob: 0.01, meal: { t: NOW - 7 * 3600e3, g: 30 } } })).toMatchObject({ iob: null, mealG: null, mealT: null });
    expect(widgetContent(person({ history: [] }), NOW).tir).toBe(null);   // too few readings to say
  });

  it('the wide graph is drawn in 300 × 200 and the scale follows the readings', () => {
    const flat = person({ history: Array.from({ length: 36 }, (_, i) => ({ t: NOW - (35 - i) * 5 * MIN, mg: 150 + (i % 2) * 10 })) });
    const c = widgetContent(flat, NOW);
    const ys = (s) => s.match(/,(-?\d+)/g).map((m) => Number(m.slice(1)));
    expect(Math.max(...ys(c.lineW))).toBeLessThanOrEqual(200);
    expect(Math.max(...ys(c.lineW)) - Math.min(...ys(c.lineW))).toBeGreaterThan(Math.max(...ys(c.line)) - Math.min(...ys(c.line)));
    expect(Math.max(...ys(c.line)) - Math.min(...ys(c.line))).toBeGreaterThanOrEqual(5);   // a 10-point swing is visible, not flat
    expect(c.bandW).toMatch(/^M0,\d+ L300,\d+ L300,\d+ L0,\d+ Z$/);
    const doc = JSON.parse(readFileSync('docs/alexa/dataStorePackages/su94r-glucose/documents/document.json', 'utf8'));
    expect(doc.graphics.sparkWide).toMatchObject({ width: 300, height: 200 });
    expect(JSON.stringify(doc)).toContain('g.lineW');
  });

  it('lows are red, highs amber, mmol/L shows one decimal, LO/HI past the sensor range, no reading says so', () => {
    expect(widgetContent(person({ latest: { t: NOW, mg: 62, trend: 2 } }), NOW)).toMatchObject({ status: 'low', color: '#ff5d55', arrow: '↘' });
    expect(widgetContent(person({ latest: { t: NOW, mg: 50, trend: 1 } }), NOW).status).toBe('urgent');
    expect(widgetContent(person({ latest: { t: NOW, mg: 240, trend: 3 } }), NOW)).toMatchObject({ status: 'high', color: '#e3a33b' });
    expect(widgetContent(person({ units: 'mmol/L', latest: { t: NOW, mg: 126, trend: 3 } }), NOW).value).toBe('7.0');
    expect(widgetContent(person({ latest: { t: NOW, mg: 35, trend: 3 } }), NOW).value).toBe('LO');
    expect(widgetContent(person({ latest: null }), NOW)).toEqual({ has: false, title: 'Ken', nightStart: 22, nightEnd: 7 });
  });
});

describe('sending it with the Data Store API', () => {
  it('gets an alexa::datastore token with the skill credentials, puts the object for the user, and reuses the token', async () => {
    const a = amazon();
    const r = await pushWidget(ENV, 'amzn1.ask.account.USER', { has: true }, { fetchImpl: a.fetchImpl, now: NOW });
    expect(r).toEqual({ ok: true, status: 200, results: ['SUCCESS'] });
    const form = new URLSearchParams(a.calls[0].init.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: ENV.ALEXA_CLIENT_ID, client_secret: ENV.ALEXA_CLIENT_SECRET, scope: 'alexa::datastore' });
    expect(a.calls[1].url).toBe('https://api.amazonalexa.com/v1/datastore/commands');
    expect(a.calls[1].init.headers.Authorization).toBe('Bearer tok1');
    const body = JSON.parse(a.calls[1].init.body);
    expect(body.commands).toEqual([{ type: 'PUT_OBJECT', namespace: WIDGET_NS, key: WIDGET_KEY, content: { has: true } }]);
    expect(body.target).toEqual({ type: 'USER', id: 'amzn1.ask.account.USER' });
    expect(body.attemptDeliveryUntil).toBe('2026-10-18T21:15:00Z');
    await pushWidget(ENV, 'amzn1.ask.account.USER', { has: true }, { fetchImpl: a.fetchImpl, now: NOW + MIN });
    expect(a.calls.filter((c) => c.url.includes('/auth/')).length).toBe(1);
  });

  it('trims pasted credentials, and a refused login says why (never the secret)', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(new URLSearchParams(init.body)); return json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401); };
    await expect(pushWidget({ ALEXA_CLIENT_ID: ' id-1\n', ALEXA_CLIENT_SECRET: 'sec-1 \r\n' }, 'u', {}, { fetchImpl, now: NOW })).rejects.toThrow(/^token 401 invalid_client$/);
    expect(seen[0].get('client_id')).toBe('id-1');
    expect(seen[0].get('client_secret')).toBe('sec-1');
  });

  it('a refused token is fetched again once; nothing is sent without credentials or a tile', async () => {
    const a = amazon({ storeStatus: [401, 200] });
    expect((await pushWidget(ENV, 'u', {}, { fetchImpl: a.fetchImpl, now: NOW })).ok).toBe(true);
    expect(a.calls.filter((c) => c.url.includes('/auth/')).length).toBe(2);
    expect(widgetReady({})).toBe(false);
    expect(await pushWidget({}, 'u', {}, { fetchImpl: a.fetchImpl })).toEqual({ ok: false, error: 'not configured' });
    expect(await pushWidget(ENV, null, {}, { fetchImpl: a.fetchImpl })).toEqual({ ok: false, error: 'no tile installed' });
  });
});

describe('when it is sent', () => {
  it('the night tick sends a new reading, not the same one again for 30 minutes', async () => {
    const sent = [];
    const push = async (env, user, content) => { sent.push({ user, content }); return { ok: true }; };
    const row = { alexa_widget_user: 'amzn1.ask.account.USER' };
    const state = {};
    expect(await widgetTick(ENV, row, [person()], state, { push, now: NOW })).toEqual({ label: 'echo tile', ok: true });
    expect(sent[0]).toMatchObject({ user: 'amzn1.ask.account.USER', content: { value: '142' } });
    expect(await widgetTick(ENV, row, [person()], state, { push, now: NOW + 5 * MIN })).toBe(null);
    expect(await widgetTick(ENV, row, [person()], state, { push, now: NOW + 31 * MIN })).toMatchObject({ ok: true });
    expect(await widgetTick(ENV, row, [person({ latest: { t: NOW + 32 * MIN, mg: 150, trend: 3 } })], state, { push, now: NOW + 33 * MIN })).toMatchObject({ ok: true });
    expect(sent.length).toBe(3);
    expect(await widgetTick(ENV, {}, [person()], {}, { push, now: NOW })).toBe(null);             // no tile added yet
    expect(await widgetTick({}, row, [person()], {}, { push, now: NOW })).toBe(null);             // no credentials
  });

  it('nightRoute runs it and notes the result without counting it as an alert', async () => {
    const row = { id: 1, ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {}, alexa_widget_user: 'amzn1.ask.account.USER' };
    const night = { ready: true, async get() { return structuredClone(row); }, async patch(f) { Object.assign(row, structuredClone(f)); }, async claimTick() { return true; } };
    const tiles = [];
    const url = new URL('https://cgm.test/night/tick');
    const r = await (await nightRoute('night/tick', new Request(url, { method: 'POST' }), url, ENV, {
      store: night, json, keyOk: async () => false, snapshot: async () => ({ people: [person({ latest: { t: Date.now() - MIN, mg: 120, trend: 3 } })] }),
      push: async () => true, tile: async (env, user, content) => { tiles.push({ user, content }); return { ok: true }; },
    })).json();
    expect(r.ok).toBe(true);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].content.value).toBe('120');
    expect(row.last_result.tile).toBe('sent');
    expect(row.last_result.sent.some((s) => s.label === 'echo tile')).toBe(false);
  });

  it('adding the tile on an Echo keeps the Amazon user and sends the current reading at once', async () => {
    const patched = [];
    const night = { ready: true, async patch(f) { patched.push(f); } };
    const pushed = [];
    const body = {
      version: '1.0',
      context: { System: { application: { applicationId: ENV.ALEXA_SKILL_ID }, user: { userId: 'amzn1.ask.account.USER' } } },
      request: { type: 'Alexa.DataStore.PackageManager.UsagesInstalled', timestamp: new Date().toISOString(), payload: { packageId: 'su94r-glucose' } },
    };
    const res = await handleAlexa(new Request('https://cgm.test/alexa', { method: 'POST', body: JSON.stringify(body) }), ENV, async () => ({ people: [person()] }), {
      verify: async () => {}, night, pushTile: async (env, user, content) => { pushed.push({ user, content }); return { ok: true }; },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1.0', response: {} });
    expect(patched).toEqual([{ alexa_widget_user: 'amzn1.ask.account.USER' }]);
    expect(pushed[0]).toMatchObject({ user: 'amzn1.ask.account.USER', content: { has: true, value: '142' } });
    // Removal or update notices just get an empty answer.
    const other = await handleAlexa(new Request('https://cgm.test/alexa', { method: 'POST', body: JSON.stringify({ ...body, request: { ...body.request, type: 'Alexa.DataStore.PackageManager.UsagesRemoved' } }) }), ENV, async () => ({ people: [] }), { verify: async () => {}, night });
    expect(await other.json()).toEqual({ version: '1.0', response: {} });
    expect(patched).toHaveLength(1);
  });
});

describe('the tile package and the skill manifest agree', () => {
  it('same namespace/key, the package is declared, the data store extension is requested', () => {
    const doc = JSON.parse(readFileSync('docs/alexa/dataStorePackages/su94r-glucose/documents/document.json', 'utf8'));
    expect(doc.settings.DataStore.dataBindings[0]).toMatchObject({ namespace: WIDGET_NS, key: WIDGET_KEY, dataType: 'OBJECT' });
    const pkg = JSON.parse(readFileSync('docs/alexa/dataStorePackages/su94r-glucose/manifest.json', 'utf8'));
    expect(pkg.manifest.id).toBe('su94r-glucose');
    expect(pkg.publishingInformation.locales['en-US'][0].targetViewport).toBe('WIDGET_M');
    const skill = JSON.parse(readFileSync('docs/alexa/skill.json', 'utf8'));
    const types = skill.manifest.apis.custom.interfaces;
    expect(types.find((i) => i.type === 'ALEXA_DATASTORE_PACKAGEMANAGER').packages).toEqual([{ id: 'su94r-glucose' }]);
    expect(types.some((i) => i.type === 'ALEXA_DATA_STORE')).toBe(true);
    expect(types.find((i) => i.type === 'ALEXA_EXTENSION').requestedExtensions).toEqual([{ uri: 'alexaext:datastore:10' }]);
  });
});
