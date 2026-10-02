// Moving from the old "Libre Mini Graph" folder copy to su94r Mini.
//
// A copy loaded from a folder without a fixed key gets an extension ID made from that
// folder's path, and Chrome sync keeps data per extension ID — so two computers whose
// folder paths differ could never share doses. su94r Mini has a fixed key, so it has
// the same ID on every computer. Its storage starts empty: on first run it asks the old
// copy for everything it kept (sign-ins, markers, settings, saved readings) and tells the
// old copy to stand down, so the two never poll or alert side by side.
//
// Order matters: copy, then stop the old copy, then copy its markers again (a dose logged
// in between is not lost), then the readings. Alarm state is not copied, so su94r Mini
// raises any ongoing low again at once instead of waiting out a repeat interval.

import { putRecords, archivedPatients, loadReadings, firstReading } from './archive.js';

export const NEW_ID = 'gcdoahfflgpabebcbhohaklfmpnnggpi';
/** The old copy on the computer this was built on. Old copies elsewhere offer themselves. */
export const KNOWN_OLD_IDS = ['dhjdngipdopgfdijkdpfoggdjdgfaeif'];
export const isLegacy = () => !chrome.runtime.getManifest().key;

const CHUNK_MS = 7 * 864e5;
const NOT_COPIED = ['retired', 'handedOver', 'reopenAfterUpdate', 'justUpdated', 'syncError', 'syncQueue', 'migratedFrom',
  'settingsStamps', 'settingsHandover', 'alertState', 'accountAlerts', 'handoverOffer', 'installedAt', 'voiceRemoved'];

// ---------- the old copy ----------

/** Answers su94r Mini, and only su94r Mini (externally_connectable allows nothing else). */
export function answerHandover({ onRetire }) {
  chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
    if (sender.id !== NEW_ID) return false;
    answer(msg, onRetire).then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  });
}

async function answer(msg, onRetire) {
  if (msg?.type === 'handover-state') {
    // Once handed over, never again: a reinstalled su94r Mini must not replay a stale copy.
    if ((await chrome.storage.local.get('handedOver')).handedOver) return { ok: false, error: 'Already handed over' };
    const state = await chrome.storage.local.get(null);
    for (const k of NOT_COPIED) delete state[k];
    const patients = [];
    for (const pid of await archivedPatients()) patients.push({ pid, first: (await firstReading(pid))?.t ?? null });
    return { ok: true, version: chrome.runtime.getManifest().version, state, patients };
  }
  if (msg?.type === 'handover-readings') {
    return { ok: true, rows: await loadReadings(msg.pid, msg.from, msg.to) };
  }
  if (msg?.type === 'handover-retire') {
    await chrome.storage.local.set({ retired: { to: NEW_ID, at: Date.now() } });
    await onRetire?.();
    return { ok: true };
  }
  if (msg?.type === 'handover-done') {
    await chrome.storage.local.set({ handedOver: Date.now() });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown request' };
}

/** The old copy tells su94r Mini it exists, so Settings can offer the hand-over without typing an ID. */
export async function offerHandover() {
  try { await chrome.runtime.sendMessage(NEW_ID, { type: 'handover-offer' }); } catch { /* su94r Mini not installed */ }
}

// ---------- su94r Mini ----------

const ask = async (id, msg) => {
  try { return await chrome.runtime.sendMessage(id, msg); } catch { return null; }
};

/**
 * Copies everything from the first old copy that answers, never overwriting anything this
 * copy already has, except settings (the old copy's are the user's; a fresh copy only has
 * defaults). Markers and settings are returned for the caller to apply through its own
 * single-writer queue; everything else is written here.
 * Returns { ok, from, events, settings, ... } or { ok: false }.
 */
export async function bringOver(ids = KNOWN_OLD_IDS) {
  for (const id of ids) {
    const first = await ask(id, { type: 'handover-state' });
    if (!first?.ok || !first.state) continue;
    await ask(id, { type: 'handover-retire' });
    // Anything logged in the old copy between the two reads is in the second one.
    const second = await ask(id, { type: 'handover-state' });
    const s = second?.ok ? second.state : first.state;

    const mine = await chrome.storage.local.get(null);
    const writes = {};
    const join = (theirs, ours) => {
      const m = new Map((theirs || []).map((x) => [x.id, x]));
      for (const x of ours || []) m.set(x.id, x);
      return [...m.values()];
    };
    if (s.accounts?.length) writes.accounts = join(s.accounts, mine.accounts);
    for (const k of ['views', 'bounds', 'aiChats']) if (s[k] && typeof s[k] === 'object') writes[k] = { ...(mine[k] || {}), ...s[k] };
    if (s.ai && !mine.ai?.provider) writes.ai = s.ai;
    for (const [k, v] of Object.entries(s)) {
      if (['accounts', 'events', 'settings', 'views', 'bounds', 'aiChats', 'ai'].includes(k)) continue;
      if (!(k in mine)) writes[k] = v;
    }
    await chrome.storage.local.set(writes);

    let readings = 0;
    const now = Date.now();
    for (const { pid, first: from0 } of (second?.patients || first.patients || [])) {
      for (let from = from0 ?? now - 90 * 864e5; from <= now + 864e5; from += CHUNK_MS) {
        const page = await ask(id, { type: 'handover-readings', pid, from, to: from + CHUNK_MS - 1 });
        if (page?.rows?.length) readings += await putRecords(page.rows);
      }
    }
    await ask(id, { type: 'handover-done' });
    return {
      ok: true,
      from: id,
      fromVersion: (second || first).version,
      accounts: s.accounts?.length || 0,
      events: s.events || [],
      settings: s.settings || null,
      readings,
      at: Date.now(),
    };
  }
  return { ok: false };
}
