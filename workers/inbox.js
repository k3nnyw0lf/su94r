// Health inbox: phone apps that can only send (HC Webhook on Android or iPhone, Health Auto
// Export, an iOS Shortcut) post what they read to a private address. su94r Mini collects it
// into the health vault on the computer, then tells the server to forget it.
//
// Two keys per inbox, both stored only as hashes:
//   • the send key, in the phone app (URL path, X-Api-Key or Authorization: Bearer): it can only add;
//   • the collector key, held only by su94r Mini (X-Collector-Key): it alone reads and deletes.
// So the address kept in a phone app, its logs or its backups can never read anything back.
//
// Tables su94r_inboxes and su94r_inbox_items (migrations 20261002_su94r_inbox.sql and
// 20261002b_su94r_inbox_keys.sql), service role only. Items wait at most 14 days (every post
// and every collection clears older ones, across all inboxes); a removed inbox's items go at once.
//
// Routes (path after the server's base):
//   POST inbox/new?key=DISPLAY_KEY        { name } → { id, secret, key }   su94r Mini makes one
//   GET  inboxes?key=DISPLAY_KEY          list (no secrets)
//   POST inboxes/remove?key=DISPLAY_KEY   { id }
//   POST inbox/<secret> or POST inbox     the phone app (send key in the path or a header)
//   GET  inbox/items                      su94r Mini collects: send key + X-Collector-Key
//   POST inbox/ack                        { ids } su94r Mini has stored these

import { sha256, randomToken } from './screens.js';

const MAX_BYTES = 1024 * 1024;          // one post
const MAX_WAITING = 3000;               // items waiting in one inbox
const MAX_PER_HOUR = 120;               // posts per inbox per hour
const PAGE_BYTES = 3 * 1024 * 1024;     // one collection page
const KEEP_MS = 14 * 864e5;

export function inboxStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const root = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(root && key);
  async function call(table, path, init = {}) {
    if (!ready) throw Object.assign(new Error('The inbox is not configured'), { code: 'config' });
    const res = await fetchImpl(`${root}/${table}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Inbox store answered ${res.status}`);
    if (res.status === 204) return [];
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  const q = encodeURIComponent;
  const minimal = { headers: { Prefer: 'return=minimal' } };
  return {
    ready,
    create: (row) => call('su94r_inboxes', '', { method: 'POST', body: JSON.stringify(row) }),
    bySecret: async (h) => (await call('su94r_inboxes', `?select=*&secret_hash=eq.${q(h)}&revoked=is.false`))[0] || null,
    list: () => call('su94r_inboxes', '?select=id,name,created_at,last_post_at&revoked=is.false&order=created_at.asc'),
    revoke: (id) => call('su94r_inboxes', `?id=eq.${q(id)}`, { method: 'PATCH', body: JSON.stringify({ revoked: true }) }),
    touch: (id) => call('su94r_inboxes', `?id=eq.${q(id)}`, { method: 'PATCH', body: JSON.stringify({ last_post_at: new Date().toISOString() }), ...minimal }),
    add: (inboxId, body) => call('su94r_inbox_items', '', { method: 'POST', body: JSON.stringify({ inbox_id: inboxId, body }), ...minimal }),
    count: async (inboxId) => (await call('su94r_inbox_items', `?select=id&inbox_id=eq.${q(inboxId)}&limit=${MAX_WAITING}`)).length,
    countSince: async (inboxId, since) => (await call('su94r_inbox_items', `?select=id&inbox_id=eq.${q(inboxId)}&received_at=gt.${q(new Date(since).toISOString())}&limit=${MAX_PER_HOUR + 1}`)).length,
    items: (inboxId, limit) => call('su94r_inbox_items', `?select=id,received_at,body&inbox_id=eq.${q(inboxId)}&order=id.asc&limit=${limit}`),
    dropIds: (inboxId, ids) => call('su94r_inbox_items', `?inbox_id=eq.${q(inboxId)}&id=in.(${ids.map(Number).filter(Number.isFinite).join(',')})`, { method: 'DELETE', ...minimal }),
    dropAll: (inboxId) => call('su94r_inbox_items', `?inbox_id=eq.${q(inboxId)}`, { method: 'DELETE', ...minimal }),
    expireAll: () => call('su94r_inbox_items', `?received_at=lt.${q(new Date(Date.now() - KEEP_MS).toISOString())}`, { method: 'DELETE', ...minimal }),
  };
}

