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
//
// Modes (night/setup { mode, modeHours }, or the app's app/mode), each ending by itself:
//   exercise  "Low soon" warns earlier: from 10 mg/dL above the low line, 30 minutes ahead
//   sick      a sick-day check every 4 hours while awake (every 2 when above 250 mg/dL)
//
// Every alert goes to ntfy, to the linked Telegram chats and to the phones that turned on alerts
// in the su94r app (webpush.js), each by role. A low treated from the app (app/treat in app.js)
// stops the reminders and is rechecked after the owner's plan's minutes; still low, they resume.

import { sha256, randomToken } from './screens.js';
import { evaluateEscalation, alertPayload, RUNG } from '../src/lib/care/escalation.js';
import { localHour } from '../src/lib/util/localDay.js';
import { rowsFromSnapshot } from './history.js';
import { missedDoseNudges } from './nudges.js';
import { supplyStatus, supplyReminders } from './supplies.js';

const MIN = 60e3;
const TICK_GAP_MS = 4 * MIN;
const STALE_MS = 20 * MIN;          // a reading older than this counts as no reading
const GAP_AFTER_MS = 10 * MIN;      // a low that goes silent for this long is pushed
const AUTH_WARN_EVERY_MS = 12 * 60 * MIN;

export const NIGHT_DEFAULTS = {
  enabled: true, time_zone: 'America/New_York', low_mgdl: 70, severe_mgdl: 55,
  night_start: 22, night_end: 7, care_enabled: false, soon_enabled: true, watch_enabled: true, sensor_days: 14,
  echo_low_url: null, echo_soon_url: null, echo_always: false,
  treat_grams: 15, treat_minutes: 15, treat_plan: null, nudge_enabled: true, lang_self: 'en', lang_care: 'en',
  mode: null, mode_until: null,
};

export const EXERCISE_MARGIN = 10;                 // mg/dL above the low line that "Low soon" watches in exercise mode
const SICK_KETONE_MGDL = 250;
const MODE_HOURS = { exercise: { def: 2, max: 12 }, sick: { def: 24, max: 72 } };

/** 'exercise', 'sick' or null: the mode in force now (a mode ends by itself at mode_until). */
export function activeMode(row, now = Date.now()) {
  return (row?.mode === 'exercise' || row?.mode === 'sick') && row.mode_until && Date.parse(row.mode_until) > now ? row.mode : null;
}

/** The columns for a mode turned on for `hours` (default 2 for exercise, 24 for sick) or off. */
export function modeFields(mode, hours, now = Date.now()) {
  if (mode === 'off' || mode === null || mode === '') return { mode: null, mode_until: null };
  const h = MODE_HOURS[mode];
  if (!h) throw Object.assign(new Error('Pick exercise or sick day.'), { status: 400 });
  const n = Number(hours);
  const len = Number.isFinite(n) && n > 0 ? Math.min(h.max, Math.max(0.5, n)) : h.def;
  return { mode, mode_until: new Date(now + len * 60 * MIN).toISOString() };
}

/** The alert in one language: msg.es holds the Spanish words, and "I'm OK" becomes "Estoy bien". */
export function inLanguage(msg, lang) {
  if (lang !== 'es' || !msg?.es) return msg;
  const { es, ...rest } = msg;
  return { ...rest, title: es.title ?? msg.title, message: es.message ?? msg.message, actions: (msg.actions || []).map((a) => ({ ...a, label: a.label === "I'm OK" ? 'Estoy bien' : a.label })) };
}
const sensorWhenEs = (left, ends, tz) => (left > 12 * 60 * MIN ? `mañana alrededor de las ${localTime(ends, tz)}` : `hoy alrededor de las ${localTime(ends, tz)}`);

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

// State keys starting with "_" are not lows: _meta, _soon (low-soon warnings), _watch (sensor
// and signal warnings), _last (the previous check's reading, for the rate of change).
const isLowKey = (k) => !k.startsWith('_');

const SOON_MIN = 20;                         // how far ahead "Low soon" looks
const ARROW_RATE = { 1: -2.5, 2: -1.5, 3: 0, 4: 1.5, 5: 2.5 };   // LibreLinkUp trend → mg/dL a minute

