// Do the low alerts reach anyone? The night check pushes through ntfy, Telegram and the phone app,
// but a push to a topic nobody follows, or to no linked phone, goes nowhere and nothing says so.
// This keeps count of what could ring, and proves it with a drill:
//
//   - coverage: phones with app alerts on and Telegram chats, per role, and which channels
//     answered a drill in the last 30 days (ntfy cannot tell who follows a topic);
//   - drill: one test alert per channel and role, each with its own "I'm OK"; tapping it records
//     that this channel reached someone (night/ack, the Telegram button and the app all answer it);
//   - morning: after the night hours, the lows of the night and whether anyone answered them,
//     for su94r Mini and the phone app to show, and pushed once.
//
// Columns su94r_night.drill and .morning (migration 20261004a_su94r_reach.sql).

import { sha256, randomToken } from './screens.js';

const MIN = 60e3, DAY = 864e5;
const FRESH_MS = 30 * DAY;
const CHANNELS = ['ntfy', 'telegram', 'push'];

/** What could ring, per role, and the state: 'none', 'untested' or 'ok' (owner only decides). */
export function coverageOf(row, { pushes = { me: 0, family: 0 }, chats = { me: 0, family: 0 }, now = Date.now() } = {}) {
  const got = row?.drill?.got || {};
  const fresh = (k) => got[k] && now - got[k] < FRESH_MS;
  const role = (r) => ({
    phones: pushes[r] || 0, telegram: chats[r] || 0,
    confirmed: CHANNELS.filter((c) => fresh(`${r}.${c}`)),
  });
  const me = role('me'), family = role('family');
  const configured = me.phones + me.telegram;
  const state = me.confirmed.length ? 'ok' : configured ? 'untested' : 'none';
  return { state, me, family, lastDrill: row?.drill?.at || null, echo: Boolean(row?.echo_low_url) };
}

/** The drill alert for one channel; `url` is its own "I'm OK" address. */
function drillMessage(url, role) {
  const family = role === 'family';
  return {
    title: family ? 'su94r alert drill (family)' : 'su94r alert drill',
    message: family ? 'A test of the family low alerts. Tap "I\'m OK" so su94r knows this one reached you.' : 'A test of your low alerts. Tap "I\'m OK" so su94r knows this one reached you.',
    priority: 4, tags: ['test_tube'],
    actions: [{ action: 'http', label: "I'm OK", url, method: 'POST', clear: true }],
    es: {
      title: family ? 'Simulacro de alerta de su94r (familia)' : 'Simulacro de alerta de su94r',
      message: family ? 'Una prueba de las alertas de baja para la familia. Toca "Estoy bien" para que su94r sepa que esta te llegó.' : 'Una prueba de tus alertas de baja. Toca "Estoy bien" para que su94r sepa que esta te llegó.',
    },
  };
}

/**
 * Sends the drill: one alert per channel and role, each with its own answer. Returns the new
 * drill column: { id, at, sent: { 'me.ntfy': true, 'me.push': 2, … }, hashes, got }.
 *   send: { ntfy(topic, msg), telegram(role, msg) → count, push(role, msg) → count }
 */
export async function runDrill(row, { send, ackBase, now = Date.now(), family = true }) {
  const roles = family && row.care_topic ? ['me', 'family'] : ['me'];
  const hashes = {}, sent = {};
  for (const r of roles) {
    for (const c of CHANNELS) {
      const token = randomToken(16);
      const msg = drillMessage(`${ackBase}?t=${token}`, r);
      let ok = false;
      try {
        if (c === 'ntfy') ok = Boolean(await send.ntfy(r === 'family' ? row.care_topic : row.self_topic, msg));
        else ok = await send[c](r, msg);
      } catch { ok = false; }
      if (ok) { hashes[`${r}.${c}`] = await sha256(token); sent[`${r}.${c}`] = ok; }
    }
  }
  return { id: randomToken(6), at: now, sent, hashes, got: { ...(row.drill?.got || {}) } };
}

/** A drill answer: the new drill column and which channel it was, or null when it is not one. */
export async function drillAnswer(row, token, now = Date.now()) {
  if (!/^[0-9a-f]{32}$/.test(String(token || '')) || !row?.drill?.hashes) return null;
  const hash = await sha256(token);
  const key = Object.keys(row.drill.hashes).find((k) => row.drill.hashes[k] === hash);
  if (!key) return null;
  const hashes = { ...row.drill.hashes };
  delete hashes[key];
  return { drill: { ...row.drill, hashes, got: { ...(row.drill.got || {}), [key]: now } }, via: key };
}

