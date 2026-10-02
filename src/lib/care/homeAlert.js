// ═══════════════════════════════════════════════════════════════════════════
// Home device alerts — lights, speakers, sirens, TVs.
//
// WHY THIS IS THE STRONGEST RUNG, NOT A GIMMICK
//
// escalation.js documents the hard limit: a web app cannot make a phone sound
// through silent mode or Do Not Disturb. That is the weak link in the whole
// nocturnal safety net.
//
// A light coming on at full brightness and a speaker saying the words out loud
// does not care about Do Not Disturb. For waking a sleeping person it beats any
// notification this app can send.
//
// TWO ZONES, BECAUSE THE POINT IS TO REACH ANOTHER ROOM
//
// Someone in a severe hypo may be unable to help themselves — that is what
// makes it severe. Alerting only their bedroom solves nothing. The alert has to
// reach whoever else is in the house and tell them to GO TO that person.
//
//   patient  — the room of the person who is low. Woken gently first.
//   helpers  — every other room: a child's room, a partner's room, the hallway.
//              Only used once the situation warrants someone getting up.
//
// The two zones get different words. The patient hears "treat with fast sugar".
// A helper hears "go to Sam now" — being woken without being told what to do
// wastes the seconds this exists to buy.
//
// ONE INTEGRATION, NOT SIX
//
// su94r talks to Home Assistant only. HA already speaks Alexa, Google/Nest,
// Hue, Shelly, Chromecast, TVs and sirens, so integrating each vendor here
// would be re-implementing HA badly. The token lives in the Worker, never the
// browser.
//
// NETWORK REALITY: su94r runs in the cloud and cannot reach a home LAN. HA must
// be reachable from the internet — a free Cloudflare Tunnel is the clean route.
// ═══════════════════════════════════════════════════════════════════════════

import { RUNG } from './escalation.js';
import { localHour, resolveTimeZone } from '../util/localDay.js';

export const HOME_ACTION = {
  LIGHT_SOFT: 'light-soft',
  LIGHT_FULL: 'light-full',
  SPEAK: 'speak',
  SIREN: 'siren',
  TV_ON: 'tv-on',
};

export const ZONE = { PATIENT: 'patient', HELPERS: 'helpers' };

/**
 * Actions per rung, per zone.
 *
 * The patient's room escalates gently — someone half-woken by a lamp usually
 * surfaces, and a siren for every 68 mg/dL trains people to disable this.
 * Helper rooms are not touched at all until the situation needs another person,
 * then they go straight to loud, because a helper who sleeps through it is no
 * helper.
 */
export const DEFAULT_RUNG_ACTIONS = {
  [RUNG.SELF]: {
    patient: [HOME_ACTION.LIGHT_SOFT],
    helpers: [],
  },
  [RUNG.CARE_PUSH]: {
    patient: [HOME_ACTION.LIGHT_FULL, HOME_ACTION.SPEAK],
    helpers: [HOME_ACTION.LIGHT_FULL, HOME_ACTION.SPEAK],
  },
  [RUNG.CARE_SMS]: {
    patient: [HOME_ACTION.LIGHT_FULL, HOME_ACTION.SPEAK],
    helpers: [HOME_ACTION.LIGHT_FULL, HOME_ACTION.SPEAK, HOME_ACTION.SIREN],
  },
  [RUNG.CARE_CALL]: {
    patient: [HOME_ACTION.LIGHT_FULL, HOME_ACTION.SPEAK],
    helpers: [HOME_ACTION.LIGHT_FULL, HOME_ACTION.SPEAK, HOME_ACTION.SIREN, HOME_ACTION.TV_ON],
  },
};

/**
 * @typedef {object} ZoneDevices
 * @property {string[]} [lights]    entity_ids
 * @property {string[]} [speakers]  media_player entity_ids
 * @property {string[]} [sirens]    switch/siren entity_ids
 * @property {string[]} [tvs]       media_player entity_ids
 *
 * @typedef {object} HomeConfig
 * @property {ZoneDevices} [patient]
 * @property {ZoneDevices} [helpers]
 * @property {string} [patientName]
 * @property {string} [ttsService]  Default 'tts.google_translate_say'.
 * @property {boolean} [nightOnly]  Default true.
 */

const svc = (domain, service, data) => ({
  path: `/api/services/${domain}/${service}`,
  body: data,
});

/**
 * Decides which home actions to run, per zone. Pure — delivery happens in the
 * Worker, because the Home Assistant token must never reach the browser.
 */