/** mg/dL a minute, from the previous check, else the graph, else the trend arrow; null if unknown. */
export function rateOf(p, l, last) {
  const between = (q, lo, hi) => q && l.t - q.t >= lo * MIN && l.t - q.t <= hi * MIN;
  if (between(last, 3, 12)) return (l.mg - last.mg) / ((l.t - last.t) / MIN);
  const ref = (p.history || []).filter((q) => between(q, 8, 20)).sort((a, b) => b.t - a.t)[0];
  if (ref) return (l.mg - ref.mg) / ((l.t - ref.t) / MIN);
  return ARROW_RATE[l.trend] ?? null;
}

function localTime(t, timeZone) {
  try { return new Date(t).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }); } catch { return new Date(t).toISOString().slice(11, 16); }
}

/**
 * One check. Pure apart from `push` and the returned state: given the row, the people and
 * the time, decides what to push and returns the new state.
 *   people: snapshot people [{ pid, firstName, name, units, latest: { t, mg, trend } }]
 *   push(topic, msg) sends; ackUrl(token) builds the "I'm OK" address.
 */
export async function nightCheck({ row, people, error = null, now = Date.now(), push, ackUrl, ring = null }) {
  const cfg = { ...NIGHT_DEFAULTS, ...row };
  const state = structuredClone(row.state || {});
  const sent = [];
  const send = async (topic, msg, label) => {
    try { await push(topic, msg); sent.push({ label, ok: true }); } catch (e) { sent.push({ label, ok: false, error: e.message }); }
  };
  const night = hourIn(localHour(now, cfg.time_zone), cfg.night_start, cfg.night_end);
  if (!cfg.enabled) return { state, sent, skipped: 'off' };
  const exercise = activeMode(cfg, now) === 'exercise';

  // The Echo in the room says it out loud (an Alexa routine fired by its trigger link): at night,
  // for a severe low at any hour, or always when the owner chose so. Each reminder fires again.
  const echo = async (kind, severe = false) => {
    const url = kind === 'soon' ? cfg.echo_soon_url : cfg.echo_low_url;
    if (!url || !ring || !(night || severe || cfg.echo_always)) return;
    try { await ring(url); sent.push({ label: `echo-${kind}`, ok: true }); } catch (e) { sent.push({ label: `echo-${kind}`, ok: false, error: e.message }); }
  };

  // Without a reading from LibreLinkUp, everyone who was low counts as gone silent.
  const openLows = Object.entries(state).filter(([k]) => isLowKey(k))
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
          es: { title: 'su94r no puede leer tu glucosa', message: 'El servidor de su94r perdió su sesión de LibreLinkUp, así que las alertas nocturnas están en pausa. Abre su94r Mini en tu computadora; se vuelve a conectar solo.' },
        }, 'signin');
        state._meta = { ...meta, authWarnAt: now };
      }
    }
  }

  // "Low soon": in range now, but falling so that it is likely under the low line within
  // 20 minutes. Once per fall, repeated after 15 minutes (at most 3 times) until "I'm OK".
  async function lowSoon(p, l, last) {
    // Exercise mode watches a higher line, further ahead, and a gentler fall.
    const low = cfg.low_mgdl + (exercise ? EXERCISE_MARGIN : 0);
    const rate = rateOf(p, l, last);
    const projected = rate == null ? null : l.mg + rate * (exercise ? 30 : SOON_MIN);
    const falling = l.trend === 1 || l.trend === 2 || (rate != null && rate <= (exercise ? -1 : -1.5));
    const soon = state._soon[p.pid];
    if (projected != null && falling && rate < 0 && projected < low && l.mg < low + 45) {
      if (soon && (soon.ackAt || soon.count >= 3 || now - soon.at < 15 * MIN)) return;
      const token = randomToken(16);
      const mins = Math.max(5, Math.round((l.mg - low) / -rate));
      const severeSoon = projected < cfg.severe_mgdl;
      state._soon[p.pid] = { at: now, count: (soon?.count || 0) + 1, ackHash: await sha256(token) };
      await send(cfg.self_topic, {
        title: `${who(p)}Low soon: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim(),
        message: `${exercise ? 'Exercise mode. ' : ''}Falling about ${Math.abs(rate).toFixed(1)} mg/dL a minute: likely under ${fmt(p, low)} in about ${mins} min${severeSoon ? ', and fast' : ''}. Have fast sugar ready. Tap "I'm OK" once you have handled it.`,
        es: { title: `${who(p)}Baja pronto: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim(), message: `${exercise ? 'Modo ejercicio. ' : ''}Bajando unos ${Math.abs(rate).toFixed(1)} mg/dL por minuto: probablemente por debajo de ${fmt(p, low)} en unos ${mins} min${severeSoon ? ', y rápido' : ''}. Ten azúcar rápida a mano. Toca "Estoy bien" cuando lo hayas atendido.` },
        priority: night || severeSoon ? 5 : 4,
        tags: ['chart_with_downwards_trend'],
        actions: [{ action: 'http', label: "I'm OK", url: ackUrl(token), method: 'POST', clear: true }],
      }, 'soon');
      await echo('soon', severeSoon);
    } else if (soon && (projected == null || projected >= low + 10 || !falling)) {
      delete state._soon[p.pid];                        // the fall stopped: the next one warns again
    }
  }

  // Sensor and signal: no readings for 30+ minutes (said once per gap, and when they are back),
  // and a sensor that ends within a day (said once per sensor).
  async function watchdog(p, l, ep) {
    const w = state._watch[p.pid] || {};
    if (!l && p.latest && !ep && now - p.latest.t >= 30 * MIN && w.gapFor !== p.latest.t) {
      w.gapFor = p.latest.t;
      await send(cfg.self_topic, {
        title: `${who(p)}No glucose for ${Math.round((now - p.latest.t) / MIN)} min`,
        message: 'Libre has not sent a reading. Check the sensor and the phone\'s Libre app (open, Bluetooth on). Lows cannot be seen until readings come back.',
        priority: night ? 4 : 3, tags: ['satellite'],
        es: { title: `${who(p)}Sin glucosa desde hace ${Math.round((now - p.latest.t) / MIN)} min`, message: 'Libre no ha enviado lecturas. Revisa el sensor y la app de Libre del teléfono (abierta, Bluetooth encendido). No se pueden ver las bajas hasta que vuelvan las lecturas.' },
      }, 'signal');
    } else if (l && w.gapFor) {
      delete w.gapFor;
      await send(cfg.self_topic, { title: `${who(p)}Readings are back: ${fmt(p, l.mg)}`, message: 'Libre is sending again.', priority: 2, tags: ['white_check_mark'], es: { title: `${who(p)}Volvieron las lecturas: ${fmt(p, l.mg)}`, message: 'Libre está enviando otra vez.' } }, 'signal-back');
    }
    const days = Number(cfg.sensor_days) || 14;
    const ends = p.sensorStart ? p.sensorStart + days * 24 * 60 * MIN : null;
    if (ends && now >= ends - 24 * 60 * MIN && now < ends && w.sensorFor !== p.sensorStart) {
      w.sensorFor = p.sensorStart;
      const left = ends - now;
      const when = left > 12 * 60 * MIN ? `tomorrow around ${localTime(ends, cfg.time_zone)}` : `today around ${localTime(ends, cfg.time_zone)}`;
      await send(cfg.self_topic, { title: `${who(p)}Sensor ends ${when}`, message: 'Have the next sensor ready. Readings stop when it ends.', priority: 3, tags: ['hourglass'], es: { title: `${who(p)}El sensor termina ${sensorWhenEs(left, ends, cfg.time_zone)}`, message: 'Ten listo el próximo sensor. Las lecturas paran cuando termina.' } }, 'sensor');
    }
    state._watch[p.pid] = w;
  }

  const seen = new Set();
  const recovered = new Set();
  state._soon = state._soon || {};
  state._watch = state._watch || {};
  state._last = state._last || {};
  state._sensors = state._sensors || {};
  for (const p of list) {
    seen.add(p.pid);
    // Sensor starts, for counting sensors down (supplies.js).
    if (p.sensorStart && !(state._sensors[p.pid] || []).includes(p.sensorStart)) state._sensors[p.pid] = [...(state._sensors[p.pid] || []), p.sensorStart].slice(-12);
    const l = p.latest && now - p.latest.t <= STALE_MS ? p.latest : null;
    let ep = state[p.pid] || null;
    const low = cfg.low_mgdl;
    const last = state._last[p.pid];
    if (l) state._last[p.pid] = { t: l.t, mg: l.mg };
    if (!error && cfg.watch_enabled !== false) await watchdog(p, l, ep);
    if (ep && !l && now - ep.since > 6 * 60 * MIN) { delete state[p.pid]; continue; }   // an old episode, not an ongoing one
    if (ep) Object.assign(ep, { name: p.firstName || p.name || ep.name || '', units: p.units || ep.units });

    if (l && l.mg >= low) {
      if (ep?.notified) {
        await send(cfg.self_topic, { title: `${who(p)}Back up: ${fmt(p, l.mg)}`, message: 'The low is over.', priority: 3, tags: ['white_check_mark'], es: { title: `${who(p)}Volvió a subir: ${fmt(p, l.mg)}`, message: 'La baja terminó.' } }, 'recovered');
        recovered.add(p.pid);
      }
      delete state[p.pid];
      if (cfg.soon_enabled !== false || exercise) await lowSoon(p, l, last);
      continue;
    }

    if (l) {
      // Low. A "Low soon" warning for it is done; the low alerts take over.
      delete state._soon[p.pid];
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
          message: `${cfg.treat_plan ? `${severe ? 'Treat now.' : 'Treat it.'} Your plan: ${cfg.treat_plan}.` : severe ? 'Treat now with fast sugar.' : 'Treat with fast sugar.'} Tap "I'm OK" once you have.${ep.count > 1 ? ` (Reminder ${ep.count})` : ''}`,
          es: { title: `${who(p)}${severe ? 'Baja severa' : 'Baja'}: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim(), message: `${cfg.treat_plan ? `${severe ? 'Trátala ya.' : 'Trátala.'} Tu plan: ${cfg.treat_plan}.` : severe ? 'Trátala ya con azúcar rápida.' : 'Trátala con azúcar rápida.'} Toca "Estoy bien" cuando lo hayas hecho.${ep.count > 1 ? ` (Recordatorio ${ep.count})` : ''}` },
          priority: severe || night ? 5 : 4,
          tags: [severe ? 'rotating_light' : 'warning'],
          actions: [{ action: 'http', label: "I'm OK", url: ackUrl(token), method: 'POST', clear: true }],
        }, severe ? 'severe' : 'low');
        await echo('low', severe);
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
          es: { title: `${who(p)}Baja, y el sensor dejó de reportar`, message: `Última lectura ${fmt(p, ep.lastMg ?? low)}. Revisa ahora. Toca "Estoy bien" cuando lo hayas hecho.` },
          priority: 5, tags: ['rotating_light'],
          actions: [{ action: 'http', label: "I'm OK", url: ackUrl(token), method: 'POST', clear: true }],
        }, 'gap');
        await echo('low', true);
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
        const nameEs = p.firstName || p.name || 'Tu familiar';
        const urgentEs = payload.urgency === 'critical';
        await send(cfg.care_topic, { title: payload.title, message: payload.body, priority: urgentEs ? 5 : 4, tags: ['rotating_light'], es: { title: urgentEs ? `${nameEs} necesita ayuda ahora` : `${nameEs} tiene la glucosa baja`, message: `${ep.lastMg != null ? `Última lectura ${fmt(p, ep.lastMg)}.` : ''}${decision.dataGap ? ' El sensor dejó de reportar.' : ''}${ep.ackAt ? '' : ' No ha respondido la alerta.'} Revisa cómo está.`.trim() } }, 'care');
      }
    }
    if (ep) state[p.pid] = ep;
  }
  // A low treated from the app: after the plan's minutes, say where it went. Still low (or no
  // reading), the reminders start again.
  state._treat = state._treat || {};
  for (const [pid, tr] of Object.entries(state._treat)) {
    if (now - tr.t > 3 * 60 * MIN) { delete state._treat[pid]; continue; }
    if (tr.done || now < tr.recheckAt) continue;
    tr.done = true;
    const p = list.find((x) => x.pid === pid);
    if (!p || recovered.has(pid)) continue;                    // "Back up" already said it
    const l = p.latest && now - p.latest.t <= STALE_MS ? p.latest : null;
    const at = localTime(tr.t, cfg.time_zone);
    if (l && l.mg >= cfg.low_mgdl) {
      await send(cfg.self_topic, {
        title: `${who(p)}Recheck: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim(),
        message: tr.mg != null ? `Up from ${fmt(p, tr.mg)} when ${tr.grams} g was logged at ${at}.` : `${tr.grams} g was logged at ${at}.`,
        priority: 3, tags: ['white_check_mark'],
        es: { title: `${who(p)}Revisión: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim(), message: tr.mg != null ? `Subió desde ${fmt(p, tr.mg)} cuando se registraron ${tr.grams} g a las ${at}.` : `Se registraron ${tr.grams} g a las ${at}.` },
      }, 'recheck');
      continue;
    }
    const ep = state[pid] || { since: tr.t, count: 0, name: p.firstName || p.name || '', units: p.units };
    const token = randomToken(16);
    ep.ackHash = await sha256(token);
    ep.ackAt = null;
    ep.notified = now;
    ep.count = (ep.count || 0) + 1;
    state[pid] = ep;
    await send(cfg.self_topic, {
      title: l ? `${who(p)}Still low after treating: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim() : `${who(p)}Could not recheck: no reading`,
      message: `${tr.grams} g at ${at}. ${l ? (cfg.treat_plan ? `Your plan: ${cfg.treat_plan}.` : 'Treat again with fast sugar.') : 'Check with a meter.'} Reminders start again until you are above ${fmt(p, cfg.low_mgdl)}. Tap "I'm OK" once you have.`,
      priority: 5, tags: ['rotating_light'],
      actions: [{ action: 'http', label: "I'm OK", url: ackUrl(token), method: 'POST', clear: true }],
      es: {
        title: l ? `${who(p)}Sigue baja después de tratarla: ${fmt(p, l.mg)} ${ARROWS[l.trend] || ''}`.trim() : `${who(p)}No se pudo revisar: sin lectura`,
        message: `${tr.grams} g a las ${at}. ${l ? (cfg.treat_plan ? `Tu plan: ${cfg.treat_plan}.` : 'Trátala otra vez con azúcar rápida.') : 'Mide con un glucómetro.'} Los recordatorios vuelven a empezar hasta que estés por encima de ${fmt(p, cfg.low_mgdl)}. Toca "Estoy bien" cuando lo hayas hecho.`,
      },
    }, 'recheck-low');
    await echo('low', true);
  }

  // People no longer followed: forget their episodes and warnings.
  if (!error) {
    for (const pid of Object.keys(state)) if (isLowKey(pid) && !seen.has(pid)) delete state[pid];
    for (const box of [state._soon, state._watch, state._last]) for (const pid of Object.keys(box)) if (!seen.has(pid)) delete box[pid];
  }
  return { state, sent, night };
}