const clean = (s, max = 40) => String(s || '').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, max);
const HEX64 = /^[0-9a-f]{64}$/;

/** The send key from the path (inbox/<secret>[/...]) or the X-Api-Key / Bearer header. */
function secretOf(request, parts) {
  if (parts[1] && HEX64.test(parts[1])) return parts[1];
  const header = (request.headers.get('x-api-key') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();
  return HEX64.test(header) ? header : null;
}

/**
 * Handles every inbox route. `json` builds responses; `keyOk(key)` checks the display key.
 * Returns null when the path is not an inbox route.
 */
export async function inboxRoute(path, request, url, env, { store, json, keyOk }) {
  const parts = path.split('/');
  if (parts[0] !== 'inbox' && parts[0] !== 'inboxes') return null;
  if (!store.ready) return json({ error: 'The inbox is not configured' }, 503);

  // Management: needs the display key.
  if (path === 'inbox/new' || parts[0] === 'inboxes') {
    if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
    if (path === 'inbox/new' && request.method === 'POST') {
      const { name } = await request.json().catch(() => ({}));
      const secret = randomToken();
      const collect = randomToken();
      const id = crypto.randomUUID();
      await store.create({ id, secret_hash: await sha256(secret), collect_hash: await sha256(collect), name: clean(name) || 'Phone' });
      return json({ id, secret, key: collect, name: clean(name) || 'Phone' });
    }
    if (path === 'inboxes') return json({ inboxes: await store.list() });
    if (path === 'inboxes/remove' && request.method === 'POST') {
      const { id } = await request.json().catch(() => ({}));
      if (!id) return json({ error: 'id needed' }, 400);
      await store.revoke(String(id));
      await store.dropAll(String(id));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  const secret = secretOf(request, parts);
  if (!secret) return json({ error: 'unauthorized' }, 401);
  const box = await store.bySecret(await sha256(secret));
  if (!box) return json({ error: 'unauthorized' }, 401);
  const action = parts[1] === secret ? parts[2] || '' : parts[1] || '';

  // The phone app: add only.
  if (!action && request.method === 'POST') {
    const declared = Number(request.headers.get('content-length'));
    if (declared > MAX_BYTES) return json({ error: 'too large' }, 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return json({ error: 'too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'expected JSON' }, 400); }
    await store.expireAll().catch(() => {});
    if ((await store.countSince(box.id, Date.now() - 3600e3).catch(() => 0)) >= MAX_PER_HOUR) return json({ error: 'too many posts this hour' }, 429);
    if ((await store.count(box.id).catch(() => 0)) >= MAX_WAITING) return json({ error: 'inbox full: open su94r Mini to collect' }, 429);
    await store.add(box.id, body);
    store.touch(box.id).catch(() => {});
    return json({ ok: true });
  }

  // Collecting and deleting need the collector key as well.
  const collector = (request.headers.get('x-collector-key') || '').trim();
  if (!HEX64.test(collector) || !box.collect_hash || (await sha256(collector)) !== box.collect_hash) return json({ error: 'unauthorized' }, 401);
  if (action === 'items' && request.method === 'GET') {
    await store.expireAll().catch(() => {});
    const rows = await store.items(box.id, 50);
    // Pages stop at about 3 MB (at least one item), so one big post never blocks the rest.
    const items = [];
    let bytes = 0;
    for (const r of rows) {
      const size = JSON.stringify(r.body).length;
      if (items.length && bytes + size > PAGE_BYTES) break;
      items.push({ id: r.id, at: Date.parse(r.received_at), body: r.body });
      bytes += size;
    }
    return json({ items, more: items.length < rows.length || rows.length === 50 });
  }
  if (action === 'ack' && request.method === 'POST') {
    const { ids } = await request.json().catch(() => ({}));
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!list.length) return json({ error: 'ids needed' }, 400);
    await store.dropIds(box.id, list);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}
