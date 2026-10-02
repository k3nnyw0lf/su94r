import { login, getConnections, getGraph, toPoint, unitsOf, sensorOf, LibreError } from './libre.js';
import { withDefaults, displayUnits, fmtGlucose, fmtDelta, TREND_ARROWS, mergeSeries, sensorStatus, fmtDuration } from './glucose.js';
import { saveReadings, loadReadings, wholeSeries, putRecords, archivedPatients, firstReading } from './archive.js';
import { ptKey, learnedKey, allPatients, firstName, isDemo } from './store.js';
import { learn, LEARN_DAYS, forecast, trustworthy, trustedHorizon } from './learner.js';
import { getSamples, putSamples, preferOneSource, firstSample } from './vault.js';
import { getToken, saveMonth, readAllMonths, monthOf, monthRange, DRIVE_SCOPES } from './google.js';
import { RAPID_PROFILES } from './insulin.js';
import {
  deviceId, heartbeat, pushEvents, mergeDays, changedDays, syncedDays, pruneOld, tombstoned, utcDay, KEEP_DAYS,
  pushSettings, mergeSettings, stampChanges, syncedShared, SHARED_SETTINGS,
} from './sync.js';
import { isLegacy, answerHandover, bringOver, offerHandover, KNOWN_OLD_IDS } from './handover.js';
import { exchangeDoses, inboxItems, ackInbox, refreshServerSession, connectServer, DEFAULT_SERVER, nightNotify, historyImport } from './voice.js';
import { agp, lowEpisodes, weeklyText } from './agp.js';
import { parseBody } from './vault-import.js';
import { pullGoogleHealth } from './ghealth.js';
import { careTick, careRefresh, careClicked } from './care-bg.js';
import { tempSamples } from './weather.js';

const NAME = 'su94r Mini';
const KEEP_MS = 24 * 3600e3;
const STALE_MS = 10 * 60e3;
const GRAPH_EVERY_MS = 10 * 60e3;   // 12-hour history refresh per patient (back-fills gaps)
const GRAPH_PER_POLL = 3;           // per account, so a ward of patients doesn't burst the API
const SIGNED_OUT_REPEAT_MS = 60 * 60e3;
const LEGACY = isLegacy();          // the old keyless folder copy, kept only to hand its data over

const local = chrome.storage.local;

async function getSettings() {
  const { settings } = await local.get('settings');
  return withDefaults(settings);
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get('poll'))) chrome.alarms.create('poll', { periodInMinutes: 1 });
  if (!(await chrome.alarms.get('update'))) chrome.alarms.create('update', { periodInMinutes: 5 });
}

ensureAlarm();

// ---- the old copy: answer su94r Mini, then stand down ----

async function retired() {
  return LEGACY && Boolean((await local.get('retired')).retired);
}

if (LEGACY) {
  answerHandover({
    onRetire: async () => {
      const { windows = {} } = await chrome.storage.session.get('windows');
      for (const id of Object.values(windows)) chrome.windows.remove(id).catch(() => {});
      await chrome.storage.session.set({ windows: {} });
      const all = await chrome.notifications.getAll();
      for (const id of Object.keys(all)) chrome.notifications.clear(id);
      await paintBadge();
    },
  });
} else {
  // An old copy announces itself (its ID differs per computer). The one built on this
  // computer is known and taken over at once; any other is offered in Settings, because
  // only the user can tell a genuine old copy from another extension.
  chrome.runtime.onMessageExternal.addListener((msg, sender) => {
    if (msg?.type !== 'handover-offer' || !/^[a-p]{32}$/.test(sender?.id || '')) return false;
    local.get('migratedFrom').then(({ migratedFrom }) => {
      if (migratedFrom) return;
      if (KNOWN_OLD_IDS.includes(sender.id)) takeOverOldCopy([sender.id]);
      else local.set({ handoverOffer: { id: sender.id, at: Date.now() } });
    });
    return false;
  });
}

// ---- one-time move from the single-account layout (v1.0) ----

let migrated = null;
function migrate() {
  migrated ??= (async () => {
    const old = await local.get(['session', 'connections', 'patientId', 'hist', 'live', 'latest', 'patient', 'sensor', 'state', 'accounts', 'alertState', 'miniBounds', 'settings']);
    if (old.accounts?.length || !old.session) return;
    const id = old.session.userId;
    const pid = old.patientId;
    const name = old.connections?.find((c) => c.patientId === pid)?.name || old.patient?.name || '';
    const writes = {
      accounts: [{
        id,
        label: 'LibreLinkUp account',
        session: old.session,
        state: old.state || { status: 'ok', message: '', at: Date.now() },
        patientIds: (old.connections || []).map((c) => c.patientId),
      }],
    };
    if (pid) {
      writes[ptKey(pid)] = {
        pid, accountId: id, name,
        units: old.patient?.units || 'mg/dL', low: old.patient?.low ?? 70, high: old.patient?.high ?? 180,
        sensor: old.sensor || null, latest: old.latest || null, hist: old.hist || [], live: old.live || [],
        state: old.state || null, graphAt: 0,
      };
      if (old.alertState && !old.alertState[pid]) writes.alertState = { [pid]: old.alertState };
      if (old.miniBounds) writes.bounds = { [pid]: old.miniBounds };
      if (old.settings?.hours) writes.views = { [pid]: { hours: old.settings.hours } };
    }
    await local.set(writes);
    await local.remove(['session', 'connections', 'patientId', 'hist', 'live', 'latest', 'patient', 'sensor', 'state', 'miniBounds']);
  })();
  return migrated;
}

// ---- lifecycle ----

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrate();
  // No settings write here: every reader fills defaults via withDefaults(), and a
  // read-then-write at install/update time would undo a setting changed meanwhile.
  if (!LEGACY && reason === 'install') {
    await local.set({ installedAt: Date.now() });
    await takeOverOldCopy();
  }
  const { accounts, reopenAfterUpdate } = await local.get(['accounts', 'reopenAfterUpdate']);
  if (reason === 'install' && !accounts?.length) chrome.runtime.openOptionsPage();
  await bringInSynced();
  await poll();
  if (!LEGACY) autoConnect().catch(() => {});
  if (reopenAfterUpdate?.length) {
    await local.remove('reopenAfterUpdate');
    for (const key of reopenAfterUpdate) await openWindow(key);
  } else if (reason === 'install' && accounts?.length) {
    openDefault();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await bringInSynced();
  await poll();
  if ((await getSettings()).openOnStartup && !(await retired())) openDefault();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'poll') poll();
  if (a.name === 'update') {
    checkForUpdate();
    if (!LEGACY) driveSave().catch(() => {});
    if (!LEGACY) healthSync().catch(() => {});
    if (!LEGACY) careTick().catch(() => {});
    if (!LEGACY) refreshServer().catch(() => {});
    if (!LEGACY) autoConnect().catch(() => {});
    if (!LEGACY) weeklySummary().catch(() => {});
    if (!LEGACY) copyHistoryOnce().catch(() => {});
    if (LEGACY && !(await retired())) offerHandover();
    if (!LEGACY) {
      flushSyncQueue();
      // An old copy that has not updated yet cannot answer; keep asking for a few days.
      const { migratedFrom, installedAt = 0 } = await local.get(['migratedFrom', 'installedAt']);
      if (!migratedFrom && Date.now() - installedAt < 3 * 864e5) takeOverOldCopy();
    }
  }
});

/** su94r Mini: bring everything over from an old Libre Mini Graph copy, if one is installed. */
let takingOver = null;
function takeOverOldCopy(ids = KNOWN_OLD_IDS) {
  takingOver ??= doTakeOver(ids).finally(() => { takingOver = null; });
  return takingOver;
}

async function doTakeOver(ids) {
  const r = await bringOver(ids);
  if (!r.ok) return { ok: false };
  // Markers go through the single writer, and one another computer has deleted is never
  // brought back: tombstones in sync win over the old copy's frozen list.
  const added = await serial(async () => {
    const gone = await tombstoned(r.events).catch(() => new Set());
    const { events = [] } = await local.get('events');
    const have = new Set(events.map((e) => e.id));
    const fresh = r.events.filter((e) => !gone.has(e.id) && !have.has(e.id));
    if (fresh.length) await local.set({ events: [...events, ...fresh].sort((a, b) => a.t - b.t) });
    await sendOut({ upsert: fresh.filter((e) => !isDemo(e.p)) });
    return fresh.length;
  });
  // Settings: the old copy's are the user's. They are stamped as older than any real change,
  // so a setting changed on another computer (already in sync) still wins, and they are
  // published only where sync has nothing yet.
  if (r.settings) {
    const { settings: raw } = await local.get('settings');
    await local.set({
      settings: { ...r.settings, demo: false, ...(raw?.deviceName ? { deviceName: raw.deviceName } : {}) },
      settingsStamps: Object.fromEntries(SHARED_SETTINGS.map((k) => [k, 1])),
      settingsHandover: Date.now(),
    });
  }
  const summary = { ok: true, from: r.from, fromVersion: r.fromVersion, accounts: r.accounts, events: added, readings: r.readings, at: r.at };
  await local.set({ migratedFrom: summary });
  await local.remove('handoverOffer');
  await bringInSynced();
  await poll();
  return summary;
}