/**
 * A low treated from the app: the carbs are logged (by the caller), the reminders for the open
 * low stop, and a recheck is due after the plan's minutes. Returns the new state, the episode
 * as it was (caregivers who were told hear that it is handled) and when the recheck is.
 */
export function startTreatment(row, pid, { now = Date.now(), grams, by = '', mg = null } = {}) {
  const state = structuredClone(row.state || {});
  const before = state[pid] ? { ...state[pid] } : null;
  if (state[pid]) { state[pid].ackAt = now; state[pid].ackHash = null; }
  const minutes = Number(row.treat_minutes) || NIGHT_DEFAULTS.treat_minutes;
  const recheckAt = now + minutes * MIN;
  state._treat = { ...(state._treat || {}), [pid]: { t: now, grams, by: String(by || '').slice(0, 40), mg, recheckAt, done: false } };
  return { state, ep: before, recheckAt };
}

/** Marks the episode whose "I'm OK" token this is as acknowledged. */
export async function acknowledge(row, token, now = Date.now()) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const hash = await sha256(token);
  const state = structuredClone(row.state || {});
  const entries = [...Object.entries(state).filter(([k]) => isLowKey(k)), ...Object.entries(state._soon || {})];
  for (const [, ep] of entries) {
    if (ep?.ackHash === hash) {
      ep.ackAt = now;
      ep.ackHash = null;
      return state;
    }
  }
  return null;
}