export function planHomeAlert(decision, config = {}, opts = {}) {
  const {
    patient = {}, helpers = {},
    patientName = '',
    ttsService = 'tts.google_translate_say',
    nightOnly = true,
    rungActions = DEFAULT_RUNG_ACTIONS,
  } = config;
  const { now = Date.now(), timeZone = resolveTimeZone() } = opts;

  const none = { actions: [], calls: [], zones: [], skipped: null };
  if (!decision || decision.rung === RUNG.NONE) return none;

  // Waking a household during the day, for a low the user is awake to treat, is
  // the fastest way to get this switched off.
  const hour = localHour(now, timeZone);
  const isNight = hour >= 22 || hour < 8;
  if (nightOnly && !isNight && !decision.severe) {
    return { ...none, skipped: 'daytime and not severe' };
  }

  const perZone = rungActions[decision.rung] || { patient: [], helpers: [] };
  const calls = [];
  const actions = [];
  const zonesUsed = new Set();

  for (const [zone, devices] of [[ZONE.PATIENT, patient], [ZONE.HELPERS, helpers]]) {
    const wanted = perZone[zone] || [];
    if (!wanted.length) continue;

    const { lights = [], speakers = [], sirens = [], tvs = [] } = devices;

    for (const action of wanted) {
      switch (action) {
        case HOME_ACTION.LIGHT_SOFT:
          if (!lights.length) break;
          calls.push(svc('light', 'turn_on', { entity_id: lights, brightness_pct: 30 }));
          actions.push(`${zone}:${action}`);
          zonesUsed.add(zone);
          break;

        case HOME_ACTION.LIGHT_FULL:
          if (!lights.length) break;
          calls.push(svc('light', 'turn_on', {
            entity_id: lights,
            brightness_pct: 100,
            // Red is unmistakable half-asleep. Lights without colour support
            // ignore the extra field harmlessly.
            rgb_color: [255, 40, 40],
          }));
          actions.push(`${zone}:${action}`);
          zonesUsed.add(zone);
          break;

        case HOME_ACTION.SPEAK: {
          if (!speakers.length) break;
          const [domain, service] = ttsService.split('.');
          calls.push(svc(domain, service, {
            entity_id: speakers,
            message: spokenMessage(decision, zone, patientName),
          }));
          actions.push(`${zone}:${action}`);
          zonesUsed.add(zone);
          break;
        }

        case HOME_ACTION.SIREN:
          if (!sirens.length) break;
          calls.push(svc('homeassistant', 'turn_on', { entity_id: sirens }));
          actions.push(`${zone}:${action}`);
          zonesUsed.add(zone);
          break;

        case HOME_ACTION.TV_ON:
          if (!tvs.length) break;
          calls.push(svc('media_player', 'turn_on', { entity_id: tvs }));
          actions.push(`${zone}:${action}`);
          zonesUsed.add(zone);
          break;

        default:
          break;
      }
    }
  }

  return {
    actions,
    calls,
    zones: [...zonesUsed],
    skipped: actions.length ? null : 'no matching devices configured',
  };
}

/**
 * Words a half-asleep person can act on. Short, concrete, repeated once, and
 * different per zone — the patient needs to treat, a helper needs to MOVE.
 * No numbers, no trend arrows: nobody parses "68 and falling" at 3am.
 */
export function spokenMessage(decision, zone = ZONE.PATIENT, patientName = '') {
  const severity = decision.severe ? 'very low' : 'low';

  if (zone === ZONE.HELPERS) {
    const who = patientName || 'the person with diabetes';
    const Who = who.charAt(0).toUpperCase() + who.slice(1);
    const line = decision.dataGap
      ? `${Who}'s glucose sensor has stopped working after a low. Go to ${patientName || 'them'} now.`
      : `${Who}'s blood sugar is ${severity} and they have not responded. Go to ${patientName || 'them'} now.`;
    return `${line} ${line}`;
  }

  const line = decision.dataGap
    ? 'Your glucose sensor has stopped reporting after a low. Please check now.'
    : `Your blood sugar is ${severity}. Treat now with fast sugar.`;
  return `${line} ${line}`;
}

/** Turns the disruptive things off once the episode resolves. */
export function planHomeStandDown(config = {}) {
  const { patient = {}, helpers = {} } = config;
  const calls = [];

  for (const devices of [patient, helpers]) {
    const { sirens = [], tvs = [] } = devices;
    if (sirens.length) calls.push(svc('homeassistant', 'turn_off', { entity_id: sirens }));
    if (tvs.length) calls.push(svc('media_player', 'turn_off', { entity_id: tvs }));
  }

  // Lights stay ON deliberately. Someone is up treating a hypo, possibly
  // helping another person, and killing the lights on them is hostile.
  return { calls, note: 'Lights left on deliberately — someone is likely up dealing with a low.' };
}

export const HOME_ALERT_NOTE =
  'Home devices are the most reliable way to wake someone, because a lamp and a ' +
  'speaker ignore Do Not Disturb entirely. Configure two zones: the room of the ' +
  'person with diabetes, and every other bedroom. Helper rooms are only alerted ' +
  'once someone actually needs to get up, and they are told to go to that ' +
  'person rather than just woken. su94r integrates with Home Assistant only — ' +
  'it already speaks Alexa, Nest, Hue, Chromecast and sirens.';
