// Night safety net: low-glucose alerts on the phone that work with every computer off.
//
// Every 5 minutes a database cron calls night/tick. The server reads LibreLinkUp itself (with
// the sign-in su94r Mini handed over), and when someone is low it pushes an alert to the
// owner's phone through ntfy (free app, no account: the phone subscribes to a private topic).
// The alert repeats until "I'm OK" is tapped in the notification or the glucose is back up:
// every 5 minutes for a severe low, every 10 minutes at night, every 20 minutes by day.
// A low that goes silent (sensor stops reporting) is pushed too. If caregivers subscribe to
// the care topic and it is switched on, the care-circle ladder (src/lib/care/escalation.js)
// decides when they are told.
//
// The topics are made by the server and shown only to a connected su94r Mini (owner key);
// anyone who knows a topic can read its alerts, so they are long and random.
//
// Table public.su94r_night (migration 20261002d_su94r_night.sql), one row, service role only.
//
// Routes:
//   POST night/tick                 the cron; anyone may call it, it runs at most every 4 minutes
//   GET  night/setup?key=<owner>    settings, subscribe links and the last check
//   POST night/setup?key=<owner>    { enabled, lowMgdl, severeMgdl, nightStart, nightEnd, timeZone, careEnabled }
//   POST night/test?key=<owner>     a test alert to the owner's phone
//   POST night/ack?t=<token>        the notification's "I'm OK" button

import { sha256, randomToken } from './screens.js';
import { evaluateEscalation, alertPayload, RUNG } from '../src/lib/care/escalation.js';
import { localHour } from '../src/lib/util/localDay.js';

const MIN = 60e3;
const TICK_GAP_MS = 4 * MIN;
const STALE_MS = 20 * MIN;          // a reading older than this counts as no reading
const GAP_AFTER_MS = 10 * MIN;      // a low that goes silent for this long is pushed
const AUTH_WARN_EVERY_MS = 12 * 60 * MIN;

export const NIGHT_DEFAULTS = {
  enabled: true, time_zone: 'America/New_York', low_mgdl: 70, severe_mgdl: 55,
  night_start: 22, night_end: 7, care_enabled: false,
};

export function nightStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_night`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('The night store is not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Night store answered ${res.status}`);
    const text = res.status === 204 ? '' : await res.text();
    return text ? JSON.parse(text) : [];
  }
  return {
    ready,
    /** The row, made with defaults and fresh topics the first time. */
    async get() {
      const row = (await call('?select=*&id=eq.1'))[0];
      if (row) return row;
      const made = { id: 1, ...NIGHT_DEFAULTS, self_topic: newTopic(), care_topic: newTopic(), state: {}, updated_at: new Date().toISOString() };
      await call('', { method: 'POST', body: JSON.stringify(made), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
      return (await call('?select=*&id=eq.1'))[0] || made;
    },
    patch: (fields) => call('?id=eq.1', { method: 'PATCH', body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } }),
    /** Takes this run's turn: true only if no run started in the last 4 minutes. */
    async claimTick(now = Date.now()) {
      const before = new Date(now - TICK_GAP_MS).toISOString();
      const rows = await call(`?id=eq.1&or=(last_tick_at.is.null,last_tick_at.lt.${encodeURIComponent(before)})`, {
        method: 'PATCH', body: JSON.stringify({ last_tick_at: new Date(now).toISOString() }),
      });
      return rows.length > 0;
    },
  };
}

const newTopic = () => `su94r-${randomToken(8)}`;

/** Sends one push through ntfy (env.NTFY_BASE for a self-hosted server, env.NTFY_TOKEN for an account). */
export async function ntfyPush(env, topic, msg, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = (env.NTFY_BASE || 'https://ntfy.sh').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}) },
    body: JSON.stringify({ topic, ...msg }),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  return true;
}

const hourIn = (h, start, end) => (start <= end ? h >= start && h < end : h >= start || h < end);

