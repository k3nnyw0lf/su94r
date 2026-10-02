// Every way health data can reach the vault, as cards on the vault page. Each card says what
// the source measures, what it needs, and (where su94r Mini can do it) has the buttons.
//
// render(ctx) returns extra nodes for the card. ctx: { settings, account, state, send, h,
// saveSetting, refresh, connectDrive, disconnectDrive, when }.

import { getToken, GOOGLE_HOSTS, BUILT_IN_CLIENT_ID, signOutGoogle } from './google.js';
import { HEALTH_SCOPES } from './ghealth.js';
import { parseScreenLink, newInbox, removeInbox, inboxAddress, inboxBase, newAiConnector, aiAddress, removeScreen, newNsLink, nightSetup, nightSave, nightTest, nightEchoTest, shareNew, shareUrl, allowLogging, doctorNew, doctorUrl, listScreens, tgStatus, tgConfig, tgLink, tgRemove, tgEnabled, tgTest } from './voice.js';
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
      // On success the cards are redrawn; on a failure they are not, so the reason stays readable.
      try {
        const r = await fn();
        if (r?.ok === false) { msg.textContent = r.message || r.error || 'Did not work.'; return; }
        msg.textContent = 'Done.';
      } catch (e) { msg.textContent = e.message; return; }
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

/** The share code on screen, if any: { url, role, canLog, until }. Kept only in this page. */
let shareShown = null;
/** "Lives with me" ticked for the next family code. */
let shareCanLog = false;
let shareTimer = null;
/** The doctor link just made, if any: { url, name, expiresAt }. Shown once; kept only in this page. */
let doctorShown = null;
/** The Telegram link on screen, if any: { url, role, until }. */
let tgShown = null;

const openTab = (url) => chrome.tabs.create({ url });

const nightProblem = (code) => (code === 'auth' || code === 'config'
  ? 'the server has no working LibreLinkUp sign-in; open su94r Mini so it reconnects'
  : `could not read LibreLinkUp (${code})`);

