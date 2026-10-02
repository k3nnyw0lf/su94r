// Storage layout shared by every extension page.
//   accounts         [{ id, label, session, state, patientIds }]   one per LibreLinkUp login
//   pt:<patientId>   { pid, accountId, name, units, low, high, sensor, latest, hist, live, state, graphAt }
//   views            { [patientId]: { hours, tiny, normalSize, onTop } }  per-window choices
//   settings         global settings (glucose.js DEFAULT_SETTINGS)
//   events           [{ id, p: patientId, t, type, amount?, note? }]
//   alertState       { [patientId]: { [alertType]: { active, lastAt, snoozeUntil } }, sensor: {...} }
//   learned:<pid>    the learner's model for that person (learner.js), refreshed every few hours

export const ptKey = (pid) => `pt:${pid}`;
/** learned:<patientId> holds what the learner worked out for that person (learner.js). */
export const learnedKey = (pid) => `learned:${pid}`;
export const isDemo = (pid) => String(pid).startsWith('demo-');

export async function allPatients(settings) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith('pt:') && v?.pid)
    .map(([, v]) => v)
    .filter((p) => (settings?.demo ? isDemo(p.pid) : !isDemo(p.pid)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export const VIEW_DEFAULTS = { hours: 3, tiny: false, normalSize: null, onTop: false };

export async function getView(pid) {
  const { views = {} } = await chrome.storage.local.get('views');
  return { ...VIEW_DEFAULTS, ...(views[pid] || {}) };
}

export async function saveView(pid, patch) {
  const { views = {} } = await chrome.storage.local.get('views');
  views[pid] = { ...VIEW_DEFAULTS, ...(views[pid] || {}), ...patch };
  await chrome.storage.local.set({ views });
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}
