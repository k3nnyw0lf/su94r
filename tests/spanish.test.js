// Spanish everywhere. What must hold: a phone set to Spanish gets Spanish answers from the server
// (logging, the double-dose warning, patterns, the report); every alert carries Spanish words and
// each place gets its own language (ntfy by role, each app phone, each Telegram chat); Alexa on a
// Spanish-speaking Echo answers in Spanish; a doctor's link made in Spanish shows Spanish; the
// owner key works from a header (so it can stay out of request logs).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCgm, resetCaches } from '../workers/cgm-core.js';
import { sha256 } from '../workers/screens.js';
import { valid } from '../workers/doses.js';
import { nightCheck, inLanguage, alertFanOut, NIGHT_DEFAULTS } from '../workers/night.js';
import { nightSummary, weekLine } from '../workers/history.js';
import { pushTo, makeVapidKeys, b64u } from '../workers/webpush.js';
import { doctorData } from '../workers/doctor.js';
import { describePerson } from '../workers/alexa.js';

const ENV = { LLU_EMAIL: 'f@test.local', LLU_PASSWORD: 'right', DISPLAY_KEY: 'tv-key-123', ALEXA_SKILL_ID: 'amzn1.ask.skill.test' };
const MIN = 60e3, DAY = 864e5;

function libre(mg = 118, trend = 3) {
  return async (url) => {
    const u = new URL(url);
    const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/llu/auth/login') return res({ status: 0, data: { user: { id: 'user-1' }, authTicket: { token: 'a.eyJpZCI6InVzZXItMSJ9.c', expires: 1900000000 } } });
    const d = new Date(Date.now() - MIN); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    const ts = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 ${ap}`;
    const conn = { patientId: 'p1', firstName: 'Ken', lastName: 'W', targetLow: 70, targetHigh: 180, glucoseMeasurement: { FactoryTimestamp: ts, ValueInMgPerDl: mg, GlucoseUnits: 1, TrendArrow: trend } };
    if (u.pathname === '/llu/connections') return res({ status: 0, data: [conn] });
    return res({ status: 0, data: { connection: conn, graphData: [] } });
  };
}

describe('the phone app in Spanish', () => {
  let screens, rows;
  beforeEach(async () => {
    resetCaches();
    vi.stubGlobal('fetch', vi.fn(libre()));
    const r = new Map([['aaaaaaaa-1', { id: 'aaaaaaaa-1', kind: 'screen', role: 'me', name: 'Tel', token_hash: await sha256('a'.repeat(64)), revoked: false }]]);
    screens = { ready: true, async byToken(h) { return [...r.values()].find((x) => x.token_hash === h) || null; }, async update() { return []; }, async list() { return [...r.values()]; } };
    rows = [];
  });
  const doses = () => ({ ready: true, async recent() { return rows; }, async between() { return rows; }, async upsert(l) { const ok = l.filter(valid); rows.push(...ok); return ok.length; } });
  const call = (p, body, lang = 'es') => handleCgm(p, new Request(`https://x/${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json', 'X-Su94r-Lang': lang }, body: body ? JSON.stringify(body) : undefined }), ENV,
    { screens, store: doses(), night: { ready: false }, history: { ready: true, async range() { return []; } }, forecasts: { ready: false }, labs: { ready: false } });

  it('logging, the double-dose warning and errors answer in Spanish', async () => {
    expect(await (await call('app/log', { kind: 'rapid', amount: 4 })).json()).toMatchObject({ ok: true, text: 'Registrado: 4 unidades de insulina rápida.' });
    const again = await (await call('app/log', { kind: 'rapid', amount: 4 })).json();
    expect(again.warning).toMatch(/^Ya registraste 4 u de insulina rápida hace menos de un minuto/);
    expect((await (await call('app/log', { kind: 'rapid', amount: 500 })).json()).error).toBe('La insulina debe estar entre 0.5 y 100 unidades.');
    expect(await (await call('app/log', { kind: 'carbs', amount: 40, minutesAgo: 20 })).json()).toMatchObject({ text: 'Registrado: 40 g de carbohidratos, hace 20 min.' });
    expect((await (await call('app/log', { kind: 'carbs', amount: 30 }, 'en')).json()).text).toBe('Logged 30 g of carbs.');
  });

  it('spoken Spanish is understood; the report and patterns come back in Spanish', async () => {
    expect(await (await call('app/parse', { text: 'cuatro unidades de rápida' })).json()).toEqual({ ok: true, heard: 'cuatro unidades de rápida', kind: 'rapid', amount: 4, minutesAgo: 0 });
    expect((await (await call('app/patterns')).json()).note).toMatch(/^Los patrones necesitan al menos 5 días de lecturas/);
  });
});