export const CONNECTORS = [
  {
    id: 'share',
    icon: '📲',
    name: 'Share to another phone',
    what: 'Show a QR code, scan it with another phone, and that phone links itself and gets the su94r app: live glucose and history with every computer off, logging with a double-dose check, the 14-day report, and one tap for low alerts and for its watch. Nothing to type. Each code works once, for 10 minutes; linked phones are listed, and removed, in Settings → Alexa and screens.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const msg = h('div', { class: 'state' });
      if (shareShown && Date.now() < shareShown.until) {
        const left = Math.max(1, Math.round((shareShown.until - Date.now()) / 60e3));
        clearTimeout(shareTimer);
        shareTimer = setTimeout(() => ctx.refresh(), shareShown.until - Date.now() + 500);
        return [
          state(h, `Scan this with the ${shareShown.role === 'family' ? 'family member\'s' : 'other'} phone's camera and open the link. It works once, for about ${left} more minute${left === 1 ? '' : 's'}.${shareShown.role === 'family' ? (shareShown.canLog ? ' That phone will be able to log doses and meals.' : ' That phone will read only.') : ''}`, 'on'),
          h('div', { class: 'qr-row' }, qrImage(h, shareShown.url, 'Scan with the other phone')),
          msg,
          h('div', { class: 'actions' }, action(ctx, msg, 'Done', 'Closing…', async () => { shareShown = null; })),
        ];
      }
      shareShown = null;
      const make = (role) => async () => {
        const canLog = role === 'family' && shareCanLog;
        const r = await shareNew(settings.screenLink, role, undefined, canLog);
        shareShown = { url: shareUrl(settings.screenLink, r.invite), role, canLog: Boolean(r.canLog), until: Date.now() + (r.expiresIn || 600) * 1000 };
      };
      const tick = h('input', { type: 'checkbox', id: 'share-can-log', onchange: (e) => { shareCanLog = e.target.checked; } });
      tick.checked = shareCanLog;
      const out = [
        msg,
        h('div', { class: 'actions' },
          action(ctx, msg, 'My other phone', 'Making a code…', make('me'), 'primary'),
          action(ctx, msg, 'A family member\'s phone', 'Making a code…', make('family'))),
        h('label', { class: 'check', for: 'share-can-log' }, tick, ' They live with me: the family phone can log doses and meals too'),
        state(h, 'My other phone gets your own low alerts and logs. A family member\'s phone reads, and logs only if you allow it; it is told about lows only when one is not handled, once you switch on "Tell caregivers too" in Low alerts.'),
      ];
      // Phones already linked: who may log, and Remove.
      let phones = [];
      try { phones = ((await listScreens(settings.screenLink)).screens || []).filter((s) => s.kind === 'screen' && s.role); } catch { /* the list is optional */ }
      if (phones.length) {
        out.push(h('div', { class: 'state' }, 'Linked phones'), h('ul', { class: 'chats' }, phones.map((s) => h('li', {},
          h('span', {}, `${s.name || 'Phone'} · ${s.role === 'family' ? (s.can_log ? 'family, can log' : 'family, reads only') : 'your phone, logs'} `),
          s.role === 'family'
            ? action(ctx, msg, s.can_log ? 'Stop logging' : 'Allow logging', 'Saving…', () => allowLogging(settings.screenLink, s.id, !s.can_log))
            : null,
          action(ctx, msg, 'Remove', 'Removing…', () => removeScreen(settings.screenLink, s.id))))));
      }
      return out;
    },
  },
  {
    id: 'doctor',
    icon: '🩺',
    name: 'Live link for my doctor',
    what: 'One private link for your doctor or nurse: it always shows your latest 14-day glucose report (time in ranges, GMI, variability, the daily pattern, logged insulin), straight from your su94r server, with every computer off. Read-only: it never shows the live glucose. It ends by itself after 30 days, or at once when you remove it.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const msg = h('div', { class: 'state' });
      const out = [];
      if (doctorShown) {
        const { url, name, expiresAt } = doctorShown;
        const ends = new Date(expiresAt).toLocaleDateString([], { dateStyle: 'medium' });
        const mail = `mailto:?subject=${encodeURIComponent('My glucose report')}&body=${encodeURIComponent(`Here is a live link to my glucose report (always the latest 14 days). It works until ${ends}:\n\n${url}\n`)}`;
        out.push(
          state(h, `Link for ${name} is ready. Copy it now: for your privacy su94r keeps only a fingerprint of it and cannot show it again. It works until ${ends}.`, 'on'),
          copyable(h, url),
          h('div', { class: 'qr-row' }, qrImage(h, url, 'Scan to open the report')),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'ghost', onclick: () => openTab(url) }, 'Open it'),
            h('button', { type: 'button', class: 'ghost', onclick: () => openTab(mail) }, 'Email it'),
            action(ctx, msg, 'Done', 'Closing…', async () => { doctorShown = null; })),
        );
      } else {
        const who = h('input', { type: 'text', placeholder: 'Dr. Lee', 'aria-label': 'Who the link is for', class: 'grow', maxlength: '40' });
        const days = h('select', { 'aria-label': 'How long the link works' },
          h('option', { value: '7' }, '1 week'), h('option', { value: '30', selected: true }, '30 days'), h('option', { value: '90' }, '90 days'));
        out.push(
          h('div', { class: 'actions' }, who, days,
            action(ctx, msg, 'Make the link', 'Making the link…', async () => {
              const name = who.value.trim() || 'Doctor';
              const r = await doctorNew(settings.screenLink, name, Number(days.value));
              if (!r.ok) return r;
              doctorShown = { url: doctorUrl(settings.screenLink, r.token), name, expiresAt: r.expiresAt };
            }, 'primary')),
        );
      }
      out.push(msg);
      // The links already made: who for, when they end, and Remove.
      let links = [];
      try { links = ((await listScreens(settings.screenLink)).screens || []).filter((s) => s.kind === 'doctor' && Date.parse(s.expires_at) > Date.now()); } catch { /* the list is optional */ }
      if (links.length) {
        out.push(h('ul', { class: 'chats' }, links.map((s) => h('li', {},
          h('span', {}, `${s.name || 'Doctor'} · ends ${new Date(s.expires_at).toLocaleDateString([], { dateStyle: 'medium' })}`),
          action(ctx, msg, 'Remove', 'Removing…', () => removeScreen(settings.screenLink, s.id))))));
      }
      out.push(state(h, 'The report is built from the readings your su94r server keeps (up to 90 days). It fills in over the first two weeks.'));
      return out;
    },
  },
  {
    id: 'telegram',
    icon: '✈️',
    name: 'Low alerts on Telegram',
    what: 'The same low alerts in Telegram, with an "I\'m OK" button, and /sugar for the glucose now. A chat links itself when you tap its link and press Start in Telegram. It uses one bot of your own, made once with @BotFather.',
    async render(ctx) {
      const { h, settings } = ctx;
      if (!parseScreenLink(settings.screenLink)) return needServer(h);
      const msg = h('div', { class: 'state' });
      let s;
      try { s = await tgStatus(settings.screenLink); } catch (e) { return state(h, `Could not reach your su94r server: ${e.message}`, 'warn'); }
      if (!s.configured) {
        const field = h('input', { type: 'password', placeholder: '123456789:AAE…', 'aria-label': 'Bot token from BotFather', class: 'grow', autocomplete: 'off', spellcheck: 'false' });
        return [
          steps(h, [
            'Press Open BotFather. In Telegram send /newbot, give it a name (for example "su94r alerts") and a username that ends in "bot".',
            'BotFather answers with a token: numbers, a colon, then letters. Copy it.',
            'Paste it below and press Save. It goes only to your su94r server, which checks it with Telegram and points the bot at itself.',
          ], true),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => openTab('https://t.me/BotFather') }, 'Open BotFather')),
          h('div', { class: 'actions' }, field,
            action(ctx, msg, 'Save', 'Checking with Telegram…', async () => { const r = await tgConfig(settings.screenLink, field.value.trim()); field.value = ''; return r; }, 'primary')),
          msg,
        ];
      }
      const out = [state(h, s.enabled
        ? `Bot ${s.bot} is ready. ${s.chats.length ? `${s.chats.length} chat${s.chats.length === 1 ? '' : 's'} linked.` : 'No chat linked yet.'}`
        : `Bot ${s.bot} is paused: no Telegram alerts are sent.`, s.enabled ? 'on' : 'warn')];
      if (tgShown && Date.now() < tgShown.until) {
        out.push(
          state(h, `Tap Open in Telegram (or scan with the ${tgShown.role === 'family' ? 'family member\'s' : 'phone\'s'} camera), then press Start in Telegram. The link works once, for 15 minutes.`),
          h('div', { class: 'qr-row' }, qrImage(h, tgShown.url, 'Scan to open the su94r bot in Telegram'),
            h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'primary', onclick: () => openTab(tgShown.url) }, 'Open in Telegram'),
              action(ctx, msg, 'I pressed Start', 'Checking…', async () => { tgShown = null; }))),
        );
      } else {
        tgShown = null;
        const make = (role) => async () => {
          const r = await tgLink(settings.screenLink, role);
          tgShown = { url: r.url, role, until: Date.now() + (r.expiresIn || 900) * 1000 };
        };
        out.push(h('div', { class: 'actions' },
          action(ctx, msg, 'Link my Telegram', 'Making a link…', make('me'), 'primary'),
          action(ctx, msg, 'Link a family member\'s Telegram', 'Making a link…', make('family'))));
      }
      if (s.chats.length) {
        out.push(h('ul', { class: 'chats' }, s.chats.map((c) => h('li', {},
          `${c.name || 'Telegram'} (${c.role === 'family' ? 'family' : 'you'}) `,
          action(ctx, msg, 'Remove', 'Removing…', () => tgRemove(settings.screenLink, c.id))))));
      }
      out.push(msg, h('div', { class: 'actions' },
        action(ctx, msg, 'Send a test message', 'Sending…', () => tgTest(settings.screenLink)),
        action(ctx, msg, s.enabled ? 'Pause Telegram alerts' : 'Turn Telegram alerts on', 'Saving…', () => tgEnabled(settings.screenLink, !s.enabled))));
      return out;
    },
  },
  {
    id: 'night',
    icon: '🚨',
    name: 'Low alerts on your phone',
    what: 'Your su94r server checks every 5 minutes, even with every computer off, and pushes a low to your phone: in the su94r phone app (More → Low alerts in this app), through the free ntfy app, or Telegram. It repeats until you tap "I\'m OK" or you are back up: every 20 minutes by day, every 10 at night, every 5 when severe. It also warns before a low ("Low soon"), when readings stop, and the day before a sensor ends. The Libre app\'s own alarms stay your first line.',
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
          h('summary', {}, 'Levels and warnings'),
          h('div', { class: 'actions' }, 'Low below ', low, ' severe below ', severe, ' mg/dL ',
            action(ctx, msg, 'Save', 'Saving…', () => nightSave(settings.screenLink, { lowMgdl: Number(low.value), severeMgdl: Number(severe.value) }))),
          state(h, `Low soon: ${v.soonEnabled ? 'on' : 'off'} (a warning when you are falling toward the low line within 20 minutes). Sensor and signal: ${v.watchEnabled ? 'on' : 'off'} (no readings for 30 minutes; a sensor ending within a day, counted as ${v.sensorDays}-day sensors).`),
          h('div', { class: 'actions' },
            action(ctx, msg, v.soonEnabled ? 'Turn off Low soon' : 'Turn on Low soon', 'Saving…', () => nightSave(settings.screenLink, { soonEnabled: !v.soonEnabled })),
            action(ctx, msg, v.watchEnabled ? 'Turn off sensor and signal' : 'Turn on sensor and signal', 'Saving…', () => nightSave(settings.screenLink, { watchEnabled: !v.watchEnabled })),
            action(ctx, msg, v.sensorDays === 15 ? 'My sensors last 14 days' : 'My sensors last 15 days', 'Saving…', () => nightSave(settings.screenLink, { sensorDays: v.sensorDays === 15 ? 14 : 15 })))),
        (() => {
          const lowLink = h('input', { type: 'password', class: 'grow', autocomplete: 'off', placeholder: 'https://www.virtualsmarthome.xyz/url_routine_trigger/…', 'aria-label': 'Trigger link for lows' });
          const soonLink = h('input', { type: 'password', class: 'grow', autocomplete: 'off', placeholder: 'optional: a second trigger for Low soon', 'aria-label': 'Trigger link for Low soon' });
          return h('details', {},
            h('summary', {}, 'Echo says it out loud'),
            state(h, `At night (and for a severe low at any hour) your Echo announces it in the room, again with every reminder. ${v.echoLow ? 'Low trigger: saved.' : 'No trigger saved yet.'}${v.echoSoon ? ' Low-soon trigger: saved.' : ''}${v.echoAlways ? ' Announces at any hour.' : ''}`, v.echoLow ? 'on' : ''),
            steps(h, [
              'In the Alexa app, enable the "Virtual Smart Home" skill and link your Amazon account (check its price on virtualsmarthome.xyz first; it also sells paid plans).',
              'On virtualsmarthome.xyz → URL Routine Trigger, create a trigger named "su94r low" and copy its trigger link.',
              'In the Alexa app: Routines → + → When: Smart Home → "su94r low" → Add action: Alexa Says → Announcement, for example "Glucose is low. Check now." → From: your bedroom Echo. Save.',
              'Paste the link below and press Save, then Test. (Optional: a second trigger and routine for "Low soon".)',
            ]),
            h('div', { class: 'actions' }, lowLink), h('div', { class: 'actions' }, soonLink),
            h('div', { class: 'actions' },
              action(ctx, msg, 'Save', 'Saving…', async () => {
                const patch = {};
                if (lowLink.value.trim()) patch.echoLowUrl = lowLink.value.trim();
                if (soonLink.value.trim()) patch.echoSoonUrl = soonLink.value.trim();
                if (!Object.keys(patch).length) return { ok: false, message: 'Paste a trigger link first.' };
                const r = await nightSave(settings.screenLink, patch);
                lowLink.value = ''; soonLink.value = '';
                return r;
              }, 'primary'),
              v.echoLow ? action(ctx, msg, 'Test the Echo', 'Ringing…', () => nightEchoTest(settings.screenLink)) : null,
              v.echoLow ? action(ctx, msg, v.echoAlways ? 'Only at night' : 'At any hour', 'Saving…', () => nightSave(settings.screenLink, { echoAlways: !v.echoAlways })) : null,
              v.echoLow ? action(ctx, msg, 'Remove the triggers', 'Removing…', () => nightSave(settings.screenLink, { echoLowUrl: '', echoSoonUrl: '' })) : null));
        })(),
        (() => {
          const grams = h('input', { type: 'number', min: '5', max: '60', value: String(v.treatGrams || 15), 'aria-label': 'Grams to treat a low', class: 'num' });
          const minutes = h('input', { type: 'number', min: '5', max: '30', value: String(v.treatMinutes || 15), 'aria-label': 'Minutes until the recheck', class: 'num' });
          const plan = h('input', { type: 'text', class: 'grow', maxlength: '200', value: v.treatPlan || '', placeholder: 'for example: 4 glucose tabs or 1/2 cup juice, then recheck', 'aria-label': 'My low plan' });
          return h('details', {},
            h('summary', {}, 'My low plan'),
            state(h, `In the su94r phone app, a low shows "I treated it": one tap logs ${v.treatGrams || 15} g, stops the reminders, and su94r rechecks after ${v.treatMinutes || 15} minutes (still low: the reminders start again). Your plan's words appear in the app and in every low alert. Use the plan your doctor gave you.`),
            h('div', { class: 'actions' }, 'Log ', grams, ' g, recheck after ', minutes, ' min'),
            h('div', { class: 'actions' }, plan),
            h('div', { class: 'actions' }, action(ctx, msg, 'Save my plan', 'Saving…', () => nightSave(settings.screenLink, { treatGrams: Number(grams.value), treatMinutes: Number(minutes.value), treatPlan: plan.value.trim() }), 'primary')));
        })(),
        h('details', {},
          h('summary', {}, 'Sunday summary'),
          state(h, `Every Sunday from 6 PM this computer sends your phone (ntfy and Telegram) a plain-language summary of the week against the week before: time in range, lows and when, average, GMI and steadiness. It is ${settings.weeklySummary === false ? 'off' : 'on'}.`),
          h('div', { class: 'actions' },
            action(ctx, msg, 'Send this week\'s summary now', 'Sending…', () => chrome.runtime.sendMessage({ type: 'weeklyNow' })),
            action(ctx, msg, settings.weeklySummary === false ? 'Turn the Sunday summary on' : 'Turn the Sunday summary off', 'Saving…', () => ctx.saveSetting({ weeklySummary: settings.weeklySummary === false })))),
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
