// Keeps every computer in step through Chrome's own sync (chrome.storage.sync):
// the same Google account, Chrome sync on, nothing else to set up.
//
// Synced: markers and doses (so the double-dose warning on one PC knows about a
// dose logged on another), the medicine list and the shared settings, and a
// small record per device so Settings can list where the extension runs.
// Not synced: glucose history (each device fetches it from LibreLinkUp, and it is
// far bigger than Chrome sync allows) and LibreLinkUp sign-ins (each device
// signs in once; tokens stay on the device).
//
// Chrome sync limits: 100 KB in total, 8 KB per item, 512 items, 120 writes per
// minute. Markers live in one item per UTC day ("ev:YYYY-MM-DD"), with overflow
// parts ("ev:YYYY-MM-DD.1" …) when a busy day does not fit in 8 KB. Deletions are
// tombstones in the day's first item. A tombstone is written only when someone
// deletes a marker; it is never inferred from two versions of a list, so a race
// between windows can lose nothing on the other computers.

const sync = chrome.storage.sync;
const local = chrome.storage.local;

export const KEEP_DAYS = 30;          // enough for the dose guard, active insulin and recent patterns
const PART_LIMIT = 7900;              // bytes per item, under Chrome's 8,192 (key included)
const MAX_PARTS = 8;
const QUOTA = sync.QUOTA_BYTES || 102400;
const DAY_MS = 864e5;

/** Settings every computer shares. Alert on/off and sound stay per computer. */
export const SHARED_SETTINGS = ['alerts', 'meds', 'units', 'rapidInsulin', 'sensorDays', 'sensorReminder', 'projection', 'quietDevices', 'screenLink', 'supplies', 'place', 'heatNote', 'googleClientId', 'keyRotatedAt'];
const PER_DEVICE_ALERT_KEYS = ['enabled', 'sound'];

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const isDemoEvent = (e) => String(e?.p || '').startsWith('demo-');
const compact = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v != null && v !== ''));
const size = (key, value) => key.length + JSON.stringify(value).length;

// ---------- devices ----------

export async function deviceId() {
  const { deviceId: id } = await local.get('deviceId');
  if (id) return id;
  const fresh = crypto.randomUUID();
  await local.set({ deviceId: fresh });
  return fresh;
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (brands.some((b) => /Edge/i.test(b))) return 'Edge';
  if (brands.some((b) => /Chrome/i.test(b))) return 'Chrome';
  return /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
}

/** Writes this device's record (name, browser, version, last seen). Throttled to every 15 min. */
export async function heartbeat(settings, peopleCount, { force = false } = {}) {
  const id = await deviceId();
  const { lastHeartbeat = 0 } = await chrome.storage.session.get('lastHeartbeat');
  if (!force && Date.now() - lastHeartbeat < 15 * 60e3) return;
  await chrome.storage.session.set({ lastHeartbeat: Date.now() });
  const platform = navigator.userAgentData?.platform || 'Windows';
  await guardedSet({
    [`dev:${id}`]: {
      name: settings.deviceName || `${platform} PC`,
      browser: browserName(),
      platform,
      version: chrome.runtime.getManifest().version,
      people: peopleCount,
      lastSeen: Date.now(),
    },
  });
}

