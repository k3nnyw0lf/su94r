import { login, getConnections, getGraph, toPoint, unitsOf, sensorOf, LibreError } from './libre.js';
import { withDefaults, displayUnits, fmtGlucose, fmtDelta, TREND_ARROWS, mergeSeries, sensorStatus, fmtDuration } from './glucose.js';
import { saveReadings } from './archive.js';
import { ptKey, allPatients, firstName, isDemo } from './store.js';
import {
  heartbeat, pushEvents, mergeDays, changedDays, syncedDays, pruneOld, tombstoned, utcDay, KEEP_DAYS,
  pushSettings, mergeSettings, stampChanges, syncedShared, SHARED_SETTINGS,
} from './sync.js';
import { isLegacy, answerHandover, bringOver, offerHandover, KNOWN_OLD_IDS } from './handover.js';

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
    addEvents: () => addEvents(msg.events),
    removeEvents: () => removeEvents(msg.ids),
    bringOver: () => (LEGACY ? { ok: false } : takeOverOldCopy(msg.id ? [msg.id] : KNOWN_OLD_IDS)),
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

function addEvents(list) {
  return serial(async () => {
    const valid = (Array.isArray(list) ? list : []).filter(validEvent);
    const { events = [] } = await local.get('events');
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const e of valid) byId.set(e.id, e);
    await local.set({ events: [...byId.values()].sort((a, b) => a.t - b.t) });
    await sendOut({ upsert: valid });
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
    if (next) await local.set({ events: next });
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
  return paintBadge();
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
          await notify(id, hit, { urgent: type === 'urgentLow', pid: p.pid });
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

async function notify(id, { title, message }, { urgent = false, snooze = true, sticky = urgent } = {}) {
  const { alerts } = await getSettings();
  await chrome.notifications.create(`glucose|${id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: urgent ? 2 : 1,
    requireInteraction: sticky,
    ...(snooze ? { buttons: [{ title: urgent ? 'Snooze 15 min' : 'Snooze 1 hour' }] } : {}),
  });
  if (alerts.sound === 'all' || (alerts.sound === 'urgent' && urgent)) beep(urgent);
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
  return paintBadge();
}