// ---- automatic updates for folder (unpacked) installs ----
// Chrome only re-reads an unpacked extension when it is reloaded. When the copy on
// disk has a different version (a synced folder or a git pull updated it), reload,
// then reopen the windows that were open. A synced folder copies files one at a time,
// so first check that every file of the new version has arrived (build.json lists
// each file's SHA-256), or, without build.json, that the version held for two checks.
async function sha256Hex(buf) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function newVersionComplete(onDisk) {
  let build = null;
  try {
    const res = await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' });
    if (res.ok) build = await res.json();
  } catch { /* no build.json in this copy */ }
  if (build) {
    if (build.version !== onDisk) return false;
    for (const [path, hash] of Object.entries(build.files || {})) {
      const res = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
      if (!res.ok || await sha256Hex(await res.arrayBuffer()) !== hash) return false;
    }
    return true;
  }
  const { pendingVersion } = await chrome.storage.session.get('pendingVersion');
  if (pendingVersion === onDisk) return true;
  await chrome.storage.session.set({ pendingVersion: onDisk });
  return false;
}

async function checkForUpdate() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await res.json()).version;
    const running = chrome.runtime.getManifest().version;
    if (!onDisk || onDisk === running) return;
    if (!(await newVersionComplete(onDisk))) return;
    // Let any marker change in progress finish first, so nothing is half-written or unsent.
    await queue;
    const { windows = {} } = await chrome.storage.session.get('windows');
    await local.set({ reopenAfterUpdate: Object.keys(windows), justUpdated: { from: running, to: onDisk, at: Date.now() } });
    chrome.runtime.reload();
  } catch { /* try again at the next check */ }
}

chrome.action.onClicked.addListener(async () => {
  if (await retired()) return chrome.runtime.openOptionsPage();
  const settings = await getSettings();
  const { accounts = [] } = await local.get('accounts');
  if (!accounts.length && !settings.demo) chrome.runtime.openOptionsPage();
  else openDefault();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-mini' || await retired()) return;
  const { windows = {} } = await chrome.storage.session.get('windows');
  if (Object.keys(windows).length) chrome.runtime.sendMessage({ type: 'toggleMini' }).catch(() => openDefault());
  else openDefault();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  // Other computers: merge their markers and shared settings in.
  if (area === 'sync') {
    const days = changedDays(changes);
    if (days.length) pullDays(days);
    if (changes.shared?.newValue) applyShared(changes.shared.newValue);
    return;
  }
  if (area !== 'local') return;
  // This computer: stamp and send shared-setting changes. A write that carries new
  // stamps is a merge from another computer, so it is not sent back.
  const s = changes.settings;
  if (s?.newValue && !changes.settingsStamps && !changes.settingsHandover) {
    const { settingsStamps = {} } = await local.get('settingsStamps');
    const stamps = stampChanges(withDefaults(s.oldValue), withDefaults(s.newValue), settingsStamps);
    if (stamps) {
      await local.set({ settingsStamps: stamps });
      pushSettings(withDefaults(s.newValue), stamps).catch(() => {});
    }
  }
  if (s && Boolean(s.oldValue?.demo) !== Boolean(s.newValue?.demo)) poll();
  else if (s) paintBadge();
});

chrome.windows.onBoundsChanged.addListener(async (w) => {
  if (w.state !== 'normal') return;
  const { windows = {} } = await chrome.storage.session.get('windows');
  const key = Object.keys(windows).find((k) => windows[k] === w.id);
  if (!key) return;
  const { bounds = {} } = await local.get('bounds');
  bounds[key] = { left: w.left, top: w.top, width: w.width, height: w.height };
  local.set({ bounds });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { windows = {} } = await chrome.storage.session.get('windows');
  const key = Object.keys(windows).find((k) => windows[k] === id);
  if (!key) return;
  delete windows[key];
  chrome.storage.session.set({ windows });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    refresh: () => poll(),
    openMini: () => openWindow(msg.pid),
    openBoard: () => openWindow('board'),
    openAi: () => openWindow(`ai:${msg.pid || ''}`),
    login: () => addAccount(msg.email, msg.password),
    removeAccount: () => removeAccount(msg.id),
    signOut: () => removeAccount(null),
    testAlert: () => testAlert(),
    weeklyNow: () => weeklySummary({ force: true }),
    addEvents: () => addEvents(msg.events),
    removeEvents: () => removeEvents(msg.ids),
    bringOver: () => (LEGACY ? { ok: false } : takeOverOldCopy(msg.id ? [msg.id] : KNOWN_OLD_IDS)),
    learnNow: async () => ({ done: await learnAll(await getSettings(), true) }),
    driveSave: () => driveSave(true),
    driveRestore: () => driveRestore(),
    importDriveFile: () => importMonths([msg.file]),
    driveDirty: () => markDirty(Array.isArray(msg.times) ? msg.times : []),
    healthSync: () => healthSync(true),
    careNow: () => careTick(),
    calendarNow: () => careRefresh('calendar'),
    weatherNow: () => careRefresh('weather'),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler()).then(
    (r) => reply({ ok: true, ...(r || {}) }),
    (e) => reply({ ok: false, error: e.message, code: e.code }),
  );
  return true;
});

// ---- markers: one writer, one change at a time ----
// Every change to the marker list goes through here, so two windows (or a window
// and an incoming sync) can never overwrite each other's change.

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const validEvent = (e) => e && typeof e.id === 'string' && e.p && Number.isFinite(e.t) && typeof e.type === 'string';
// What the su94r server shares with Alexa and Telegram: every insulin dose, and meals said to Alexa or logged in Telegram.
const voiced = (e) => e.type === 'insulin' || (e.type === 'meal' && (e.source === 'alexa' || e.source === 'telegram' || e.source === 'phone'));

function addEvents(list) {
  return serial(async () => {
    const valid = (Array.isArray(list) ? list : []).filter(validEvent);
    const { events = [] } = await local.get('events');
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const e of valid) byId.set(e.id, e);
    await local.set({ events: [...byId.values()].sort((a, b) => a.t - b.t) });
    await sendOut({ upsert: valid });
    await markDirty(valid.map((e) => e.t));
    return { added: valid.length };
  });
}

function removeEvents(ids) {
  return serial(async () => {
    const drop = new Set(Array.isArray(ids) ? ids : []);
    const { events = [] } = await local.get('events');
    const gone = events.filter((e) => drop.has(e.id));
    if (!gone.length) return { removed: 0 };
    await local.set({ events: events.filter((e) => !drop.has(e.id)) });
    await rememberDeleted(gone.map((e) => ({ id: e.id, t: e.t })));
    // Tell the su94r server too, so Alexa forgets a deleted dose.
    const insulinGone = gone.filter(voiced).map((e) => e.id);
    if (insulinGone.length) {
      const { voiceRemoved = [] } = await local.get('voiceRemoved');
      await local.set({ voiceRemoved: [...new Set([...voiceRemoved, ...insulinGone])].slice(-500) });
    }
    await sendOut({ remove: gone });
    return { removed: gone.length };
  });
}

/** Sends a change to the other computers, or keeps it to retry when sync is unavailable. */
async function sendOut({ upsert = [], remove = [] }) {
  if (!upsert.length && !remove.length) return;
  if (await pushEvents({ upsert, remove })) return;
  const { syncQueue = { upsert: [], remove: [] } } = await local.get('syncQueue');
  const removedIds = new Set(remove.map((e) => e.id));
  const upsertIds = new Set(upsert.map((e) => e.id));
  await local.set({
    syncQueue: {
      upsert: [...syncQueue.upsert.filter((e) => !removedIds.has(e.id) && !upsertIds.has(e.id)), ...upsert],
      remove: [...syncQueue.remove.filter((e) => !upsertIds.has(e.id) && !removedIds.has(e.id)), ...remove],
    },
  });
}