describe('alerts in both languages', () => {
  const T0 = Date.UTC(2026, 9, 3, 7, 0);
  const person = (mg) => ({ pid: 'p1', firstName: 'Ken', name: 'Ken W', units: 'mg/dL', latest: { t: T0, mg, trend: 2 } });

  it('every alert carries Spanish words; "I\'m OK" becomes "Estoy bien"', async () => {
    const sent = [];
    await nightCheck({ row: { ...NIGHT_DEFAULTS, self_topic: 's', care_topic: 'c', state: {} }, people: [person(62)], now: T0, push: async (t, m) => { sent.push(m); }, ackUrl: (x) => `https://x/night/ack?t=${x}` });
    expect(sent[0].es.title).toBe('Baja: 62 mg/dL ↘');
    expect(sent[0].es.message).toMatch(/^Trátala con azúcar rápida\. Toca "Estoy bien"/);
    const es = inLanguage(sent[0], 'es');
    expect(es).toMatchObject({ title: 'Baja: 62 mg/dL ↘', actions: [expect.objectContaining({ label: 'Estoy bien' })] });
    expect(es.es).toBeUndefined();
    expect(inLanguage(sent[0], 'en').title).toBe('Low: 62 mg/dL ↘');
  });

  it('ntfy gets the role\'s language; each app phone its own', async () => {
    const got = [];
    const fan = alertFanOut({}, { self_topic: 's', care_topic: 'c', lang_self: 'en', lang_care: 'es' }, { push: async (topic, m) => { got.push([topic, m.title]); } });
    const msg = { title: 'Ken is low', message: 'Check on them.', es: { title: 'Ken tiene la glucosa baja', message: 'Revisa cómo está.' } };
    await fan('family', msg);
    await fan('me', msg);
    expect(got).toEqual([['c', 'Ken tiene la glucosa baja'], ['s', 'Ken is low']]);

    const k = await makeVapidKeys();
    const keys = { publicKey: k.publicKey, privateKey: await crypto.subtle.importKey('jwk', k.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = b64u(await crypto.subtle.exportKey('raw', ua.publicKey)), auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const store = { ready: true, keys: async () => keys, ok: async () => {}, gone: async () => {}, failed: async () => {} };
    const bodies = [];
    const fetchImpl = async (url, init) => { bodies.push(url); return new Response(null, { status: 201 }); };
    const n = await pushTo(store, [{ id: '1', endpoint: 'https://fcm.googleapis.com/fcm/send/es', p256dh, auth, lang: 'es' }, { id: '2', endpoint: 'https://fcm.googleapis.com/fcm/send/en', p256dh, auth, lang: 'en' }], msg, { fetchImpl });
    expect(n).toBe(2);
  });

  it('how was my night, in Spanish', () => {
    const now = Date.parse('2026-10-02T13:00:00Z');
    const night = [];
    for (let t = Date.parse('2026-10-02T02:00:00Z'); t < Date.parse('2026-10-02T11:00:00Z'); t += 15 * MIN) night.push({ t, mg: 120 });
    night[12] = { t: night[12].t, mg: 62 };
    expect(nightSummary(night, { now, tz: 'America/New_York', lang: 'es' })).toBe('Anoche estuviste en rango el 97% del tiempo. Tuviste una baja; la más baja fue 62 a las 1:00 AM. La más alta fue 120 a las 10:00 PM.');
    expect(weekLine([], { now, lang: 'es' })).toBe('Todavía no tengo suficientes lecturas de esta semana.');
  });
});

describe('Alexa in Spanish', () => {
  beforeEach(() => { resetCaches(); vi.stubGlobal('fetch', vi.fn(libre(62, 2))); });
  const ask = async (intent, locale = 'es-US', confirmationStatus = 'NONE') => {
    const req = new Request('https://cgm.test/alexa', { method: 'POST', body: JSON.stringify({ version: '1.0', context: { System: { application: { applicationId: 'amzn1.ask.skill.test' } } }, request: { type: 'IntentRequest', locale, timestamp: new Date().toISOString(), intent: { ...intent, confirmationStatus } } }) });
    const r = await (await handleCgm('alexa', req, ENV, { verifyAlexa: async () => {}, store: { ready: true, async recent() { return []; }, async upsert() { return 1; } }, forecasts: { ready: false }, history: { ready: false } })).json();
    return r.response.outputSpeech.text;
  };

  it('the reading, logging and help in Spanish; English Echoes stay English', async () => {
    expect(await ask({ name: 'GetGlucoseIntent', slots: {} })).toMatch(/^Atención\. Tienes la glucosa baja: 62 miligramos por decilitro y bajando, hace (un minuto|\d+ minutos)\.$/);
    expect(await ask({ name: 'LogInsulinIntent', slots: { units: { value: '4' }, insulin: { value: 'rápida', resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id: 'rapid' } }] }] } } } })).toBe('¿Registro 4 unidades de insulina rápida ahora?');
    expect(await ask({ name: 'AMAZON.HelpIntent', slots: {} })).toMatch(/^Pregúntame cómo está tu azúcar/);
    expect(await ask({ name: 'GetGlucoseIntent', slots: {} }, 'en-US')).toMatch(/^Warning\. You are low at 62 milligrams per deciliter/);
    expect(describePerson({ firstName: 'Ana', name: 'Ana', units: 'mg/dL', low: 70, high: 180, latest: { t: Date.now() - 2 * MIN, mg: 120, trend: 3 } }, { many: true, lang: 'es' })).toBe('Ana está en 120 miligramos por decilitro y estable, hace 2 minutos.');
  });
});