function fmt(person, mg) {
  if (mg < 40) return 'LO';
  return person.units === 'mmol/L' ? `${(mg / 18.0182).toFixed(1)} mmol/L` : `${Math.round(mg)} mg/dL`;
}
const ARROWS = ['', '↓', '↘', '→', '↗', '↑'];

function repeatMs(severe, night) {
  if (severe) return 5 * MIN;
  return night ? 10 * MIN : 20 * MIN;
}

/**
 * One check. Pure apart from `push` and the returned state: given the row, the people and
 * the time, decides what to push and returns the new state.
 *   people: snapshot people [{ pid, firstName, name, units, latest: { t, mg, trend } }]
 *   push(topic, msg) sends; ackUrl(token) builds the "I'm OK" address.
 */
export async function nightCheck({ row, people, error = null, now = Date.now(), push, ackUrl }) {
  const cfg = { ...NIGHT_DEFAULTS, ...row };
  const state = structuredClone(row.state || {});
  const sent = [];
  const send = async (topic, msg, label) => {
    try { await push(topic, msg); sent.push({ label, ok: true }); } catch (e) { sent.push({ label, ok: false, error: e.message }); }
  };
  const night = hourIn(localHour(now, cfg.time_zone), cfg.night_start, cfg.night_end);
  if (!cfg.enabled) return { state, sent, skipped: 'off' };

  // Without a reading from LibreLinkUp, everyone who was low counts as gone silent.
  const openLows = Object.entries(state).filter(([k]) => k !== '_meta')
    .map(([pid, ep]) => ({ pid, firstName: ep.name || '', name: ep.name || '', units: ep.units, latest: null }));
  const list = error ? openLows : people;
  const many = list.length > 1;
  const who = (p) => (many ? `${p.firstName || p.name}: ` : '');

  // The server cannot read LibreLinkUp: say so (every 12 hours), and treat every open low as gone silent.
  if (error) {
    if (error.code === 'auth' || error.code === 'config') {
      const meta = state._meta || {};
      if (!meta.authWarnAt || now - meta.authWarnAt > AUTH_WARN_EVERY_MS) {
        await send(cfg.self_topic, {
          title: 'su94r cannot read your glucose',
          message: 'The su94r server lost its LibreLinkUp sign-in, so night alerts are paused. Open su94r Mini on your computer; it reconnects by itself.',
          priority: 4, tags: ['warning'],
        }, 'signin');
        state._meta = { ...meta, authWarnAt: now };
      }
    }
  }

  const seen = new Set();
  for (const p of list) {
    seen.add(p.pid);
    const l = p.latest && now - p.latest.t <= STALE_MS ? p.latest : null;
    let ep = state[p.pid] || null;
    const low = cfg.low_mgdl;
    if (ep && !l && now - ep.since > 6 * 60 * MIN) { delete state[p.pid]; continue; }   // an old episode, not an ongoing one
    if (ep) Object.assign(ep, { name: p.firstName || p.name || ep.name || '', units: p.units || ep.units });

    if (l && l.mg >= low) {
      if (ep?.notified) {
        await send(cfg.self_topic, { title: `${who(p)}Back up: ${fmt(p, l.mg)}`, message: 'The low is over.', priority: 3, tags: ['white_check_mark'] }, 'recovered');
      }
      delete state[p.pid];
      continue;
    }

    if (l) {
      // Low.
      const severe = l.mg < cfg.severe_mgdl;
      ep = ep || { since: now, count: 0, name: p.firstName || p.name || '', units: p.units };
      ep.lastMg = l.mg;
      ep.gapAt = null;
      const wasSevere = ep.severe;
      ep.severe = Boolean(ep.severe || severe);
      const due = !ep.notified
        || (!ep.ackAt && now - ep.notified >= repeatMs(severe, night))
        || (ep.ackAt && severe && !wasSevere);           // severe after an "I'm OK" still tells once
      if (due) {
        const token = randomToken(16);
        ep.ackHash = await sha256(token);
        ep.firstAt = ep.firstAt || now;
        ep.notified = now;
        ep.count += 1;
        await send(cfg.self_topic, {
          title: `${who(p)}${severe ? 'Severe low' : 'Low'}: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim(),
          message: `${severe ? 'Treat now with fast sugar.' : 'Treat with fast sugar.'} Tap "I'm OK" once you have.${ep.count > 1 ? ` (Reminder ${ep.count})` : ''}`,
          priority: severe || night ? 5 : 4,
          tags: [severe ? 'rotating_light' : 'warning'],
          actions: [{ action: 'http', label: "I'm OK", url: ackUrl(token), method: 'POST', clear: true }],
        }, severe ? 'severe' : 'low');
      }
    } else if (ep && !ep.ackAt && now - ep.since >= GAP_AFTER_MS) {
      // Was low and has gone silent: a lost sensor and a person who cannot answer look the same.
      if (!ep.gapAt || now - ep.gapAt >= 5 * MIN) {
        const token = randomToken(16);
        ep.ackHash = await sha256(token);
        ep.gapAt = now;
        ep.notified = ep.notified || now;
        await send(cfg.self_topic, {
          title: `${who(p)}Low, and the sensor stopped reporting`,
          message: `Last reading ${fmt(p, ep.lastMg ?? low)}. Check now. Tap "I'm OK" once you have.`,
          priority: 5, tags: ['rotating_light'],
          actions: [{ action: 'http', label: "I'm OK", url: ackUrl(token), method: 'POST', clear: true }],
        }, 'gap');
      }
    }

    if (ep && cfg.care_enabled && cfg.care_topic) {
      // Caregivers: the escalation ladder decides when, from when the low began.
      const decision = evaluateEscalation({
        reading: l ? { value: l.mg } : { value: null },
        lowSince: ep.since, acknowledged: Boolean(ep.ackAt),
        highestRungFired: ep.careRung || (ep.notified ? RUNG.SELF : RUNG.NONE),
        lastRungAt: ep.careAt || ep.firstAt || ep.notified || null,   // the person's own reminders do not reset the ladder
        circleSize: 1,
        policy: { lowMgdl: cfg.low_mgdl, severeMgdl: cfg.severe_mgdl, nightStartHour: cfg.night_start, nightEndHour: cfg.night_end },
        timeZone: cfg.time_zone, now,
      });
      if (decision.rung !== RUNG.NONE && decision.rung !== RUNG.SELF) {
        const payload = alertPayload(decision, { name: p.firstName || p.name || 'Your person' });
        ep.careRung = decision.rung;
        ep.careAt = now;
        await send(cfg.care_topic, { title: payload.title, message: payload.body, priority: payload.urgency === 'critical' ? 5 : 4, tags: ['rotating_light'] }, 'care');
      }
    }
    if (ep) state[p.pid] = ep;
  }
  // People no longer followed: forget their episodes.
  if (!error) for (const pid of Object.keys(state)) if (pid !== '_meta' && !seen.has(pid)) delete state[pid];
  return { state, sent, night };
}

/** Marks the episode whose "I'm OK" token this is as acknowledged. */
export async function acknowledge(row, token, now = Date.now()) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const hash = await sha256(token);
  const state = structuredClone(row.state || {});
  for (const [pid, ep] of Object.entries(state)) {
    if (pid !== '_meta' && ep?.ackHash === hash) {
      ep.ackAt = now;
      ep.ackHash = null;
      return state;
    }
  }
  return null;
}

const TZ_OK = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const int = (v, lo, hi) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined);

/** Settings su94r Mini may change; anything else in the body is ignored. */
function settingsPatch(body, row) {
  const out = {};
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (typeof body.careEnabled === 'boolean') out.care_enabled = body.careEnabled;
  const low = int(body.lowMgdl, 60, 100);
  if (low !== undefined) out.low_mgdl = low;
  const severe = int(body.severeMgdl, 40, 70);
  if (severe !== undefined) out.severe_mgdl = severe;
  if ((out.severe_mgdl ?? row.severe_mgdl) >= (out.low_mgdl ?? row.low_mgdl)) throw Object.assign(new Error('The severe level has to be below the low level.'), { status: 400 });
  const ns = int(body.nightStart, 0, 23);
  if (ns !== undefined) out.night_start = ns;
  const ne = int(body.nightEnd, 0, 23);
  if (ne !== undefined) out.night_end = ne;
  if (typeof body.timeZone === 'string' && TZ_OK(body.timeZone)) out.time_zone = body.timeZone;
  return out;
}

function publicView(row, base) {
  const topicUrl = (t) => `${base}/${t}`;
  const meta = row.state?._meta || {};
  const open = Object.entries(row.state || {}).filter(([k]) => k !== '_meta').length;
  return {
    enabled: row.enabled, lowMgdl: row.low_mgdl, severeMgdl: row.severe_mgdl,
    nightStart: row.night_start, nightEnd: row.night_end, timeZone: row.time_zone, careEnabled: row.care_enabled,
    selfTopic: row.self_topic, selfUrl: topicUrl(row.self_topic),
    careTopic: row.care_topic, careUrl: topicUrl(row.care_topic),
    lastTickAt: row.last_tick_at, lastResult: row.last_result || null, openLows: open, signInWarnedAt: meta.authWarnAt || null,
  };
}

export async function nightRoute(path, request, url, env, { store, json, keyOk, snapshot, push, now = () => Date.now() }) {
  if (path !== 'night/tick' && path !== 'night/setup' && path !== 'night/test' && path !== 'night/ack') return null;
  if (!store.ready) return json({ error: 'not configured' }, 503);
  const sendPush = push || ((topic, msg) => ntfyPush(env, topic, msg));
  const ntfyBase = (env.NTFY_BASE || 'https://ntfy.sh').replace(/\/$/, '');
  const ackBase = `${String(env.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/su94r-cgm/night/ack`;

  if (path === 'night/ack') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const row = await store.get();
    const state = await acknowledge(row, url.searchParams.get('t'), now());
    if (!state) return json({ error: 'unknown or used' }, 404);
    await store.patch({ state });
    return json({ ok: true, message: 'Got it. Alerts for this low stop; a severe low still tells you once.' });
  }

  if (path === 'night/tick') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    await store.get();                                   // makes the row the first time
    if (!(await store.claimTick(now()))) return json({ ok: true, skipped: 'too soon' });
    const row = await store.get();
    let people = [];
    let error = null;
    try { people = (await snapshot()).people || []; } catch (e) { error = { code: e.code || 'error', message: String(e.message || e).slice(0, 200) }; }
    const result = await nightCheck({ row, people, error, now: now(), push: sendPush, ackUrl: (t) => `${ackBase}?t=${t}` });
    const summary = { at: new Date(now()).toISOString(), people: people.length, sent: result.sent, error: error?.code || null, night: result.night ?? null };
    await store.patch({ state: result.state, last_result: summary });
    return json({ ok: true, people: summary.people, sent: summary.sent.length, error: summary.error });
  }

  // Owner-only below.
  if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
  const row = await store.get();

  if (path === 'night/test') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    try {
      await sendPush(row.self_topic, { title: 'su94r test alert', message: 'Night alerts reach this phone. A real low comes with an "I\'m OK" button.', priority: 4, tags: ['test_tube'] });
    } catch (e) {
      return json({ error: 'push-failed', message: `The alert did not go out (${e.message}). Try again in a minute.` }, 502);
    }
    return json({ ok: true });
  }

  // night/setup
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    let patch;
    try { patch = settingsPatch(body, row); } catch (e) { return json({ error: 'bad-setting', message: e.message }, e.status || 400); }
    if (Object.keys(patch).length) await store.patch(patch);
    return json(publicView({ ...row, ...patch }, ntfyBase));
  }
  return json(publicView(row, ntfyBase));
}