function flushSyncQueue() {
  return serial(async () => {
    const { syncQueue } = await local.get('syncQueue');
    if (!syncQueue || (!syncQueue.upsert.length && !syncQueue.remove.length)) return;
    if (await pushEvents(syncQueue)) await local.remove('syncQueue');
  });
}

function pullDays(days) {
  return serial(async () => {
    const { events = [], syncQueue } = await local.get(['events', 'syncQueue']);
    const pending = {
      add: new Set((syncQueue?.upsert || []).map((e) => e.id)),
      remove: new Set((syncQueue?.remove || []).map((e) => e.id)),
    };
    const { events: next, missing } = await mergeDays(days, events, pending);
    if (next) {
      await local.set({ events: next });
      // Insulin deleted on another computer: tell the su94r server too, so Alexa forgets it
      // even if the computer that deleted it is offline.
      const kept = new Set(next.map((e) => e.id));
      await rememberDeleted(events.filter((e) => !kept.has(e.id)).map((e) => ({ id: e.id, t: e.t })));
      const had = new Set(events.map((e) => e.id));
      await markDirty(next.filter((e) => !had.has(e.id)).map((e) => e.t));
      const goneInsulin = events.filter((e) => voiced(e) && !kept.has(e.id)).map((e) => e.id);
      if (goneInsulin.length) {
        const { voiceRemoved = [] } = await local.get('voiceRemoved');
        await local.set({ voiceRemoved: [...new Set([...voiceRemoved, ...goneInsulin])].slice(-500) });
      }
    }
    // Markers that dropped out of sync (two computers wrote the same day at once): send again.
    if (missing.length) await sendOut({ upsert: missing });
  });
}

async function applyShared(shared) {
  const { settings, settingsStamps = {} } = await local.get(['settings', 'settingsStamps']);
  const merged = mergeSettings(withDefaults(settings), settingsStamps, shared);
  if (merged) await local.set({ settings: merged.settings, settingsStamps: merged.stamps });
}

async function bringInSynced() {
  try {
    // Every day sync holds, plus every recent day this computer has markers for, so a
    // marker missing from sync altogether is noticed and sent again.
    const { events: mine = [] } = await local.get('events');
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    await pullDays([...new Set([...(await syncedDays()), ...mine.filter((e) => e.t >= cutoff).map((e) => utcDay(e.t))])]);
    const shared = await syncedShared();
    if (shared) await applyShared(shared);
    const { settings, settingsStamps = {} } = await local.get(['settings', 'settingsStamps']);
    await pushSettings(withDefaults(settings), settingsStamps);
    await pruneOld();
    await flushSyncQueue();
  } catch { /* sync unavailable (signed out of Chrome or sync off): everything still works locally */ }
}

// ---- windows: one mini window per patient, plus the board ----

async function openDefault() {
  const patients = await allPatients(await getSettings());
  if (patients.length === 1) openWindow(patients[0].pid);
  else openWindow('board');
}

async function openWindow(key) {
  if (!key) return openDefault();
  const { windows = {} } = await chrome.storage.session.get('windows');
  if (windows[key] != null) {
    try {
      await chrome.windows.update(windows[key], { focused: true, state: 'normal' });
      return;
    } catch { /* closed */ }
  }
  const { bounds = {} } = await local.get('bounds');
  const b = bounds[key];
  const board = key === 'board';
  const ai = key.startsWith('ai:');
  const url = board ? 'board.html' : ai ? `ai.html?p=${encodeURIComponent(key.slice(3))}` : `mini.html?p=${encodeURIComponent(key)}`;
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL(url),
    type: 'popup',
    focused: true,
    width: b?.width || (board ? 900 : ai ? 760 : 360),
    height: b?.height || (board ? 620 : ai ? 820 : 270),
    ...(b ? { left: b.left, top: b.top } : {}),
  });
  windows[key] = w.id;
  await chrome.storage.session.set({ windows });
}

// ---- accounts ----

async function addAccount(email, password) {
  const session = await login(String(email || '').trim(), String(password || ''));
  const { connections, session: s } = await getConnections(session);
  const { accounts = [] } = await local.get('accounts');
  const account = {
    id: session.userId,
    label: String(email || '').trim(),
    session: s,
    state: { status: 'ok', message: '', at: Date.now() },
    patientIds: connections.map((c) => c.patientId),
  };
  const others = accounts.filter((a) => a.id !== account.id);
  const settings = await getSettings();
  await local.set({ accounts: [...others, account], settings: { ...settings, demo: false } });
  await poll();
  if (!connections.length) {
    throw new LibreError('no-connections',
      'Signed in, but nobody is sharing with this LibreLinkUp account yet. Send an invite from the Libre 3 app and accept it in LibreLinkUp.');
  }
  return { patients: connections.length };
}

// Removing an account forgets its login and live view; saved history stays until deleted in Settings.
async function removeAccount(id) {
  const { accounts = [] } = await local.get('accounts');
  const gone = id == null ? accounts : accounts.filter((a) => a.id === id);
  const keep = id == null ? [] : accounts.filter((a) => a.id !== id);
  const stillFollowed = new Set(keep.flatMap((a) => a.patientIds || []));
  const drop = gone.flatMap((a) => a.patientIds || []).filter((pid) => !stillFollowed.has(pid));
  await local.set({ accounts: keep });
  await local.remove(drop.map(ptKey));
  for (const a of gone) chrome.notifications.clear(`glucose|signedOut-${a.id}`);
  await paintBadge();
}

// ---- polling ----

let inFlight = null;
function poll() {
  inFlight ??= doPoll().finally(() => { inFlight = null; });
  return inFlight;
}

async function doPoll() {
  await migrate();
  if (await retired()) return paintBadge();
  const settings = await getSettings();
  const { accounts = [] } = await local.get('accounts');
  // Check in for the device list (throttled to every 15 min inside), whatever the mode.
  heartbeat(settings, (await allPatients(settings)).length).catch(() => {});
  // Demo only stands in when nobody is signed in, so it can never silence real alerts.
  if (settings.demo && accounts.length) {
    const { settings: raw } = await local.get('settings');
    await local.set({ settings: { ...raw, demo: false } });
    settings.demo = false;
  }
  if (settings.demo) return demoPoll();
  await clearDemo();

  const polled = new Map();
  for (const acc of accounts) {
    const copy = { ...acc };
    await pollAccount(copy, settings);
    polled.set(acc.id, copy);
  }
  // An account added or removed while this poll ran must not be undone by writing back
  // the list read at the start: apply each polled result to the list as it is now.
  if (polled.size) {
    const { accounts: current = [] } = await local.get('accounts');
    await local.set({
      accounts: current.map((a) => {
        const p = polled.get(a.id);
        return p && a.session?.token === accounts.find((x) => x.id === a.id)?.session?.token
          ? { ...a, session: p.session, state: p.state, patientIds: p.patientIds }
          : a;
      }),
    });
  }
  // People left behind by an account removed while this poll ran: forget their live view
  // (saved history stays), so no alarm keeps firing for someone nobody follows.
  const { accounts: nowAccounts = [] } = await local.get('accounts');
  const followed = new Set(nowAccounts.map((a) => a.id));
  const orphans = (await allPatients({ ...settings, demo: false })).filter((p) => !followed.has(p.accountId));
  if (orphans.length) await local.remove(orphans.map((p) => ptKey(p.pid)));
  await checkAlerts();
  await syncVoice(settings);
  await paintBadge();
  learnAll(settings).catch(() => {});
  return pushWidget(settings);
}

// ---- a copy in the person's own Google Drive (google.js) ----

const DRIVE_EVERY_MS = 60 * 60e3;
let driving = null;

/**
 * Markers deleted here or on another computer ({ id, t }). Kept with their time, so the Drive file
 * of the marker's own month drops them, and forever in `deletedIds`, so no import brings them back.
 */
async function rememberDeleted(list) {
  if (!list.length) return;
  const { driveDeleted = [], deletedIds = [] } = await local.get(['driveDeleted', 'deletedIds']);
  const known = new Set(driveDeleted.map((d) => d.id ?? d));
  await local.set({
    driveDeleted: [...driveDeleted, ...list.filter((d) => !known.has(d.id))].slice(-3000),
    deletedIds: [...new Set([...deletedIds, ...list.map((d) => d.id)])].slice(-20000),
  });
  await markDirty(list.map((d) => d.t));
}