export async function listDevices() {
  const all = await sync.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('dev:'))
    .map(([k, v]) => ({ id: k.slice(4), ...v }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function forgetDevice(id) {
  await sync.remove(`dev:${id}`);
}

// ---------- quota ----------

/** Drops the oldest day items until sync storage is below `target` of its quota. */
async function makeRoom(target = 0.7) {
  let used = await sync.getBytesInUse(null);
  if (used <= QUOTA * target) return;
  const all = await sync.get(null);
  const days = [...new Set(Object.keys(all).filter((k) => k.startsWith('ev:')).map((k) => k.slice(3, 13)))].sort();
  for (const day of days) {
    if (used <= QUOTA * target) break;
    const keys = Object.keys(all).filter((k) => k.startsWith(`ev:${day}`));
    used -= keys.reduce((n, k) => n + size(k, all[k]), 0);
    await sync.remove(keys);
  }
}

/** sync.set that makes room and retries once on a quota error, and records failures for Settings. */
async function guardedSet(items) {
  try {
    if (await sync.getBytesInUse(null) > QUOTA * 0.85) await makeRoom();
    await sync.set(items);
  } catch (e) {
    if (!/quota/i.test(String(e?.message))) throw e;
    await makeRoom(0.5);
    await sync.set(items);
  }
}

async function recordSync(error) {
  const { syncError } = await local.get('syncError');
  if (error) await local.set({ syncError: { message: String(error.message || error), at: Date.now() } });
  else if (syncError) await local.remove('syncError');
}

// ---------- markers ----------

const partKeys = (day) => [`ev:${day}`, ...Array.from({ length: MAX_PARTS - 1 }, (_, i) => `ev:${day}.${i + 1}`)];

async function readDay(day) {
  const keys = partKeys(day);
  const got = await sync.get(keys);
  const events = keys.flatMap((k) => got[k]?.e || []);
  return { events, tomb: new Set(got[keys[0]]?.x || []), present: keys.filter((k) => got[k]) };
}

/** Writes one day as few parts as fit; tombstones ride in the first part. */
async function writeDay(day, events, tomb, present) {
  const keys = partKeys(day);
  const sorted = [...events].sort((a, b) => a.t - b.t).map(compact);
  const parts = [{ e: [], x: [...tomb] }];
  for (const e of sorted) {
    const cur = parts[parts.length - 1];
    cur.e.push(e);
    if (size(keys[parts.length - 1], cur) > PART_LIMIT) {
      cur.e.pop();
      if (parts.length === MAX_PARTS) throw new Error(`Too many markers on ${day} to sync`);
      parts.push({ e: [e] });
    }
  }
  if (size(keys[0], parts[0]) > PART_LIMIT) {
    // Thousands of deletions on one day: keep the newest tombstones that fit.
    while (parts[0].x.length && size(keys[0], parts[0]) > PART_LIMIT) parts[0].x.shift();
  }
  const writes = Object.fromEntries(parts.map((p, i) => [keys[i], p]));
  if (!sorted.length && !tomb.size) {
    if (present.length) await sync.remove(present);
    return;
  }
  await guardedSet(writes);
  const stale = present.filter((k) => !(k in writes));
  if (stale.length) await sync.remove(stale);
}

/**
 * Sends marker changes made on this computer: `upsert` are added markers, `remove` are
 * markers the user deleted. A deletion always wins: a marker whose id carries a tombstone
 * is never put back, whoever sends it (an undo creates a new id instead), so a stale copy
 * of a list can never bring a deleted dose back.
 */
export async function pushEvents({ upsert = [], remove = [] } = {}) {
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  const ups = upsert.filter((e) => e?.id && !isDemoEvent(e) && e.t >= cutoff);
  const rms = remove.filter((e) => e?.id && !isDemoEvent(e) && e.t >= cutoff);
  const days = new Set([...ups, ...rms].map((e) => utcDay(e.t)));
  try {
    for (const day of days) {
      const { events, tomb, present } = await readDay(day);
      const byId = new Map(events.map((e) => [e.id, e]));
      for (const e of rms) if (utcDay(e.t) === day) { byId.delete(e.id); tomb.add(e.id); }
      for (const e of ups) if (utcDay(e.t) === day && !tomb.has(e.id)) byId.set(e.id, e);
      await writeDay(day, [...byId.values()], tomb, present);
    }
    await recordSync(null);
    return true;
  } catch (e) {
    await recordSync(e);
    return false;
  }
}

/**
 * Brings the markers from the given days into a local list. Local markers not yet synced
 * are kept, and changes still waiting to be sent (`pending`: { add: Set, remove: Set } of
 * ids) win. Returns { events, missing }: `events` is the new list (null when nothing
 * changed); `missing` are local markers of those days that sync does not hold and nobody
 * deleted — lost when two computers wrote the same day at once — to be sent again.
 */
export async function mergeDays(days, events, pending = {}) {
  const add = pending.add || new Set();
  const remove = pending.remove || new Set();
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  const read = await Promise.all(days.map(readDay));
  // Tombstones from every day read apply to every marker: a deletion stored under one day
  // still removes a copy kept under another (older items used local dates).
  const tomb = new Set(read.flatMap((d) => [...d.tomb]));
  const remoteIds = new Set(read.flatMap((d) => d.events.map((e) => e.id)));
  const byId = new Map(events.map((e) => [e.id, e]));
  let dirty = false;
  for (const id of tomb) if (byId.delete(id)) dirty = true;
  for (const e of read.flatMap((d) => d.events)) {
    if (remove.has(e.id) || tomb.has(e.id)) continue;
    const mine = byId.get(e.id);
    if (!mine || JSON.stringify(compact(mine)) !== JSON.stringify(e)) {
      byId.set(e.id, { ...mine, ...e });
      dirty = true;
    }
  }
  const daySet = new Set(days);
  const missing = [...byId.values()].filter((e) => daySet.has(utcDay(e.t)) && e.t >= cutoff && !isDemoEvent(e)
    && !remoteIds.has(e.id) && !tomb.has(e.id) && !add.has(e.id) && !remove.has(e.id));
  return { events: dirty ? [...byId.values()].sort((a, b) => a.t - b.t) : null, missing };
}

/** Ids among `events` that another computer deleted (tombstoned in their day items). */
export async function tombstoned(events) {
  const days = [...new Set(events.map((e) => utcDay(e.t)))];
  const read = await Promise.all(days.map(readDay));
  return new Set(read.flatMap((d) => [...d.tomb]));
}

/** Days touched by a sync change event. */
export const changedDays = (changes) =>
  [...new Set(Object.keys(changes).filter((k) => k.startsWith('ev:')).map((k) => k.slice(3, 13)))];

/** Every day currently in sync storage (first run on a device). */
export async function syncedDays() {
  const all = await sync.get(null);
  return [...new Set(Object.keys(all).filter((k) => k.startsWith('ev:')).map((k) => k.slice(3, 13)))];
}

// Drops day items older than the keep window.
export async function pruneOld() {
  const all = await sync.get(null);
  const cutoff = utcDay(Date.now() - KEEP_DAYS * DAY_MS);
  const old = Object.keys(all).filter((k) => k.startsWith('ev:') && k.slice(3, 13) < cutoff);
  if (old.length) await sync.remove(old);
  await makeRoom(0.85);
}

// ---------- shared settings ----------
// One value and one timestamp per setting, so a computer that was off for a week
// cannot undo a change made elsewhere: the newer change of each setting wins.

function sharedValue(settings, key) {
  const v = settings[key];
  if (key !== 'alerts' || !v) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !PER_DEVICE_ALERT_KEYS.includes(k)));
}