describe('the doctor\'s link in Spanish', () => {
  it('a link made in Spanish reports in Spanish', async () => {
    const screen = { kind: 'doctor', pid: 'p1', name: 'Dra. Ruiz', lang: 'es', expires_at: new Date(Date.now() + DAY).toISOString() };
    const d = await doctorData(screen, { history: { ready: true, async range() { return []; } }, doses: { ready: false }, snapshot: async () => ({ people: [] }) });
    expect(d.lang).toBe('es');
    const html = new Function(`${(await import('../workers/doctor.js')).REPORT_SCRIPT}; return reportHtml;`)()({ ...d, profile: Array(96).fill(null), ranges: d.ranges }, 'es');
    expect(html).toContain('Informe de glucosa');
    expect(html).toContain('Tiempo en rangos');
    expect(html).toContain('Para Dra. Ruiz');
  });
});

describe('the owner key from a header', () => {
  it('works like ?key= (the proxy moves it there so request logs never hold it)', async () => {
    resetCaches();
    const r = await handleCgm('history', new Request('https://x/history?days=1', { headers: { 'x-su94r-key': 'tv-key-123' } }), ENV, { history: { ready: true, async range() { return []; } } });
    expect(r.status).not.toBe(401);
    const bad = await handleCgm('history', new Request('https://x/history?days=1', { headers: { 'x-su94r-key': 'wrong' } }), ENV, { history: { ready: true, async range() { return []; } } });
    expect(bad.status).toBe(401);
  });
});