/** Months whose Drive file must be saved again because something in them changed here. */
async function markDirty(times) {
  const months = [...new Set((times || []).map((t) => (typeof t === 'number' ? t : Date.parse(t))).filter(Number.isFinite).map(monthOf))];
  if (!months.length) return;
  const { driveDirty = [] } = await local.get('driveDirty');
  const next = [...new Set([...driveDirty, ...months])];
  if (next.length !== driveDirty.length) await local.set({ driveDirty: next });
}

/** This computer's month in the Drive file's shape. */
async function localMonth(month, settings) {
  const [from, to] = monthRange(month);
  const people = await allPatients({ ...settings, demo: false });
  const names = Object.fromEntries(people.map((p) => [p.pid, p.name || '']));
  const pids = [...new Set([...people.map((p) => p.pid), ...(await archivedPatients())])].filter((p) => !isDemo(p));
  const readings = {};
  for (const pid of pids) {
    const recs = await loadReadings(pid, from, to - 1);
    if (recs.length) readings[pid] = recs.map((r) => [r.t, r.mg, r.src]);
  }
  const { events = [], driveDeleted = [] } = await local.get(['events', 'driveDeleted']);
  const thisMonth = monthOf(Date.now()) === month;
  return {
    app: 'su94r', version: 1, month, people: names, readings,
    markers: events.filter((e) => e.t >= from && e.t < to && !isDemo(e.p)),
    // Deletions go in the file of the deleted marker's own month (older entries have no time:
    // they go in this month's).
    deleted: driveDeleted.filter((d) => (typeof d === 'string' ? thisMonth : d.t >= from && d.t < to)).map((d) => d.id ?? d),
    health: await getSamples({ from, to: to - 1 }).catch(() => []),
  };
}

/** Saves to Drive at most hourly (or now with `force`). The first save sends every month there is. */
function driveSave(force = false) {
  driving ??= doDriveSave(force).finally(() => { driving = null; });
  return driving;
}

async function doDriveSave(force) {
  const settings = await getSettings();
  if (!settings.driveBackup) return { skipped: 'off' };
  const { driveState = {} } = await local.get('driveState');
  if (!force && driveState.at && Date.now() - driveState.at < DRIVE_EVERY_MS) return { skipped: 'recent' };
  // After a failure, wait longer each time (5 min, 10, 20 … up to 2 hours) before trying again.
  if (!force && driveState.failures && Date.now() - (driveState.tried || 0) < Math.min(2 * 3600e3, 5 * 60e3 * 2 ** (driveState.failures - 1))) return { skipped: 'backoff' };
  const failed = (e) => ({ ...driveState, error: e.message, code: e.code, tried: Date.now(), failures: (driveState.failures || 0) + 1 });
  let token;
  try {
    token = await getToken(DRIVE_SCOPES, { interactive: false });
  } catch (e) {
    await local.set({ driveState: failed(e) });
    return { ok: false, error: e.message, code: e.code };
  }
  const now = Date.now();
  // This month (and last month in its first days), every month changed here since the last
  // save, and, until the first full save is done, every month there is anything for.
  const { driveDirty = [] } = await local.get('driveDirty');
  const months = new Set([monthOf(now), ...driveDirty]);
  if (new Date(now).getUTCDate() <= 2) months.add(monthOf(now - 3 * 864e5));
  if (!driveState.full) {
    let first = now;
    for (const pid of await archivedPatients()) first = Math.min(first, (await firstReading(pid))?.t ?? now);
    const { events = [] } = await local.get('events');
    for (const e of events) first = Math.min(first, e.t);
    first = Math.min(first, (await firstSample().catch(() => null))?.t ?? now);
    const done = new Set(driveState.doneMonths || []);
    for (let t = Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth(), 1); t <= now; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) {
      if (!done.has(monthOf(t))) months.add(monthOf(t));
    }
  }
  const order = [...months].sort();
  const saved = [];
  try {
    for (const m of order) {
      await saveMonth(token, await localMonth(m, settings));
      saved.push(m);
      // Progress is kept as it goes, so an interrupted first save resumes where it stopped.
      if (!driveState.full) await local.set({ driveState: { ...driveState, doneMonths: [...new Set([...(driveState.doneMonths || []), ...saved])] } });
    }
  } catch (e) {
    await afterSave(saved);
    await local.set({ driveState: { ...failed(e), doneMonths: [...new Set([...(driveState.doneMonths || []), ...saved])] } });
    return { ok: false, error: e.message, code: e.code };
  }
  await afterSave(saved);
  await local.set({ driveState: { at: now, full: true, months: order, error: null, failures: 0 } });
  return { ok: true, months: order };
}

/** After months were saved: they are no longer changed, and their deletions are in Drive. */
async function afterSave(saved) {
  if (!saved.length) return;
  const done = new Set(saved);
  const thisMonth = monthOf(Date.now());
  const { driveDirty = [], driveDeleted = [] } = await local.get(['driveDirty', 'driveDeleted']);
  await local.set({
    driveDirty: driveDirty.filter((m) => !done.has(m)),
    driveDeleted: driveDeleted.filter((d) => !done.has(typeof d === 'string' ? thisMonth : monthOf(d.t))),
  });
}

/** Brings everything in Drive onto this computer: readings, markers (not deleted ones) and health. */
async function driveRestore() {
  const token = await getToken(DRIVE_SCOPES, { interactive: false });
  return importMonths(await readAllMonths(token));
}

/** Adds su94r month files (from Drive or a file the person chose) to this computer. */
async function importMonths(files) {
  files = (files || []).filter((f) => f?.app === 'su94r');
  let readings = 0, health = 0;
  const markers = [];
  const deleted = new Set();
  // Whatever came in is saved to Drive again with the next save (a file chosen by hand may hold
  // things Drive does not have yet).
  await markDirty(files.map((f) => (/^\d{4}-\d{2}$/.test(f.month || '') ? monthRange(f.month)[0] : null)).filter(Boolean));
  for (const f of files) {
    for (const [pid, rows] of Object.entries(f.readings || {})) readings += await putRecords(rows.map(([t, mg, src]) => ({ p: pid, t, mg, src })));
    health += (await putSamples(f.health || [])).added;
    for (const id of f.deleted || []) deleted.add(id);
    markers.push(...(f.markers || []));
  }
  const added = await serial(async () => {
    const fresh = markers.filter((e) => validEvent(e) && !deleted.has(e.id));
    const gone = await tombstoned(fresh).catch(() => new Set());
    const { events = [], driveDeleted = [], deletedIds = [] } = await local.get(['events', 'driveDeleted', 'deletedIds']);
    const have = new Set(events.map((e) => e.id));
    const mine = new Set([...driveDeleted.map((d) => d.id ?? d), ...deletedIds]);
    const add = [...new Map(fresh.filter((e) => !gone.has(e.id) && !have.has(e.id) && !mine.has(e.id)).map((e) => [e.id, e])).values()];
    if (add.length) {
      await local.set({ events: [...events, ...add].sort((a, b) => a.t - b.t) });
      await sendOut({ upsert: add.filter((e) => e.t >= Date.now() - KEEP_DAYS * 864e5) });
    }
    return add.length;
  });
  return { months: files.length, readings, markers: added, health };
}

// ---- the su94r server's LibreLinkUp sign-in ----
// A server connected without a stored password reads LibreLinkUp with the sign-in su94r Mini
// handed over; every 6 hours su94r Mini hands it the newest one, so it never runs out.
async function refreshServer() {
  const settings = await getSettings();
  if (!settings.screenLink) return;
  const { serverRefreshAt = 0, accounts = [] } = await local.get(['serverRefreshAt', 'accounts']);
  if (Date.now() - serverRefreshAt < 6 * 3600e3) return;
  await local.set({ serverRefreshAt: Date.now() });
  for (const a of accounts.filter((x) => x.session?.token)) {
    try { await refreshServerSession(settings.screenLink, a.session); return; } catch (e) { if (e.status !== 403) return; }   // 403: another account; try the next
  }
}