const WORDS = {
  'me.ntfy': ['ntfy', 'ntfy'], 'me.telegram': ['Telegram', 'Telegram'], 'me.push': ['the su94r app', 'la app su94r'],
  'family.ntfy': ['family ntfy', 'ntfy de la familia'], 'family.telegram': ['family Telegram', 'Telegram de la familia'], 'family.push': ['a family phone', 'un teléfono de la familia'],
};
export const channelWord = (key, lang = 'en') => (WORDS[key] || [key, key])[lang === 'es' ? 1 : 0];

/**
 * An episode that ended goes in the log (state._log, two weeks): when, how low, and whether
 * anyone answered. Changes `state` in place.
 */
export function logEpisode(state, pid, ep, end) {
  if (!ep?.notified) return;
  state._log = (state._log || []).filter((x) => end - x.end < 14 * DAY);
  state._log.push({ pid, since: ep.since, end, lowest: ep.lowest ?? ep.lastMg ?? null, lowestAt: ep.lowestAt ?? null, alerts: ep.count || 0, answered: Boolean(ep.ackAt), name: ep.name || '' });
}

/**
 * After the night hours: last night's lows and whether anyone answered, once per night. Returns
 * { report, msg } (msg null when there were no lows), or null when it is not time or done.
 *   nightEndAt: when the night ended (today's night_end hour, local).
 */
export function morningReport(state, row, { now = Date.now(), nightStartAt, nightEndAt, fmt = (mg) => `${mg} mg/dL`, clock = (t) => new Date(t).toISOString().slice(11, 16), day }) {
  if (now < nightEndAt || row?.morning?.for === day) return null;
  const lows = (state._log || []).filter((x) => x.since >= nightStartAt - 6 * 60 * MIN && x.since < nightEndAt);
  const open = Object.entries(state).filter(([k, ep]) => !k.startsWith('_') && ep?.notified && ep.since < nightEndAt)
    .map(([pid, ep]) => ({ pid, since: ep.since, end: null, lowest: ep.lowest ?? ep.lastMg ?? null, lowestAt: ep.lowestAt ?? null, alerts: ep.count || 0, answered: Boolean(ep.ackAt), name: ep.name || '' }));
  const all = [...lows, ...open].sort((a, b) => a.since - b.since);
  const unanswered = all.filter((x) => !x.answered);
  const report = { for: day, at: now, lows: all, unanswered: unanswered.length };
  if (!all.length) return { report, msg: null };
  const low = all.reduce((a, b) => ((b.lowest ?? 999) < (a.lowest ?? 999) ? b : a));
  const lowest = low.lowest != null ? `${fmt(low.lowest)}${low.lowestAt ? ` at ${clock(low.lowestAt)}` : ''}` : '';
  const lowestEs = low.lowest != null ? `${fmt(low.lowest)}${low.lowestAt ? ` a las ${clock(low.lowestAt)}` : ''}` : '';
  const n = all.length;
  const msg = unanswered.length
    ? {
      title: `Last night: ${n} ${n === 1 ? 'low' : 'lows'}, ${unanswered.length === n ? (n === 1 ? 'not answered' : 'none answered') : `${unanswered.length} not answered`}`,
      message: `Lowest ${lowest}. ${unanswered.length === n ? 'Nobody tapped "I\'m OK".' : `${unanswered.length} of them got no "I'm OK".`} Check that your phone rings for su94r alerts at night (run an alert drill).`,
      priority: 4, tags: ['warning'],
      es: {
        title: `Anoche: ${n} ${n === 1 ? 'baja' : 'bajas'}, ${unanswered.length === n ? 'ninguna respondida' : `${unanswered.length} sin responder`}`,
        message: `La más baja: ${lowestEs}. ${unanswered.length === n ? 'Nadie tocó "Estoy bien".' : `${unanswered.length} no recibieron "Estoy bien".`} Revisa que tu teléfono suene con las alertas de su94r de noche (haz un simulacro).`,
      },
    }
    : {
      title: `Last night: ${n} ${n === 1 ? 'low' : 'lows'}, all answered`, message: `Lowest ${lowest}.`, priority: 3, tags: ['white_check_mark'],
      es: { title: `Anoche: ${n} ${n === 1 ? 'baja' : 'bajas'}, todas respondidas`, message: `La más baja: ${lowestEs}.` },
    };
  return { report, msg };
}