/** "I'm OK" from a phone that may log (the bedside screen): every open low and Low soon warning. */
export function acknowledgeAll(row, now = Date.now()) {
  const state = structuredClone(row.state || {});
  let count = 0;
  const eps = [...Object.entries(state).filter(([k]) => isLowKey(k)).map(([, ep]) => ep), ...Object.values(state._soon || {})];
  for (const ep of eps) if (ep && !ep.ackAt) { ep.ackAt = now; ep.ackHash = null; count += 1; }
  return { state, count };
}

// Trigger links of the free Virtual Smart Home skill (an Alexa routine per link). They are
// private keys: stored here, never shown back.
export const ECHO_URL = /^https:\/\/(www\.)?virtualsmarthome\.xyz\/url_routine_trigger\/[^\s]{10,500}$/;

const TZ_OK = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const int = (v, lo, hi) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined);

/** Settings su94r Mini may change; anything else in the body is ignored. */
function settingsPatch(body, row) {
  const out = {};
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (typeof body.careEnabled === 'boolean') out.care_enabled = body.careEnabled;
  if (typeof body.soonEnabled === 'boolean') out.soon_enabled = body.soonEnabled;
  if (typeof body.watchEnabled === 'boolean') out.watch_enabled = body.watchEnabled;
  if (typeof body.nudgeEnabled === 'boolean') out.nudge_enabled = body.nudgeEnabled;
  for (const [key, col] of [['langSelf', 'lang_self'], ['langCare', 'lang_care']]) if (body[key] === 'en' || body[key] === 'es') out[col] = body[key];
  const tg = int(body.treatGrams, 5, 60);
  if (tg !== undefined) out.treat_grams = tg;
  const tm = int(body.treatMinutes, 5, 30);
  if (tm !== undefined) out.treat_minutes = tm;
  if (body.treatPlan !== undefined) out.treat_plan = String(body.treatPlan || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null;
  const sd = int(body.sensorDays, 10, 15);
  if (sd !== undefined) out.sensor_days = sd;
  if (typeof body.echoAlways === 'boolean') out.echo_always = body.echoAlways;
  for (const [key, col] of [['echoLowUrl', 'echo_low_url'], ['echoSoonUrl', 'echo_soon_url']]) {
    if (body[key] === undefined) continue;
    const v = String(body[key] || '').trim();
    if (!v) { out[col] = null; continue; }
    if (!ECHO_URL.test(v)) throw Object.assign(new Error('Paste the trigger link from virtualsmarthome.xyz (it starts with https://www.virtualsmarthome.xyz/url_routine_trigger/).'), { status: 400 });
    out[col] = v;
  }
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
  if (body.mode !== undefined) Object.assign(out, modeFields(body.mode, body.modeHours));
  return out;
}

function publicView(row, base) {
  const topicUrl = (t) => `${base}/${t}`;
  const meta = row.state?._meta || {};
  const open = Object.keys(row.state || {}).filter(isLowKey).length;
  return {
    enabled: row.enabled, lowMgdl: row.low_mgdl, severeMgdl: row.severe_mgdl,
    soonEnabled: row.soon_enabled !== false, watchEnabled: row.watch_enabled !== false, sensorDays: row.sensor_days || 14, nudgeEnabled: row.nudge_enabled !== false, langSelf: row.lang_self || 'en', langCare: row.lang_care || 'en',
    echoLow: Boolean(row.echo_low_url), echoSoon: Boolean(row.echo_soon_url), echoAlways: Boolean(row.echo_always),
    treatGrams: row.treat_grams ?? NIGHT_DEFAULTS.treat_grams, treatMinutes: row.treat_minutes ?? NIGHT_DEFAULTS.treat_minutes, treatPlan: row.treat_plan || '',
    nightStart: row.night_start, nightEnd: row.night_end, timeZone: row.time_zone, careEnabled: row.care_enabled,
    selfTopic: row.self_topic, selfUrl: topicUrl(row.self_topic),
    careTopic: row.care_topic, careUrl: topicUrl(row.care_topic),
    lastTickAt: row.last_tick_at, lastResult: row.last_result || null, openLows: open, signInWarnedAt: meta.authWarnAt || null,
    mode: activeMode(row), modeUntil: activeMode(row) ? row.mode_until : null,
  };
}

/**
 * One alert to everyone of a role ('me' or 'family'): ntfy (the role's topic), the linked Telegram
 * chats (telegram.js) and the phones with app alerts on (webpush.js). It counts as sent when any
 * one of them took it.
 */
export function alertFanOut(env, row, { push = null, telegram = null, webpush = null } = {}) {
  const ntfy = push || ((topic, msg) => ntfyPush(env, topic, msg));
  return async (role, msg) => {
    const topic = role === 'family' ? row.care_topic : row.self_topic;
    const lang = role === 'family' ? row.lang_care : row.lang_self;
    const [viaNtfy, viaTg, viaApp] = await Promise.allSettled([
      topic ? ntfy(topic, inLanguage(msg, lang)) : Promise.reject(new Error('no topic')),
      telegram ? telegram(role, msg) : Promise.resolve(0),
      webpush ? webpush(role, msg) : Promise.resolve(0),
    ]);
    if (viaNtfy.status === 'fulfilled' || (viaTg.status === 'fulfilled' && viaTg.value > 0) || (viaApp.status === 'fulfilled' && viaApp.value > 0)) return true;
    throw new Error(viaNtfy.reason?.message || 'not sent');
  };
}

/**
 * Missed-dose reminders (nudges.js) and supplies running low (supplies.js), after each check.
 * They go to the owner only and never block the alerts. Changes `state` in place.
 */
export async function reminders(row, people, state, send, { doses = null, supplies = null, now = Date.now() } = {}) {
  const cfg = { ...NIGHT_DEFAULTS, ...row };
  const sent = [];
  if (!cfg.enabled || !people.length) return sent;
  const many = people.length > 1;
  const say = async (p, title, message, tag, label, es = null) => {
    const pre = many && p ? `${p.firstName || p.name}: ` : '';
    try { await send(cfg.self_topic, { title: `${pre}${title}`, message, priority: 3, tags: [tag], ...(es ? { es: { title: `${pre}${es.title}`, message: es.message } } : {}) }); sent.push({ label, ok: true }); } catch (e) { sent.push({ label, ok: false, error: e.message }); }
  };
  if (cfg.nudge_enabled !== false && doses?.ready) {
    state._nudge = state._nudge || {};
    for (const p of people) {
      const list = await doses.between(p.pid, now - 14 * 24 * 60 * MIN, now + MIN);
      const nudged = state._nudge[p.pid] || {};
      const { nudges, date } = missedDoseNudges({ person: p, doses: list, now, tz: cfg.time_zone, nudged, nightStart: cfg.night_start, nightEnd: cfg.night_end, fmt: (mg) => fmt(p, mg) });
      for (const n of nudges) { await say(p, n.title, n.message, 'memo', 'nudge', n.es); nudged[n.key] = date; }
      for (const k of Object.keys(nudged)) if (nudged[k] !== date) delete nudged[k];
      state._nudge[p.pid] = nudged;
    }
  }
  if (supplies?.ready) {
    const rows = await supplies.list();
    const byPid = new Map();
    for (const r of rows) byPid.set(r.pid, [...(byPid.get(r.pid) || []), r]);
    state._supply = state._supply || {};
    for (const [pid, rs] of byPid) {
      const oldest = Math.min(now - 7 * 24 * 60 * MIN, ...rs.map((r) => Date.parse(r.set_at)));
      const list = doses?.ready ? await doses.between(pid, oldest, now + MIN) : [];
      const statuses = supplyStatus(rs, { doses: list, sensorStarts: (state._sensors || {})[pid] || [], sensorDays: cfg.sensor_days, now, tz: cfg.time_zone });
      const { reminders: due, date } = supplyReminders(statuses, { reminded: state._supply, now, tz: cfg.time_zone });
      const p = people.find((x) => x.pid === pid);
      for (const r of due) { await say(p, r.title, r.message, 'package', 'supplies', r.es); state._supply[r.key] = date; }
    }
    for (const k of Object.keys(state._supply)) if (!rows.some((r) => `${r.pid}:${r.item}` === k)) delete state._supply[k];
  }
  // Sick day: a check every 4 hours while awake, every 2 while above 250 mg/dL. It describes;
  // the sick-day plan is the doctor's.
  if (activeMode(cfg, now) === 'sick') {
    state._sick = state._sick || {};
    const asleep = hourIn(localHour(now, cfg.time_zone), cfg.night_start, cfg.night_end);
    for (const p of asleep ? [] : people) {
      const l = p.latest && now - p.latest.t <= STALE_MS ? p.latest : null;
      const high = Boolean(l && l.mg >= SICK_KETONE_MGDL);
      if (now - (state._sick[p.pid] || 0) < (high ? 2 : 4) * 60 * MIN) continue;
      state._sick[p.pid] = now;
      if (high) {
        await say(p, `Sick day: ${fmt(p, l.mg)}, check ketones`, 'Above 250 mg/dL while sick: a ketone check is due now. Drink fluids and follow your sick-day plan. Call your doctor if ketones are moderate or high, or you cannot keep fluids down.', 'thermometer', 'sick',
          { title: `Día de enfermedad: ${fmt(p, l.mg)}, mide cetonas`, message: 'Por encima de 250 mg/dL estando enfermo: toca medir cetonas ahora. Toma líquidos y sigue tu plan para días de enfermedad. Llama a tu médico si las cetonas están moderadas o altas, o si no puedes retener líquidos.' });
      } else {
        await say(p, `Sick day check${l ? `: ${fmt(p, l.mg)}` : ''}`, 'Time for the 4-hour sick-day check: ketones, fluids, and your sick-day plan.', 'thermometer', 'sick',
          { title: `Revisión de día de enfermedad${l ? `: ${fmt(p, l.mg)}` : ''}`, message: 'Toca la revisión de cada 4 horas: cetonas, líquidos y tu plan para días de enfermedad.' });
      }
    }
  } else if (state._sick) delete state._sick;
  return sent;
}

export async function nightRoute(path, request, url, env, { store, json, keyOk, snapshot, push, telegram = null, webpush = null, doses = null, supplies = null, ring = defaultRing, history = null, now = () => Date.now() }) {
  if (!['night/tick', 'night/setup', 'night/test', 'night/ack', 'night/notify', 'night/echo-test'].includes(path)) return null;
  if (!store.ready) return json({ error: 'not configured' }, 503);
  const sendFor = (row) => {
    const out = alertFanOut(env, row, { push, telegram, webpush });
    return (topic, msg) => out(topic === row.care_topic ? 'family' : 'me', msg);
  };
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
    const result = await nightCheck({ row, people, error, now: now(), push: sendFor(row), ackUrl: (t) => `${ackBase}?t=${t}`, ring });
    if (!error) {
      try { result.sent.push(...await reminders(row, people, result.state, sendFor(row), { doses, supplies, now: now() })); } catch (e) { result.sent.push({ label: 'reminders', ok: false, error: String(e.message || e).slice(0, 120) }); }
    }
    // Keep the history on the server (history.js), and trim it to 90 days once a day.
    if (history?.ready && people.length) {
      await history.save(rowsFromSnapshot(people)).catch(() => {});
      const meta = result.state._meta || {};
      if (!meta.prunedAt || now() - meta.prunedAt > 24 * 60 * MIN) {
        await history.prune(now()).catch(() => {});
        result.state._meta = { ...meta, prunedAt: now() };
      }
    }
    const summary = { at: new Date(now()).toISOString(), people: people.length, sent: result.sent, error: error?.code || null, night: result.night ?? null };
    await store.patch({ state: result.state, last_result: summary });
    return json({ ok: true, people: summary.people, sent: summary.sent.length, error: summary.error });
  }

  // Owner-only below.
  if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
  const row = await store.get();

  if (path === 'night/echo-test') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await request.json().catch(() => ({}));
    const target = body.which === 'soon' ? row.echo_soon_url : row.echo_low_url;
    if (!target) return json({ error: 'no-echo', message: 'Save the trigger link first.' }, 409);
    try { await ring(target); } catch (e) { return json({ error: 'echo-failed', message: `The trigger did not answer (${e.message}).` }, 502); }
    return json({ ok: true });
  }

  if (path === 'night/notify') {
    // A plain message to the owner's phone (ntfy and Telegram): the Sunday summary from su94r Mini.
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
    const message = String(body.message || '').slice(0, 1500);
    if (!title && !message) return json({ error: 'empty' }, 400);
    try { await sendFor(row)(row.self_topic, { title, message, priority: 3, tags: ['bar_chart'] }); } catch (e) { return json({ error: 'push-failed', message: e.message }, 502); }
    return json({ ok: true });
  }

  if (path === 'night/test') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    try {
      await sendFor(row)(row.self_topic, { title: 'su94r test alert', message: 'Night alerts reach this phone. A real low comes with an "I\'m OK" button.', priority: 4, tags: ['test_tube'], es: { title: 'Alerta de prueba de su94r', message: 'Las alertas nocturnas llegan a este teléfono. Una baja real trae un botón "Estoy bien".' } });
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

/** Fires a trigger link (GET); throws when it does not answer OK. */
async function defaultRing(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return true;
}