// ---- Sunday summary: the week against the week before, to the phone (ntfy and Telegram) ----
// Sunday from 6 PM, once (also when this computer comes on later that evening). Describes the
// week in plain words; it never advises. Settings → Low alerts on your phone can switch it off.
async function weeklySummary({ force = false } = {}) {
  const settings = await getSettings();
  if (LEGACY || !settings.screenLink || (settings.weeklySummary === false && !force)) return { ok: false, error: 'off' };
  const now = new Date();
  const key = now.toDateString();
  if (!force) {
    if (now.getDay() !== 0 || now.getHours() < 18) return { ok: false };
    const { weeklyAt } = await local.get('weeklyAt');
    if (weeklyAt === key) return { ok: false };
    await local.set({ weeklyAt: key });                  // one try per Sunday, even if it fails
  }
  const people = await allPatients(settings);
  const p = people.find((x) => x.pid === settings.vaultOwner) || people[0];
  if (!p) return { ok: false, error: 'No one to sum up yet.' };
  const t = now.getTime(), D = 864e5;
  const saved = wholeSeries(await loadReadings(p.pid, t - 14 * D));
  const recent = mergeSeries(p.hist, p.live);
  const cutoff = recent.length ? recent[0].t : Infinity;
  const points = [...saved.filter((q) => q.t < cutoff - 60e3), ...recent];
  const { events = [] } = await local.get('events');
  const mine = events.filter((e) => e.p === p.pid);
  const range = { low: p.low ?? 70, high: p.high ?? 180 };
  const cur = agp(points, mine, { from: t - 7 * D, to: t, ...range });
  const prev = agp(points, mine, { from: t - 14 * D, to: t - 7 * D, ...range });
  const units = displayUnits(settings, p);
  const text = weeklyText(cur, prev, { lows: lowEpisodes(points, { from: t - 7 * D, to: t, low: range.low }), fmt: (mg) => `${fmtGlucose(mg, units)} ${units}` });
  await nightNotify(settings.screenLink, `Your week${people.length > 1 ? ` (${firstName(p.name)})` : ''}`, text);
  return { ok: true };
}

// ---- the server's history (history.js): copy what this computer has kept, once per person ----
// The server keeps every reading itself from then on; this fills in the past 90 days so reports
// and the phone app have history at once. 5-minute steps, pieces of 4000, one person per run.
async function copyHistoryOnce() {
  const settings = await getSettings();
  if (!settings.screenLink) return;
  // historyCopied2: the first copies (2.12) reached a proxy that did not forward them, so they run again.
  const { historyCopied2: historyCopied = {} } = await local.get('historyCopied2');
  for (const p of await allPatients(settings)) {
    if (historyCopied[p.pid] || isDemo(p.pid)) continue;
    const pts = wholeSeries(await loadReadings(p.pid, Date.now() - 90 * 864e5));
    const thin = [];
    let last = 0;
    for (const q of pts) if (q.t - last >= 4.5 * 60e3) { thin.push([q.t, q.mg]); last = q.t; }
    for (let i = 0; i < thin.length; i += 4000) {
      // Done only when the server says so; anything else tries again at the next 5-minute check.
      const r = await historyImport(settings.screenLink, p.pid, thin.slice(i, i + 4000));
      if (r?.ok !== true) throw new Error('history copy not confirmed');
    }
    historyCopied[p.pid] = Date.now();
    await local.set({ historyCopied2: historyCopied });
    return;
  }
}

// ---- connecting without the button, on the owner's own computers ----
// A connect-here.json file put by hand in the extension folder ({ "server": "https://…" };
// never shipped) connects this copy to that su94r server by itself, the same way the Settings
// button does, as long as nothing is connected yet. Tried at most every 4 minutes.
async function autoConnect() {
  const settings = await getSettings();
  if (settings.screenLink) return;
  let want;
  try {
    const res = await fetch(chrome.runtime.getURL('connect-here.json'), { cache: 'no-store' });
    if (!res.ok) return;
    want = await res.json();
  } catch { return; }
  const base = String(want?.server || DEFAULT_SERVER).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) return;
  const { autoConnectAt = 0, accounts = [] } = await local.get(['autoConnectAt', 'accounts']);
  if (Date.now() - autoConnectAt < 4 * 60e3) return;
  await local.set({ autoConnectAt: Date.now() });
  const done = (result) => local.set({ autoConnect: { at: Date.now(), ...result } });
  const signedIn = accounts.filter((a) => a.session?.token && a.session?.accountId);
  const acc = signedIn.find((a) => settings.vaultOwner && a.patientIds?.includes(settings.vaultOwner)) || signedIn[0];
  if (!acc) return done({ ok: false, message: 'No LibreLinkUp sign-in yet.' });
  try {
    const r = await connectServer(base, acc.session, settings.deviceName || 'su94r Mini');
    await local.set({ settings: withDefaults({ ...(await getSettings()), screenLink: `${base}/d/${r.key}` }) });
    await done({ ok: true, people: r.people });
    chrome.notifications.create('su94r-connected', {
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'Connected to your su94r server',
      message: 'Alexa and your screens can now read your glucose. Say "Alexa, ask my sugar how I am".',
    });
  } catch (err) {
    await done({ ok: false, message: err.message, code: err.code || null });
  }
}

// ---- health connections: the phone inbox and Google Health (connectors.js) ----

const GH_EVERY_MS = 30 * 60e3;
let healthing = null;

/**
 * Collects from the phone inbox (every 5 minutes) and Google Health (every 30). One run at a
 * time; "Read now" asked for during a run gets its own run right after.
 */
function healthSync(force = false) {
  if (healthing && force) {
    const after = healthing.then(() => doHealthSync(true), () => doHealthSync(true));
    healthing = after.finally(() => { if (healthing === after) healthing = null; });
    return after;
  }
  healthing ??= doHealthSync(force).finally(() => { healthing = null; });
  return healthing;
}

async function doHealthSync(force) {
  const settings = await getSettings();
  const { connectors = {} } = await local.get('connectors');
  const out = {};
  const box = connectors.inbox;
  if (box?.secret && box.key && settings.screenLink) {
    let added = 0, skipped = 0, error = null;
    try {
      for (let round = 0; round < 40; round++) {
        const r = await inboxItems(settings.screenLink, box.secret, box.key);
        if (!r.items?.length) break;
        const stored = [];
        let stop = false;
        for (const item of r.items) {
          // A body no format matches is skipped (and acknowledged, so it cannot block the rest);
          // a failure to store stops here, and nothing from it on is acknowledged.
          let samples;
          try { samples = parseBody(item.body).samples; } catch { skipped++; stored.push(item.id); continue; }
          try {
            added += (await putSamples(samples)).added;
            await markDirty(samples.map((s) => s.t));
            stored.push(item.id);
          } catch (e) { error = `Could not store a reading here: ${e.message}`; stop = true; break; }
        }
        if (stored.length) await ackInbox(settings.screenLink, box.secret, box.key, stored);
        if (stop || !r.more) break;
      }
    } catch (e) { error = e.message; }
    out.inbox = { at: Date.now(), added: (box.added || 0) + added, skipped: (box.skipped || 0) + skipped, error };
  }
  const gh = connectors.googleHealth;
  if (gh?.on && (force || !gh.at || Date.now() - gh.at >= GH_EVERY_MS)) {
    const started = Date.now();
    try {
      const r = await pullGoogleHealth(gh.cursors || {});
      const stored = await putSamples(r.samples);
      await markDirty(r.samples.map((s) => s.t));
      out.googleHealth = { at: started, cursors: r.cursors, added: (gh.added || 0) + stored.added, errors: r.errors, error: null, code: null };
    } catch (e) {
      out.googleHealth = { error: e.message, code: e.code, tried: started };
    }
  }
  if (!Object.keys(out).length) return { ok: true, nothing: true };
  // Apply to the connections as they are now: one removed meanwhile stays removed.
  const { connectors: now = {} } = await local.get('connectors');
  if (out.inbox && now.inbox?.secret === box.secret) now.inbox = { ...now.inbox, ...out.inbox };
  if (out.googleHealth && now.googleHealth?.on) now.googleHealth = { ...now.googleHealth, ...out.googleHealth };
  await local.set({ connectors: now });
  return { ok: true, inbox: out.inbox?.error || null, googleHealth: out.googleHealth?.error || null };
}

// ---- the learner (learner.js): what insulin, food, exercise, sleep and the time of day do ----

const LEARN_EVERY_MS = 6 * 3600e3;
let learning = null;

/**
 * Re-learns each person's model when it is older than 6 hours. One run at a time; a forced run
 * asked for while one is going ("Learn again now") runs right after it, so it really relearns.
 */
function learnAll(settings, force = false) {
  if (learning && force) {
    const after = learning.then(() => doLearn(settings, true), () => doLearn(settings, true));
    learning = after.finally(() => { if (learning === after) learning = null; });
    return after;
  }
  learning ??= doLearn(settings, force).finally(() => { learning = null; });
  return learning;
}

