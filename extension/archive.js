// Permanent reading archive in IndexedDB, shared by the background worker, the mini window and the
// settings page (all extension pages share one origin). Records: { p: patientId, t: minute, mg, src }.
// src is 'live' (minute reading), 'hist' (LibreLinkUp 12-hour history) or 'import' (LibreView CSV).

const DB_NAME = 'libre-mini';
const STORE = 'readings';
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: ['p', 't'] });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Adds readings without letting coarse history overwrite a live minute reading. Returns how many were new.
export async function saveReadings(patientId, points, src) {
  if (!patientId || !points.length) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let added = 0;
  for (const p of points) {
    const rec = { p: patientId, t: Math.round(p.t / 60e3) * 60e3, mg: Math.round(p.mg), src };
    const get = store.get([rec.p, rec.t]);
    get.onsuccess = () => {
      const old = get.result;
      if (!old) added++;
      if (!old || (src === 'live' && old.src !== 'live')) store.put(rec);
    };
  }
  await done(tx);
  return added;
}

/** Adds archive records as they are ({ p, t, mg, src }), with the same rule: a live reading is never replaced. */
export async function putRecords(records) {
  if (!records?.length) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let added = 0;
  for (const r of records) {
    if (!r?.p || !Number.isFinite(r.t) || !Number.isFinite(r.mg)) continue;
    const rec = { p: r.p, t: r.t, mg: r.mg, src: r.src || 'import' };
    const get = store.get([rec.p, rec.t]);
    get.onsuccess = () => {
      const old = get.result;
      if (!old) added++;
      if (!old || (rec.src === 'live' && old.src !== 'live')) store.put(rec);
    };
  }
  await done(tx);
  return added;
}

/** Every person with saved readings, including people no longer followed. */
export async function archivedPatients() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const ids = [];
  const req = tx.objectStore(STORE).openKeyCursor();
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return;
    ids.push(c.key[0]);
    c.continue([c.key[0], Infinity]);
  };
  await done(tx);
  return ids;
}

export async function loadReadings(patientId, from = 0, to = Date.now() + 864e5) {
  if (!patientId) return [];
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).getAll(IDBKeyRange.bound([patientId, from], [patientId, to]));
  await done(tx);
  return req.result;
}

export async function firstReading(patientId) {
  if (!patientId) return null;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).openCursor(IDBKeyRange.bound([patientId, 0], [patientId, Infinity]));
  let first = null;
  req.onsuccess = () => { first = req.result?.value || null; };
  await done(tx);
  return first;
}

export async function countReadings(patientId) {
  if (!patientId) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).count(IDBKeyRange.bound([patientId, 0], [patientId, Infinity]));
  await done(tx);
  return req.result;
}

export async function clearReadings(patientId) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  if (patientId) tx.objectStore(STORE).delete(IDBKeyRange.bound([patientId, 0], [patientId, Infinity]));
  else tx.objectStore(STORE).clear();
  await done(tx);
}

// Live readings win; history and imports fill only where no live reading is within 3 minutes.
export function wholeSeries(records) {
  const live = records.filter((r) => r.src === 'live');
  const out = live.map((r) => ({ t: r.t, mg: r.mg }));
  let j = 0;
  for (const r of records) {
    if (r.src === 'live') continue;
    while (j < live.length && live[j].t < r.t - 180e3) j++;
    if (j < live.length && live[j].t <= r.t + 180e3) continue;
    out.push({ t: r.t, mg: r.mg });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Gaps longer than `minGap` between consecutive readings, newest first.
export function findGaps(points, minGap = 60 * 60e3, now = Date.now()) {
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > minGap) gaps.push({ from: points[i - 1].t, to: points[i].t });
  }
  if (points.length && now - points[points.length - 1].t > minGap) gaps.push({ from: points[points.length - 1].t, to: now });
  return gaps.reverse();
}

// Share of the time between the first reading and now that has data (each reading covers up to 15 min).
export function coverage(points, now = Date.now()) {
  if (!points.length) return 0;
  let covered = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[i + 1]?.t ?? now;
    covered += Math.min(next - points[i].t, 15 * 60e3);
  }
  return Math.min(1, covered / Math.max(1, now - points[0].t));
}
