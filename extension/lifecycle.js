// When the extension is reloaded or updated, pages that were already open can keep
// running while every chrome.* call throws "Extension context invalidated". Notice that
// and reload the page into the current version instead of failing silently.

const INVALIDATED = /Extension context invalidated/i;

export const contextAlive = () => Boolean(globalThis.chrome?.runtime?.id);
export const isInvalidated = (err) => INVALIDATED.test(String(err?.message || err));

let reloading = false;
export function reloadIntoCurrentVersion() {
  if (reloading) return;
  reloading = true;
  try { location.reload(); } catch { /* the page is going away anyway */ }
}

export function watchContext() {
  if (!globalThis.chrome?.runtime) return;   // design preview outside the extension
  setInterval(() => { if (!contextAlive()) reloadIntoCurrentVersion(); }, 3000);
  addEventListener('unhandledrejection', (e) => { if (isInvalidated(e.reason)) reloadIntoCurrentVersion(); });
  addEventListener('error', (e) => { if (isInvalidated(e.message)) reloadIntoCurrentVersion(); });
}

// Entries typed in the moment the context was lost are kept in this page origin's own
// localStorage (which still works then) and saved by the reloaded page.
const PENDING = 'libreMiniPendingEvents';

export function stashPending(event) {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING) || '[]');
    list.push(event);
    localStorage.setItem(PENDING, JSON.stringify(list));
  } catch { /* storage blocked: nothing more we can do here */ }
}

export function takePending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING) || '[]');
    localStorage.removeItem(PENDING);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