async function doLearn(settings, force) {
  const people = (await allPatients({ ...settings, demo: false })).filter((p) => !isDemo(p.pid));
  if (!people.length) return [];
  const now = Date.now();
  const { events = [] } = await local.get('events');
  // The vault holds the computer owner's own health data (and their local weather). It counts
  // only for the person chosen on the vault page; until someone is chosen, for nobody.
  const owner = settings.vaultOwner && people.some((p) => p.pid === settings.vaultOwner) ? settings.vaultOwner : null;
  // Outdoor temperature (Settings → Heads-ups → Heat), so the learner can check what heat does.
  const { weather } = await local.get('weather');
  const heat = weather?.temps ? tempSamples(weather.temps) : [];
  const done = [];
  for (const p of people) {
    const key = learnedKey(p.pid);
    const old = (await local.get(key))[key];
    if (!force && old?.fittedAt && now - old.fittedAt < LEARN_EVERY_MS) continue;
    const points = wholeSeries(await loadReadings(p.pid, now - LEARN_DAYS * 864e5));
    // One source per type and day, so a watch that reports through two routes is not counted twice.
    const health = p.pid === owner ? preferOneSource(await getSamples({ from: now - LEARN_DAYS * 864e5, types: ['workout', 'steps', 'heartRate', 'sleepAnalysis'] }).catch(() => [])) : [];
    const rapidPeak = (RAPID_PROFILES[settings.rapidInsulin] || RAPID_PROFILES.novorapid).peakMin;
    const mine = p.pid === owner;
    const model = await learn(points, events, p.pid, { now, health: mine ? [...health, ...heat] : [], rapidPeak });
    if (!model) {
      await local.set({ [key]: { fittedAt: now, empty: true, readings: points.length } });
      continue;
    }
    // Last night's sleep rides along, so the estimate line knows about a short night.
    model.recentHealth = mine ? [...health.filter((h) => h.type === 'sleepAnalysis' && h.t > now - 36 * 3600e3), ...heat.filter((h) => h.t > now - 3 * 3600e3 && h.t < now + 4 * 3600e3)] : [];
    model.pid = p.pid;
    await local.set({ [key]: model });
    done.push(p.pid);
  }
  return done;
}

// ---- Windows desktop widget, drawn by the pin helper (pin-helper/pin-helper.ps1) ----

const HELPER = 'http://127.0.0.1:47923';