/** Stamps the shared settings that differ between two local versions. */
export function stampChanges(oldSettings = {}, newSettings = {}, stamps = {}, now = Date.now()) {
  const next = { ...stamps };
  let changed = false;
  for (const k of SHARED_SETTINGS) {
    if (JSON.stringify(sharedValue(oldSettings, k)) !== JSON.stringify(sharedValue(newSettings, k))) {
      next[k] = now;
      changed = true;
    }
  }
  return changed ? next : null;
}

/** Publishes local shared settings that are newer than what sync holds. */
export async function pushSettings(settings, stamps = {}) {
  const { shared } = await sync.get('shared');
  const cur = shared?.v && shared?.t ? shared : { v: {}, t: {} };
  const next = { v: { ...cur.v }, t: { ...cur.t } };
  let changed = false;
  for (const k of SHARED_SETTINGS) {
    if ((stamps[k] || 0) > (cur.t[k] || 0)) {
      next.v[k] = sharedValue(settings, k);
      next.t[k] = stamps[k];
      changed = true;
    }
  }
  if (changed) await guardedSet({ shared: next });
}

/**
 * Applies shared settings from another computer where they are newer than the
 * local change. Returns { settings, stamps } or null when nothing changed.
 */
export function mergeSettings(localSettings, stamps = {}, incoming) {
  if (!incoming?.v || !incoming?.t) return null;
  const next = { ...localSettings };
  const nextStamps = { ...stamps };
  let changed = false;
  for (const k of SHARED_SETTINGS) {
    if (incoming.v[k] === undefined || (incoming.t[k] || 0) <= (stamps[k] || 0)) continue;
    const value = k === 'alerts'
      ? { ...incoming.v.alerts, ...Object.fromEntries(PER_DEVICE_ALERT_KEYS.map((a) => [a, localSettings.alerts?.[a]]).filter(([, v]) => v !== undefined)) }
      : incoming.v[k];
    nextStamps[k] = incoming.t[k];
    if (JSON.stringify(next[k]) !== JSON.stringify(value)) {
      next[k] = value;
      changed = true;
    }
  }
  return changed || JSON.stringify(nextStamps) !== JSON.stringify(stamps) ? { settings: next, stamps: nextStamps } : null;
}

export async function syncedShared() {
  const { shared } = await sync.get('shared');
  return shared || null;
}
