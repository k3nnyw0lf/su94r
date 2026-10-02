// Every way health data can reach the vault, as cards on the vault page. Each card says what
// the source measures, what it needs, and (where su94r Mini can do it) has the buttons.
//
// render(ctx) returns extra nodes for the card. ctx: { settings, account, state, send, h,
// saveSetting, refresh, connectDrive, disconnectDrive, when }.

import { getToken, GOOGLE_HOSTS, BUILT_IN_CLIENT_ID, signOutGoogle } from './google.js';
import { HEALTH_SCOPES } from './ghealth.js';
import { parseScreenLink, newInbox, removeInbox, inboxAddress, inboxBase, newAiConnector, aiAddress, removeScreen, newNsLink, nightSetup, nightSave, nightTest, shareNew, shareUrl } from './voice.js';
import qrcode from './vendor/qrcode.mjs';

const store = chrome.storage.local;
const steps = (h, items, open = false) => h('details', open ? { open: true } : {}, h('summary', {}, 'How'), h('ol', {}, items.map((i) => h('li', {}, i))));
const state = (h, text, kind = '') => h('div', { class: `state ${kind}` }, text);

async function setConnector(key, value) {
  const { connectors = {} } = await store.get('connectors');
  if (value == null) delete connectors[key];
  else connectors[key] = { ...(connectors[key] || {}), ...value };
  await store.set({ connectors });
}

/** A button that runs `fn`, shows progress in `msg`, then redraws the cards. */
function action(ctx, msg, label, busy, fn, cls = 'ghost') {
  return ctx.h('button', {
    type: 'button', class: cls,
    onclick: async () => {
      msg.textContent = busy;
      try { const r = await fn(); msg.textContent = r?.ok === false ? r.error || 'Did not work.' : 'Done.'; } catch (e) { msg.textContent = e.message; }
      ctx.refresh();
    },
  }, label);
}

function copyable(h, text) {
  const code = h('code', { class: 'copy' }, text);
  return h('div', { class: 'actions' }, code, h('button', { type: 'button', class: 'ghost', onclick: async (e) => { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } }, 'Copy'));
}

const needServer = (h) => state(h, 'Needs your su94r server: Settings → Alexa and screens → Connect to my su94r server first.', 'warn');

/** One click for Gemini: make the AI address if needed, copy it, open Gemini's Connected Apps.
 *  The note survives the redraw that follows (the card is rebuilt). */
let geminiNote = '';
function geminiButton(ctx, msg, ensureAddress) {
  return ctx.h('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      msg.textContent = 'Getting the address ready…';
      try {
        const address = await ensureAddress();
        let copied = true;
        try { await navigator.clipboard.writeText(address); } catch { copied = false; }
        await chrome.tabs.create({ url: 'https://gemini.google.com/apps' });
        geminiNote = copied
          ? 'Copied. In the Gemini tab, scroll down to Custom apps, click the link box, press Ctrl+V, then Next.'
          : 'Gemini is open. Press Copy below, then in Gemini scroll down to Custom apps, paste it and press Next.';
      } catch (e) { geminiNote = e.message; }
      ctx.refresh();
    },
  }, 'Set up Gemini');
}

/** A QR code (as an image) for a link the phone should open. */
function qrImage(h, text, label) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return h('img', { class: 'qr', src: qr.createDataURL(5, 4), alt: label, title: label, width: String(qr.getModuleCount() * 5 + 40) });
}

/** The share code on screen, if any: { url, role, until }. Kept only in this page. */
let shareShown = null;
let shareTimer = null;

const nightProblem = (code) => (code === 'auth' || code === 'config'
  ? 'the server has no working LibreLinkUp sign-in; open su94r Mini so it reconnects'
  : `could not read LibreLinkUp (${code})`);

