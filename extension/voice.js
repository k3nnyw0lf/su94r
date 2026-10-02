// Alexa and screens: su94r Mini talks to your own su94r server (the big-screen link from
// docs/tv-and-alexa.md) for two things:
//   - doses said to Alexa come in, and doses logged here go out, so Alexa's double-dose
//     check and every su94r Mini window see the same doses;
//   - screens and widgets (a fridge, a TV, a tablet) are paired by typing their short code.
// The link holds the display key, so it is kept only in this browser's storage and in
// Chrome sync, which is your own Google account.

/** "https://x.workers.dev/d/<key>" → { base, key }, or null. */
export function parseScreenLink(link) {
  try {
    const u = new URL(String(link || '').trim());
    const m = u.pathname.match(/^\/d\/([^/]+)\/?$/);
    if (u.protocol !== 'https:' || !m) return null;
    return { base: u.origin, key: decodeURIComponent(m[1]) };
  } catch {
    return null;
  }
}

async function call(link, path, { method = 'GET', body } = {}) {
  const p = parseScreenLink(link);
  if (!p) throw new Error('Paste the big-screen link first (it looks like https://…/d/…).');
  const res = await fetch(`${p.base}/${path}?key=${encodeURIComponent(p.key)}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `The su94r server answered ${res.status}.`);
  return j;
}

/** Sends recent insulin markers and deletions; returns doses said to Alexa. */
export const exchangeDoses = (link, markers, removed) => call(link, 'voice/sync', { method: 'POST', body: { markers, removed } });
export const claimScreen = (link, code, name) => call(link, 'pair/claim', { method: 'POST', body: { code, name } });
export const listScreens = (link) => call(link, 'screens');
export const removeScreen = (link, id) => call(link, 'screens/remove', { method: 'POST', body: { id } });

// Health inbox: a private address a phone app (HC Webhook) posts to; this computer collects.
export const newInbox = (link, name) => call(link, 'inbox/new', { method: 'POST', body: { name } });
export const removeInbox = (link, id) => call(link, 'inboxes/remove', { method: 'POST', body: { id } });
export const inboxAddress = (link, secret) => `${parseScreenLink(link)?.base}/inbox/${secret}`;
export const inboxBase = (link) => `${parseScreenLink(link)?.base}/inbox`;

// Collecting needs the collector key too (only this computer has it): the address in the
// phone app can add, never read or delete.
const collectHeaders = (secret, key) => ({ 'X-Api-Key': secret, 'X-Collector-Key': key });

/** The items waiting in the inbox (oldest first, a page at a time). */
export async function inboxItems(link, secret, key) {
  const res = await fetch(`${inboxBase(link)}/items`, { headers: collectHeaders(secret, key), cache: 'no-store', signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `The su94r server answered ${res.status}.`);
  return j;
}
/** Tells the server these items are stored here, so it deletes them. */
export async function ackInbox(link, secret, key, ids) {
  const res = await fetch(`${inboxBase(link)}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...collectHeaders(secret, key) }, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`The su94r server answered ${res.status}.`);
}

// AI connector: an address Claude (or another MCP app) reads glucose and doses from.
export const newAiConnector = (link, name) => call(link, 'mcp/new', { method: 'POST', body: { name } });
export const aiAddress = (link, token) => `${parseScreenLink(link)?.base}/mcp/${token}`;

// Watch faces and phone widgets: a Nightscout-style read-only link (server: workers/nightscout.js).
export const newNsLink = (link, name) => call(link, 'ns/new', { method: 'POST', body: { name } });