async function pushWidget(settings) {
  if (LEGACY) return;
  let ping;
  try {
    ping = await (await fetch(`${HELPER}/ping`, { cache: 'no-store', signal: AbortSignal.timeout(1500) })).json();
  } catch { return; }   // no helper on this computer
  if (!ping?.widget || !ping.code) return;
  const { accounts = [] } = await local.get('accounts');
  const demo = settings.demo && !accounts.length;
  const people = (await allPatients({ ...settings, demo })).filter((p) => p.latest);
  const now = Date.now();
  const payload = {
    code: ping.code,
    // Which browser is sending: several browsers may feed one widget without overwriting each other.
    sender: await deviceId(),
    show: settings.desktopWidget !== false && !(await retired()),
    people: people.slice(0, 6).map((p) => {
      const series = mergeSeries(p.hist, p.live).filter((q) => q.t >= now - 3 * 3600e3);
      // The reading closest to exactly 15 minutes before, as the mini window measures it.
      const target = p.latest.t - 15 * 60e3;
      const ref = series.filter((q) => Math.abs(q.t - target) <= 4 * 60e3).sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target))[0];
      const u = displayUnits(settings, p);
      const step = Math.max(1, Math.ceil(series.length / 60));
      return {
        name: firstName(p.name),
        mg: p.latest.mg,
        trend: p.latest.trend ?? 0,
        t: p.latest.t,
        low: p.low ?? 70,
        high: p.high ?? 180,
        units: u,
        delta: ref ? `${fmtDelta(p.latest.mg - ref.mg, u)} / 15 min` : '',
        // Same urgent rule as the alarm and the board, so the red frame agrees with them.
        urgent: p.latest.mg < 54 || p.latest.mg <= (settings.alerts?.urgentLow ?? 55),
        spark: series.filter((_, i) => i % step === 0 || i === series.length - 1).map((q) => [q.t, q.mg]),
      };
    }),
  };
  try {
    await fetch(`${HELPER}/widget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) });
  } catch { /* the helper is busy; next minute */ }
}

// ---- Alexa: doses said to Alexa come in, doses logged here go out (once a minute) ----

async function syncVoice(settings) {
  if (LEGACY || !settings.screenLink) return;
  const { voiceAt = 0 } = await chrome.storage.session.get('voiceAt');
  if (Date.now() - voiceAt < 55e3) return;
  await chrome.storage.session.set({ voiceAt: Date.now() });
  try {
    // What to send is read inside the marker queue, and a deleted dose is never sent: not one
    // deleted here, not one deleted on another computer (a tombstone in sync), not one whose
    // deletion is still waiting to reach sync. Every one of those goes out as a deletion.
    const out = await serial(async () => {
      const { events = [], voiceRemoved = [], syncQueue } = await local.get(['events', 'voiceRemoved', 'syncQueue']);
      const since = Date.now() - 48 * 3600e3;
      const recent = events.filter((e) => voiced(e) && e.t >= since && !isDemo(e.p));
      const tomb = await tombstoned(recent).catch(() => new Set());
      const gone = new Set([...voiceRemoved, ...(syncQueue?.remove || []).map((e) => e.id), ...recent.filter((e) => tomb.has(e.id)).map((e) => e.id)]);
      return {
        markers: recent.filter((e) => !gone.has(e.id)).map(({ id, p, t, type, kind, amount, source }) => ({ id, p, t, type, kind, amount, source })),
        removed: [...gone],
      };
    });
    const r = await exchangeDoses(settings.screenLink, out.markers, out.removed, await currentForecasts(settings).catch(() => []));
    await serial(async () => {
      const { events = [], voiceRemoved = [], syncQueue } = await local.get(['events', 'voiceRemoved', 'syncQueue']);
      const sent = new Set(out.removed);
      const have = new Set(events.map((e) => e.id));
      const offered = (r.doses || []).filter((d) => validEvent(d) && (d.type === 'insulin' || d.type === 'meal') && !have.has(d.id));
      // A dose said to Alexa that another computer has already deleted stays deleted here,
      // and the server is told on the next exchange.
      const tomb = offered.length ? await tombstoned(offered).catch(() => new Set()) : new Set();
      const waiting = new Set([...voiceRemoved.filter((id) => !sent.has(id)), ...(syncQueue?.remove || []).map((e) => e.id)]);
      const fresh = offered.filter((d) => !tomb.has(d.id) && !waiting.has(d.id)).map((d) => ({ ...d, source: d.source === 'telegram' || d.source === 'phone' ? d.source : 'alexa' }));
      const stillToTell = [...voiceRemoved.filter((id) => !sent.has(id)), ...offered.filter((d) => tomb.has(d.id)).map((d) => d.id)];
      await local.set({ voiceRemoved: [...new Set(stillToTell)].slice(-500) });
      if (fresh.length) {
        // Inline (already inside the queue): add, then send to the other computers.
        await local.set({ events: [...events, ...fresh].sort((a, b) => a.t - b.t) });
        await sendOut({ upsert: fresh });
      }
    });
    await local.remove('voiceError');
  } catch (e) {
    await local.set({ voiceError: { message: e.message, at: Date.now() } });
  }
}

// The learner's estimate for "Alexa, ask my sugar where I'm heading": numbers only, and only
// when the learner has earned trust (the same check as the estimate line); otherwise only that
// it has not yet.
async function currentForecasts(settings) {
  const now = Date.now();
  const { events = [] } = await local.get('events');
  const out = [];
  for (const p of await allPatients(settings)) {
    if (!p.latest || now - p.latest.t > 15 * 60e3) continue;
    const model = (await local.get(learnedKey(p.pid)))[learnedKey(p.pid)];
    if (!trustworthy(model, now)) { out.push({ p: p.pid, at: p.latest.t, trusted: false }); continue; }
    const pts = [...(p.hist || []), ...(p.live || [])].filter(([t]) => t > p.latest.t - 40 * 60e3).map(([t, mg]) => ({ t, mg }));
    const horizon = Math.min(trustedHorizon(model), 60);
    const f = forecast(pts, events, p.pid, model, { latest: p.latest, horizonMin: horizon, stepMin: 5, health: model.recentHealth || [] });
    if (!f) continue;
    const ahead = (min) => {
      const q = f.points.find((x) => x.t - f.from >= min * 60e3 - 1000);
      return q ? { mg: Math.round(q.mg), lo: Math.round(q.lo), hi: Math.round(q.hi) } : null;
    };
    out.push({ p: p.pid, at: p.latest.t, mg: p.latest.mg, trusted: true, horizon, h30: ahead(30), h60: horizon >= 60 ? ahead(60) : null });
  }
  return out;
}

function plausible(v) {
  return Number.isFinite(v) && v >= 40 && v <= 400;
}

// Recent points for the windows: sorted [time, mg/dL] pairs, de-duplicated within `gap` ms, 24 h max.
function merge(stored, pts, gap, now) {
  const all = [...(stored || []), ...pts.map((p) => [p.t, p.mg])]
    .filter(([t]) => t > now - KEEP_MS && t < now + 5 * 60e3)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of all) {
    if (out.length && p[0] - out[out.length - 1][0] < gap) continue;
    out.push(p);
  }
  return out;
}

async function pollAccount(acc, settings) {
  if (!acc.session) return;
  try {
    const r = await getConnections(acc.session);
    acc.session = r.session;
    const now = Date.now();
    const before = new Set(acc.patientIds || []);
    acc.patientIds = r.connections.map((c) => c.patientId);
    let graphBudget = GRAPH_PER_POLL;

    for (const c of r.connections) {
      const pid = c.patientId;
      const key = ptKey(pid);
      const { [key]: prev = {} } = await local.get(key);
      const latest = toPoint(c.glucoseMeasurement);
      const p = {
        ...prev,
        pid,
        accountId: acc.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || prev.name || 'Unnamed',
        units: unitsOf(c),
        low: plausible(c.targetLow) ? c.targetLow : 70,
        high: plausible(c.targetHigh) ? c.targetHigh : 180,
        sensor: sensorOf(c) || prev.sensor || null,
        latest: latest || prev.latest || null,
        live: latest ? merge(prev.live, [latest], 30e3, now) : prev.live || [],
        hist: prev.hist || [],
        state: { status: 'ok', message: '', at: now },
      };
      if (latest) await saveReadings(pid, [latest], 'live');

      // Keep everything whole: LibreLinkUp's 12-hour history back-fills any gap since the last look.
      const lastLive = prev.live?.length ? prev.live[prev.live.length - 1][0] : 0;
      const gap = latest && latest.t - lastLive > 5 * 60e3;
      if ((!prev.graphAt || now - prev.graphAt > GRAPH_EVERY_MS || gap) && graphBudget > 0) {
        graphBudget--;
        try {
          const g = await getGraph(acc.session, pid);
          acc.session = g.session;
          const pts = g.graphData.map(toPoint).filter(Boolean);
          await saveReadings(pid, pts, 'hist');
          p.hist = merge(p.hist, pts, 60e3, now);
          p.graphAt = now;
          p.sensor = sensorOf(g.connection, g.activeSensors) || p.sensor;
        } catch (e) {
          if (e.code === 'auth') throw e;
        }
      }
      await local.set({ [key]: p });
    }

    const removed = [...before].filter((pid) => !acc.patientIds.includes(pid));
    if (removed.length) await local.remove(removed.map(ptKey));
    acc.state = { status: 'ok', message: '', at: now };
    chrome.notifications.clear(`glucose|signedOut-${acc.id}`);
  } catch (e) {
    const at = Date.now();
    if (e.code === 'auth') {
      acc.session = null;
      acc.state = { status: 'signed-out', message: e.message, at };
    } else {
      acc.state = { status: 'error', message: e.message, at };
    }
    for (const pid of acc.patientIds || []) {
      const key = ptKey(pid);
      const { [key]: p } = await local.get(key);
      if (p) await local.set({ [key]: { ...p, state: acc.state } });
    }
  }
}

// ---- toolbar badge ----

function category(p) {
  const l = p.latest;
  if (!l) return 'none';
  if (Date.now() - l.t > STALE_MS) return 'stale';
  if (l.mg < 54) return 'urgent';
  if (l.mg < (p.low ?? 70)) return 'low';
  if (l.mg > (p.high ?? 180)) return 'high';
  return 'in';
}

const BADGE_COLORS = { urgent: '#b91c1c', low: '#dc2626', high: '#c2700b', stale: '#6e7681', in: '#1f883d', none: '#6e7681' };

async function paintBadge() {
  if (await retired()) {
    await chrome.action.setBadgeText({ text: '→' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6e7681' });
    await chrome.action.setTitle({ title: 'Moved to su94r Mini. You can remove this old copy.' });
    return;
  }
  const settings = await getSettings();
  const { accounts = [] } = await local.get('accounts');
  const demo = settings.demo && !accounts.length;
  const patients = (await allPatients({ ...settings, demo })).filter((p) => p.latest);
  const signedOut = !demo && (accounts.length === 0 || accounts.some((a) => !a.session));

  if (!settings.badge || !patients.length) {
    await chrome.action.setBadgeText({ text: signedOut ? '!' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: signedOut && accounts.length ? '#b91c1c' : '#6e7681' });
    await chrome.action.setTitle({ title: signedOut ? `${NAME} — sign in needed, no glucose alerts until then` : NAME });
    return;
  }

  const line = (p) => {
    const u = displayUnits(settings, p);
    const mins = Math.round((Date.now() - p.latest.t) / 60e3);
    return `${patients.length > 1 ? `${firstName(p.name)}: ` : ''}${fmtGlucose(p.latest.mg, u)} ${u} ${TREND_ARROWS[p.latest.trend ?? 0] || ''}  ·  ${mins <= 0 ? 'just now' : `${mins} min ago`}`;
  };

  let text, color;
  if (signedOut && accounts.length) {
    // A signed-out account means no readings and no alerts for its people: say so first.
    text = '!';
    color = BADGE_COLORS.urgent;
  } else if (patients.length === 1) {
    const p = patients[0];
    text = fmtGlucose(p.latest.mg, displayUnits(settings, p));
    color = BADGE_COLORS[category(p)];
  } else {
    // A ward: the badge counts who needs attention, coloured by the most serious.
    const order = ['urgent', 'low', 'stale', 'high'];
    const flagged = patients.map(category).filter((c) => order.includes(c));
    const worst = order.find((c) => flagged.includes(c));
    text = flagged.length ? String(flagged.length) : '✓';
    color = worst ? BADGE_COLORS[worst] : BADGE_COLORS.in;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: patients.map(line).join('\n') + (signedOut ? '\nAn account is signed out: no readings or alerts for its people until you sign in again.' : '') });
}

// ---- alerts ----

const REPEAT_MIN = { urgentLow: 15, low: 30, high: 60, fallingFast: 30, risingFast: 30, noData: 60 };
// A low stays raised while readings are late: silence is not recovery.
const HOLD_WHEN_STALE = new Set(['urgentLow', 'low']);

async function checkAlerts() {
  const settings = await getSettings();
  const { alertState = {}, accounts = [], accountAlerts = {} } = await local.get(['alertState', 'accounts', 'accountAlerts']);
  if (settings.demo && !accounts.length) return;
  const a = settings.alerts;
  const quiet = Boolean(settings.quietDevices?.[await deviceId()]);
  const patients = await allPatients({ ...settings, demo: false });
  const now = Date.now();
  const many = patients.length > 1;
  let changed = false;

  // Signed-out accounts: every person they cover gets no readings and no alerts. Keep saying so.
  let accountsChanged = false;
  for (const acc of accounts) {
    if (acc.session) {
      if (accountAlerts[acc.id]) { delete accountAlerts[acc.id]; accountsChanged = true; }
      continue;
    }
    if (now - (accountAlerts[acc.id] || 0) < SIGNED_OUT_REPEAT_MS) continue;
    const names = patients.filter((p) => p.accountId === acc.id).map((p) => firstName(p.name)).filter(Boolean);
    await notify(`signedOut-${acc.id}`, {
      title: 'LibreLinkUp signed out — glucose alerts are OFF',
      message: `${acc.label || 'An account'}${names.length ? ` (${names.join(', ')})` : ''}: no new readings or alerts until you sign in again. Click to sign in.`,
    }, { urgent: a.enabled, snooze: false, sticky: true });
    accountAlerts[acc.id] = now;
    accountsChanged = true;
  }
  if (accountsChanged) await local.set({ accountAlerts });

  for (const p of patients) {
    const { latest } = p;
    const units = displayUnits(settings, p);
    const fresh = latest && now - latest.t <= STALE_MS;
    const signedIn = accounts.some((acc) => acc.id === p.accountId && acc.session);
    const who = many ? `${p.name}: ` : '';

    let detail = '';
    if (latest) {
      const ref = mergeSeries(p.hist, p.live).find((q) => Math.abs(q.t - (latest.t - 15 * 60e3)) <= 4 * 60e3);
      detail = `${who}${fmtGlucose(latest.mg, units)} ${units} ${TREND_ARROWS[latest.trend ?? 0] || ''}`.trim()
        + (ref ? `  (${fmtDelta(latest.mg - ref.mg, units)} in 15 min)` : '');
    }

    const on = a.enabled;
    const hits = {
      urgentLow: on && a.urgentLowOn && fresh && latest.mg <= a.urgentLow && { title: `URGENT LOW${many ? ` — ${p.name}` : ''}`, message: detail },
      low: on && a.lowOn && fresh && latest.mg < a.low && !(a.urgentLowOn && latest.mg <= a.urgentLow) && { title: `Low glucose${many ? ` — ${p.name}` : ''}`, message: detail },
      high: on && a.highOn && fresh && latest.mg > a.high && { title: `High glucose${many ? ` — ${p.name}` : ''}`, message: detail },
      fallingFast: on && a.fallingFast && fresh && latest.trend === 1 && { title: `Falling fast${many ? ` — ${p.name}` : ''}`, message: detail },
      risingFast: on && a.risingFast && fresh && latest.trend === 5 && { title: `Rising fast${many ? ` — ${p.name}` : ''}`, message: detail },
      noData: on && a.noData && latest && now - latest.t > 20 * 60e3 && {
        title: `No glucose data${many ? ` — ${p.name}` : ''}`,
        message: signedIn
          ? `${who}no new reading for ${fmtDuration(now - latest.t)}. Check the sensor, the phone and the Libre 3 app.`
          : `${who}no new reading for ${fmtDuration(now - latest.t)}: the LibreLinkUp account is signed out. Sign in again in Settings.`,
      },
    };

    const st = alertState[p.pid] || {};
    for (const [type, hit] of Object.entries(hits)) {
      const s = st[type] || {};
      const id = `${p.pid}|${type}`;
      if (hit) {
        const due = !s.active || now - (s.lastAt || 0) >= REPEAT_MIN[type] * 60e3;
        if (due && now >= (s.snoozeUntil || 0)) {
          // The urgent-low alarm (sticky, loud) only on the computers chosen for it; the
          // others still show the notification, quietly.
          const loud = type === 'urgentLow' && !quiet;
          await notify(id, hit, { urgent: loud, sticky: loud, quietSound: type === 'urgentLow' && quiet, pid: p.pid });
          st[type] = { ...s, active: true, lastAt: now };
          changed = true;
        } else if (!s.active) {
          st[type] = { ...s, active: true };
          changed = true;
        }
      } else if ((s.active || s.snoozeUntil) && !(HOLD_WHEN_STALE.has(type) && !fresh && on)) {
        st[type] = {};
        changed = true;
        chrome.notifications.clear(`glucose|${id}`);
      }
    }

    const ss = sensorStatus(p.sensor, settings.sensorDays, now);
    if (settings.sensorReminder && ss?.kind === 'active' && ss.left < 24 * 3600e3 && st.sensorSn !== p.sensor.sn) {
      await notify(`${p.pid}|sensor`, {
        title: `Sensor ends soon${many ? ` — ${p.name}` : ''}`,
        message: `${who}the sensor ends in about ${fmtDuration(ss.left)}. Have a new one ready.`,
      }, { snooze: false, pid: p.pid });
      st.sensorSn = p.sensor.sn;
      changed = true;
    }
    alertState[p.pid] = st;
  }

  if (changed) await local.set({ alertState });
}

async function notify(id, { title, message }, { urgent = false, snooze = true, sticky = urgent, quietSound = false } = {}) {
  const { alerts } = await getSettings();
  await chrome.notifications.create(`glucose|${id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: urgent ? 2 : 1,
    requireInteraction: sticky,
    // The label follows the alert type (an urgent low snoozes 15 min even on a quiet computer).
    ...(snooze ? { buttons: [{ title: urgent || id.endsWith('|urgentLow') ? 'Snooze 15 min' : 'Snooze 1 hour' }] } : {}),
  });
  if (!quietSound && (alerts.sound === 'all' || (alerts.sound === 'urgent' && urgent))) beep(urgent);
}