export const CONNECTORS = [
  {
    id: 'share',
    icon: '📲',
    name: 'Share to another phone',
    what: 'Show a QR code, scan it with another phone, and that phone links itself: live glucose with every computer off, plus one tap for low alerts and for its watch. Nothing to type. Each code works once, for 10 minutes; linked phones are listed, and removed, in Settings → Alexa and screens.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const msg = h('div', { class: 'state' });
      if (shareShown && Date.now() < shareShown.until) {
        const left = Math.max(1, Math.round((shareShown.until - Date.now()) / 60e3));
        clearTimeout(shareTimer);
        shareTimer = setTimeout(() => ctx.refresh(), shareShown.until - Date.now() + 500);
        return [
          state(h, `Scan this with the ${shareShown.role === 'family' ? 'family member\'s' : 'other'} phone's camera and open the link. It works once, for about ${left} more minute${left === 1 ? '' : 's'}.`, 'on'),
          h('div', { class: 'qr-row' }, qrImage(h, shareShown.url, 'Scan with the other phone')),
          msg,
          h('div', { class: 'actions' }, action(ctx, msg, 'Done', 'Closing…', async () => { shareShown = null; })),
        ];
      }
      shareShown = null;
      const make = (role) => async () => {
        const r = await shareNew(settings.screenLink, role);
        shareShown = { url: shareUrl(settings.screenLink, r.invite), role, until: Date.now() + (r.expiresIn || 600) * 1000 };
      };
      return [
        msg,
        h('div', { class: 'actions' },
          action(ctx, msg, 'My other phone', 'Making a code…', make('me'), 'primary'),
          action(ctx, msg, 'A family member\'s phone', 'Making a code…', make('family'))),
        state(h, 'My other phone gets your own low alerts. A family member\'s phone is told only when a low is not handled, once you switch on "Tell caregivers too" in Low alerts.'),
      ];
    },
  },
  {
    id: 'night',
    icon: '🚨',
    name: 'Low alerts on your phone',
    what: 'Your su94r server checks every 5 minutes, even with every computer off, and pushes a low to your phone through the free ntfy app. It repeats until you tap "I\'m OK" or you are back up: every 20 minutes by day, every 10 at night, every 5 when severe. The Libre app\'s own alarms stay your first line.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const msg = h('div', { class: 'state' });
      let v;
      try { v = await nightSetup(settings.screenLink); } catch (e) { return state(h, `Could not reach your su94r server: ${e.message}`, 'warn'); }
      const last = v.lastResult;
      const status = !v.enabled
        ? state(h, 'Paused: no alerts are sent.', 'warn')
        : last?.error
          ? state(h, `On, but the last check had a problem: ${nightProblem(last.error)}.`, 'warn')
          : state(h, `On. Last check ${last?.at ? ctx.when(last.at) : 'in the next 5 minutes'}. Low below ${v.lowMgdl} mg/dL, severe below ${v.severeMgdl}.${v.openLows ? ' A low is open right now.' : ''}`, 'on');
      const low = h('input', { type: 'number', min: '60', max: '100', value: String(v.lowMgdl), 'aria-label': 'Low level, mg/dL', class: 'num' });
      const severe = h('input', { type: 'number', min: '40', max: '70', value: String(v.severeMgdl), 'aria-label': 'Severe level, mg/dL', class: 'num' });
      return [
        status,
        h('p', { class: 'sub-h' }, 'Your phone'),
        h('div', { class: 'qr-row' },
          qrImage(h, v.selfUrl, 'Scan with your phone to open your alert topic'),
          h('div', {},
            steps(h, [
              'On your phone, install ntfy (free) from the Play Store or App Store.',
              'Scan this code with the phone camera. It opens your private topic; tap Subscribe, or in the ntfy app tap + and paste the topic name below.',
              'In ntfy, allow notifications. For nights, open the topic\'s settings and let it override Do Not Disturb for urgent alerts.',
              'Press "Send a test alert" here.',
            ], true),
            copyable(h, v.selfTopic))),
        msg,
        h('div', { class: 'actions' },
          action(ctx, msg, 'Send a test alert', 'Sending…', () => nightTest(settings.screenLink), 'primary'),
          action(ctx, msg, v.enabled ? 'Pause alerts' : 'Turn alerts on', 'Saving…', () => nightSave(settings.screenLink, { enabled: !v.enabled }))),
        h('details', {},
          h('summary', {}, 'Levels'),
          h('div', { class: 'actions' }, 'Low below ', low, ' severe below ', severe, ' mg/dL ',
            action(ctx, msg, 'Save', 'Saving…', () => nightSave(settings.screenLink, { lowMgdl: Number(low.value), severeMgdl: Number(severe.value) })))),
        h('details', {},
          h('summary', {}, 'Family and caregivers'),
          state(h, 'Anyone you trust can get your alerts too: they install ntfy and subscribe to the care topic. They are told only when a low is not handled (the care ladder: a severe low, or no "I\'m OK" in time at night).'),
          h('div', { class: 'qr-row' }, qrImage(h, v.careUrl, 'Care topic for family'), copyable(h, v.careTopic)),
          h('div', { class: 'actions' }, action(ctx, msg, v.careEnabled ? 'Stop telling caregivers' : 'Tell caregivers too', 'Saving…', () => nightSave(settings.screenLink, { careEnabled: !v.careEnabled })))),
      ];
    },
  },
  {
    id: 'drive',
    icon: '☁️',
    name: 'Google Drive',
    what: 'Keeps a copy of everything (readings, markers, the vault) in a "su94r" folder in your own Drive. Other computers can bring it back.',
    async render(ctx) {
      const { h, account, settings, state: s } = ctx;
      const msg = h('div', { class: 'state' });
      if (!settings.driveBackup || !account) {
        // Google sign-in needs an OAuth client ID once (docs/health-vault.md); a copy of su94r
        // without one built in asks for it here.
        const idInput = h('input', { type: 'text', class: 'grow', placeholder: '…apps.googleusercontent.com', value: settings.googleClientId || '', 'aria-label': 'Google client ID' });
        const needId = !BUILT_IN_CLIENT_ID || settings.googleClientId;
        return [msg,
          needId ? state(h, settings.googleClientId ? 'Using your own Google client ID.' : 'Google sign-in needs a client ID once (how: docs/health-vault.md, "Google").') : null,
          needId ? h('div', { class: 'actions' }, idInput, action(ctx, msg, 'Save client ID', 'Saving…', () => ctx.saveSetting({ googleClientId: idInput.value.trim() }))) : null,
          h('div', { class: 'actions' }, action(ctx, msg, 'Sign in with Google', 'Opening Google…', ctx.connectDrive, 'primary'))];
      }
      const d = s.driveState || {};
      const line = d.error
        ? state(h, `${account.email}: ${d.error}`, 'warn')
        : state(h, d.at ? `Saving as ${account.email}. Last saved ${ctx.when(d.at)}.` : `Signed in as ${account.email}. First save on its way.`, 'on');
      return [line, msg, h('div', { class: 'actions' },
        d.code === 'signin' ? action(ctx, msg, 'Sign in again', 'Opening Google…', ctx.connectDrive, 'primary') : null,
        action(ctx, msg, 'Save now', 'Saving…', () => ctx.send({ type: 'driveSave' })),
        action(ctx, msg, 'Bring back from Drive', 'Bringing it back…', () => ctx.send({ type: 'driveRestore' })),
        action(ctx, msg, 'Stop', 'Signing out…', ctx.disconnectDrive))];
    },
  },
  {
    id: 'googleHealth',
    icon: '⌚',
    name: 'Pixel Watch and Fitbit (Google Health)',
    what: 'Heart rate, steps, workouts, sleep, weight, body fat, fingersticks, water and food from Google Health, read in this browser every 30 minutes.',
    async render(ctx) {
      const { h } = ctx;
      const gh = ctx.state.connectors?.googleHealth;
      const msg = h('div', { class: 'state' });
      const connect = async () => {
        const ok = await chrome.permissions.request({ origins: GOOGLE_HOSTS }).catch(() => false);
        if (!ok) throw new Error('su94r Mini needs permission to reach Google.');
        await getToken(HEALTH_SCOPES, { interactive: true });
        await setConnector('googleHealth', { on: true, error: null });
        return ctx.send({ type: 'healthSync' });
      };
      const how = steps(h, [
        'Link the watch in the Google Health app on your phone (the app that used to be called Fitbit).',
        'Press Connect and allow su94r to read your Google Health data. It only reads; it never writes to Google.',
        'The first read brings the last 30 days. Blood pressure is not in Google Health yet: use the Android phone card for that.',
      ]);
      if (!gh?.on) return [msg, h('div', { class: 'actions' }, action(ctx, msg, 'Connect', 'Opening Google…', connect, 'primary')), how];
      const notLinked = (gh.errors || []).some((e) => /ACCOUNT_NOT_LINKED/.test(e));
      const line = gh.error
        ? state(h, gh.error, 'warn')
        : notLinked
          ? state(h, 'Google says the watch is not linked yet: open the Google Health app on your phone and link it.', 'warn')
          : state(h, gh.at ? `Reading every 30 minutes. Last read ${ctx.when(gh.at)}; ${gh.added || 0} readings so far.` : 'Connected. First read on its way.', 'on');
      // Types Google answered with a problem other than "no data": shown so nothing fails quietly.
      const problems = (gh.errors || []).filter((e) => !/ACCOUNT_NOT_LINKED|DATA_TYPE_NOT_AVAILABLE|NOT_FOUND|: 404/.test(e));
      return [line, problems.length ? state(h, `Not read: ${problems.join('; ')}`, 'warn') : null, msg, h('div', { class: 'actions' },
        gh.code === 'signin' ? action(ctx, msg, 'Sign in again', 'Opening Google…', connect, 'primary') : null,
        action(ctx, msg, 'Read now', 'Reading…', () => ctx.send({ type: 'healthSync' })),
        action(ctx, msg, 'Stop', 'Stopping…', async () => {
          await setConnector('googleHealth', null);
          // Drive uses the same sign-in: keep it unless Drive is off too.
          if (!ctx.settings.driveBackup) await signOutGoogle();
        }))];
    },
  },
  {
    id: 'inbox',
    icon: '📱',
    name: 'Android phone (Health Connect)',
    what: 'Everything on your phone\'s Health Connect: Pixel Watch, Samsung Health, Withings scales and cuffs, Omron, Oura, Garmin, MyFitnessPal and more, including blood pressure.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const box = ctx.state.connectors?.inbox;
      const msg = h('div', { class: 'state' });
      if (!box?.secret || !box.key) {
        const make = async () => {
          const r = await newInbox(settings.screenLink, settings.deviceName ? `${settings.deviceName} phone` : 'Phone');
          await setConnector('inbox', { id: r.id, secret: r.secret, key: r.key, name: r.name, added: 0 });
        };
        return [msg, h('div', { class: 'actions' }, action(ctx, msg, 'Make my phone\'s address', 'Making it…', make, 'primary')),
          state(h, 'Makes a private address on your su94r server for the free HC Webhook app to send to. This computer collects from it every few minutes.')];
      }
      return [
        state(h, box.error ? box.error : box.at ? `Collecting. Last check ${ctx.when(box.at)}; ${box.added || 0} readings so far.` : 'Ready. Put this into HC Webhook:', box.error ? 'warn' : 'on'),
        state(h, 'URL'),
        copyable(h, inboxBase(settings.screenLink)),
        state(h, 'Header: X-Api-Key, with this value'),
        copyable(h, box.secret),
        h('details', {}, h('summary', {}, 'App without headers? One address instead'), copyable(h, inboxAddress(settings.screenLink, box.secret))),
        steps(h, [
          'On the phone, install "HC Webhook" from the Play Store (free, open source).',
          'Open it, allow Health Connect, and add a webhook: the URL above, plus a header named X-Api-Key with the value above.',
          'Choose what to send: steps, heart rate, sleep, exercise, weight, blood pressure, blood glucose, and anything else you like.',
          'Set it to sync every 15 minutes. Apps that share with Health Connect (Samsung Health, Withings, Omron, Oura, Garmin, MyFitnessPal) come along by themselves.',
          'Keep the value private: anyone with it could add readings to your vault, but cannot read anything (only this computer holds the key that reads).',
        ], !box.at),
        msg,
        h('div', { class: 'actions' },
          action(ctx, msg, 'Collect now', 'Collecting…', () => ctx.send({ type: 'healthSync' })),
          action(ctx, msg, 'Remove the address', 'Removing…', async () => {
            // Only forget it here once the server has removed it (or never knew it).
            try { await removeInbox(settings.screenLink, box.id); } catch (e) { if (!/unauthor|not found|401|404/i.test(e.message)) throw new Error(`Not removed: ${e.message}. Try again.`); }
            await setConnector('inbox', null);
          })),
      ];
    },
  },
  {
    id: 'iphone',
    icon: '🍎',
    name: 'iPhone and Apple Watch (Apple Health)',
    what: 'Apple Health sends through the same private address: HC Webhook is on the App Store too, and Health Auto Export works as well.',
    render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const box = ctx.state.connectors?.inbox;
      return [
        state(h, box?.secret ? 'Use the address from the Android phone card.' : 'First press "Make my phone\'s address" on the Android phone card.'),
        steps(h, ['Install HC Webhook (or Health Auto Export) from the App Store.', 'Allow it to read Apple Health, then add a webhook / REST export with the address.', 'Pick what to send and how often.']),
      ];
    },
  },
  {
    id: 'claude',
    icon: '✳️',
    name: 'Claude, Gemini and other AI apps',
    what: 'Let Claude or Google Gemini (on the web, your Pixel or any Android phone) read your live glucose, the last 12 hours and your insulin doses, so you can ask about them. Read-only; ChatGPT developer mode takes the same address.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const ai = ctx.state.connectors?.ai;
      const msg = h('div', { class: 'state' });
      const make = async () => {
        const r = await newAiConnector(settings.screenLink, 'AI apps');
        await setConnector('ai', { id: r.id, token: r.token, at: Date.now() });
        return r.token;
      };
      const address = async () => aiAddress(settings.screenLink, ai?.token || await make());
      const note = geminiNote ? state(h, geminiNote, 'on') : null;
      geminiNote = '';
      if (!ai?.token) {
        return [msg, note, h('div', { class: 'actions' },
          geminiButton(ctx, msg, address),
          action(ctx, msg, 'Make the AI address', 'Making it…', make)),
        state(h, 'On Android, the Claude app (Pro or Max) can also read Health Connect itself: Claude → Settings → Health.')];
      }
      return [
        state(h, 'Ready. Add this address once in each AI app. Keep it private: anyone with it can read your glucose.', 'on'),
        copyable(h, aiAddress(settings.screenLink, ai.token)),
        note,
        h('p', { class: 'sub-h' }, 'Google Gemini (then also on your Pixel and Android phone)'),
        h('div', { class: 'actions' }, geminiButton(ctx, msg, address)),
        steps(h, [
          'Press Set up Gemini: it copies the address and opens gemini.google.com/apps.',
          'Scroll down to Custom apps, paste the address into "Add a custom app link" and press Next.',
          'Ask Gemini on the web, or say "Hey Google" on your phone: "@su94r what is my glucose?" or "How was my sugar overnight?"',
        ], true),
        h('p', { class: 'sub-h' }, 'Claude'),
        steps(h, [
          'In Claude (claude.ai or the app): Settings → Connectors → Add custom connector.',
          'Name it su94r and paste the address. Leave the rest empty.',
          'In a chat, turn su94r on from the tools menu and ask, for example: "How was my glucose overnight?"',
        ], true),
        state(h, 'The AI explains and answers; it is told never to give insulin dosing instructions.'),
        msg,
        h('div', { class: 'actions' }, action(ctx, msg, 'Switch it off', 'Switching off…', async () => {
          if (ai.id) await removeScreen(settings.screenLink, ai.id);
          await setConnector('ai', null);
          return { ok: true };
        })),
      ];
    },
  },
  {
    id: 'widgets',
    icon: '🔲',
    name: 'Watch faces and phone widgets',
    what: 'A private link for apps that read Nightscout (GlucoDataHandler on the Pixel Watch, xDrip+, Juggluco) and for home-screen widgets (KWGT on Android, Scriptable on iPhone).',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const ns = ctx.state.connectors?.ns;
      const msg = h('div', { class: 'state' });
      const base = parseScreenLink(settings.screenLink).base;
      if (!ns?.token) {
        const make = async () => {
          const r = await newNsLink(settings.screenLink, 'Watch and widgets');
          await setConnector('ns', { id: r.id, token: r.token, at: Date.now() });
        };
        return [msg, h('div', { class: 'actions' }, action(ctx, msg, 'Make a link', 'Making it…', make, 'primary'))];
      }
      return [
        state(h, 'Nightscout address and token (GlucoDataHandler → Sources → Nightscout):', 'on'),
        copyable(h, `${base}/ns`),
        copyable(h, ns.token),
        state(h, 'Widget link (KWGT, Scriptable; steps in docs/widgets.md):'),
        copyable(h, `${base}/screen/glance?token=${ns.token}`),
        state(h, 'Anyone with these can see your glucose, nothing else.'),
        msg,
        h('div', { class: 'actions' }, action(ctx, msg, 'Switch it off', 'Switching off…', async () => {
          if (ns.id) await removeScreen(settings.screenLink, ns.id);
          await setConnector('ns', null);
          return { ok: true };
        })),
      ];
    },
  },
  {
    id: 'watchface',
    icon: '⌚',
    name: 'Glucose on your Pixel Watch',
    what: 'Your live glucose as a watch complication: the free GlucoDataHandler app follows your LibreLinkUp account directly.',
    render: ({ h }) => steps(h, [
      'On the phone, install GlucoDataHandler from the Play Store. Under Sources, choose LibreLinkUp and sign in with the follower account you use for su94r.',
      'On the watch, install GlucoDataHandler from the watch\'s Play Store.',
      'Long-press your watch face → Customize → pick a complication slot → GlucoDataHandler.',
    ]),
  },
  {
    id: 'others',
    icon: '🔗',
    name: 'Withings, Samsung, Omron, Oura, Garmin, MyFitnessPal…',
    what: 'These apps share with Health Connect on Android (and Apple Health on iPhone). Turn sharing on in each app, and the phone card above brings them in.',
    render: ({ h }) => state(h, 'Fitbit\'s old API ends on October 30, 2026; su94r reads Fitbit and Pixel Watch through Google Health instead.'),
  },
  {
    id: 'manual',
    icon: '✍️',
    name: 'By hand',
    what: 'Weight, blood pressure, fingersticks, ketones, A1c, temperature, sleep, water: the form below.',
    render: ({ h }) => state(h, 'Ready', 'on'),
  },
  {
    id: 'file',
    icon: '📄',
    name: 'Files',
    what: 'CSV, HC Webhook, Health Auto Export, Health Connect exports and su94r Drive files.',
    render: ({ h }) => state(h, 'Ready: "Import a file" below', 'on'),
  },
];