async function testAlert() {
  const { alerts } = await getSettings();
  await notify('test', {
    title: 'Test alert',
    message: 'This is how glucose alerts look.' + (alerts.sound === 'off' ? '' : ' You should also hear the alarm sound.'),
  }, { urgent: alerts.sound !== 'off', snooze: false, sticky: false });
}

// Alarm sound plays from an offscreen page (service workers have no audio).
async function beep(urgent) {
  if (!chrome.offscreen) return;
  try {
    if (await chrome.offscreen.hasDocument()) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'beep', urgent });
    } else {
      await chrome.offscreen.createDocument({
        url: `offscreen.html?urgent=${urgent ? 1 : 0}`,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Plays the glucose alarm sound.',
      });
    }
  } catch { /* sound is a bonus; the notification already went out */ }
}

chrome.notifications.onButtonClicked.addListener(async (nid) => {
  const [, pid, type] = nid.split('|');
  if (!pid || !type) return;
  const { alertState = {} } = await local.get('alertState');
  const mins = type === 'urgentLow' ? 15 : 60;
  alertState[pid] = alertState[pid] || {};
  alertState[pid][type] = { ...alertState[pid][type], snoozeUntil: Date.now() + mins * 60e3 };
  await local.set({ alertState });
  chrome.notifications.clear(nid);
});

chrome.notifications.onClicked.addListener((nid) => {
  if (careClicked(nid)) return;
  if (!nid.startsWith('glucose|')) return;
  chrome.notifications.clear(nid);
  const [, pid] = nid.split('|');
  if (pid.startsWith('signedOut')) chrome.runtime.openOptionsPage();
  else if (pid === 'test') openDefault();
  else openWindow(pid);
});

// ---- demo mode: four made-up patients so the windows and the board can be tried ----

const DEMO = [
  { pid: 'demo-1', name: 'Ana Rivera', phase: 0, base: 135 },
  { pid: 'demo-2', name: 'Ben Torres', phase: 1.7, base: 170 },
  { pid: 'demo-3', name: 'Carla Moss', phase: 3.1, base: 95 },
  { pid: 'demo-4', name: 'Dev Patel', phase: 4.4, base: 140, stale: true },
];

function demoValue(t, d = DEMO[0]) {
  const h = t / 3600e3;
  return Math.max(45, Math.round(d.base + 50 * Math.sin((h * 2 * Math.PI) / 5.3 + d.phase)
    + 22 * Math.sin((h * 2 * Math.PI) / 1.4 + 1.3 + d.phase)
    + 6 * Math.sin((h * 2 * Math.PI) / 0.37)));
}

async function clearDemo() {
  const all = await local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('pt:demo-'));
  if (keys.length) await local.remove(keys);
  // Markers made on the demo people are practice; they never leave this computer.
  if ((all.events || []).some((e) => isDemo(e.p))) {
    await serial(async () => {
      const { events = [] } = await local.get('events');
      await local.set({ events: events.filter((e) => !isDemo(e.p)) });
    });
  }
}

async function demoPoll() {
  const now = Math.floor(Date.now() / 60e3) * 60e3;
  const { demoSeeded } = await local.get('demoSeeded');
  const writes = { demoSeeded: now };
  for (const d of DEMO) {
    const end = d.stale ? now - 25 * 60e3 : now;
    const hist = [];
    for (let t = now - KEEP_MS; t <= end - 30 * 60e3; t += 5 * 60e3) hist.push([t, demoValue(t, d)]);
    const live = [];
    for (let t = end - 30 * 60e3; t <= end; t += 60e3) live.push([t, demoValue(t, d)]);
    const slope = (demoValue(end, d) - demoValue(end - 15 * 60e3, d)) / 15;
    const trend = slope < -2 ? 1 : slope < -1 ? 2 : slope <= 1 ? 3 : slope <= 2 ? 4 : 5;
    const week = [];
    for (let t = (demoSeeded || now - 7 * 864e5); t <= end; t += 5 * 60e3) week.push({ t, mg: demoValue(t, d) });
    await saveReadings(d.pid, week, 'hist');
    writes[ptKey(d.pid)] = {
      pid: d.pid, accountId: 'demo', name: d.name, units: 'mg/dL', low: 70, high: 180,
      sensor: { sn: `DEMO${d.pid}`, start: now - (6 + d.phase * 2) * 864e5 },
      latest: { t: end, mg: demoValue(end, d), trend },
      hist, live, state: { status: 'ok', message: 'Demo data', at: Date.now() }, graphAt: now,
    };
  }
  await local.set(writes);
  await paintBadge();
  return pushWidget(await getSettings());
}
