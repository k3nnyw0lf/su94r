// Connecting su94r Mini to its su94r server without pasting anything.
//
// su94r Mini sends the LibreLinkUp session it already has. The server checks it with
// LibreLinkUp itself (a session only works with its own account), then:
//   • the first time, binds the server to that LibreLinkUp account — only while the owner has
//     opened a short window for it (CLAIM_OPEN_UNTIL, a time set from the setup), so nobody
//     else can claim a fresh server;
//   • afterwards, accepts only that same account (any computer signed in to it);
//   • keeps the newest session, so the server can read LibreLinkUp without a stored password;
//   • gives su94r Mini its own key (kept like a paired screen, kind 'owner', hash only), which
//     stands in for the display key everywhere.
//
// Table public.su94r_owner (migration 20261002c_su94r_owner.sql), service role only.
//
// Routes:
//   GET  connect/status                 what is set up (no secrets)
//   POST connect                        { session, name } → { key }
//   POST connect/session?key=<key>      { session } keeps the server's LibreLinkUp session fresh
//   POST owner/rotate?key=<key>         a new key for this su94r Mini (the old one still works)
//   POST owner/rotate/done?key=<new>    { old: sha256(old key) } the old key stops working
//
// Changing the key takes two steps so su94r Mini is never locked out: it saves the new key
// first, proves it holds it, and only then is the old one turned off.

import { sha256, randomToken } from './screens.js';

export function ownerStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_owner`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('The owner store is not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Owner store answered ${res.status}`);
    if (res.status === 204) return [];
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  return {
    ready,
    get: async () => (await call('?select=*&id=eq.1'))[0] || null,
    claim: (accountId, session) => call('', { method: 'POST', body: JSON.stringify({ id: 1, account_id: accountId, session, updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } }),
    saveSession: (session) => call('?id=eq.1', { method: 'PATCH', body: JSON.stringify({ session, updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } }),
  };
}

const clean = (s, max = 40) => String(s || '').replace(/[^\p{L}\p{N} '.()-]/gu, '').trim().slice(0, max);

/** A LibreLinkUp session as su94r Mini keeps it; null if it is not shaped like one. */
function sessionOf(body) {
  const s = body?.session;
  if (!s || typeof s !== 'object') return null;
  const okBase = /^https:\/\/api(-[a-z0-9]+)?\.libreview\.io$/.test(String(s.base || ''));
  if (!okBase || typeof s.token !== 'string' || s.token.length < 20 || !/^[0-9a-f]{64}$/.test(String(s.accountId || ''))) return null;
  return { base: s.base, token: s.token, accountId: s.accountId, version: String(s.version || ''), expires: Number(s.expires) || null, userId: s.userId ? String(s.userId) : undefined };
}

/**
 * connect/* routes; null when the path is not one. `verify(session)` asks LibreLinkUp for the
 * session's connections and returns { connections, session } (the session possibly refreshed).
 */
export async function connectRoute(path, request, url, env, { owner, screens, json, verify, keyOk, onSession }) {
  if (path !== 'connect' && !path.startsWith('connect/')) return null;
  if (!owner.ready || !screens.ready) return json({ error: 'not configured' }, 503);
  const open = Number(env.CLAIM_OPEN_UNTIL) > Date.now();

  if (path === 'connect/status') {
    const row = await owner.get().catch(() => null);
    return json({
      owner: Boolean(row),
      llu: env.LLU_EMAIL && env.LLU_PASSWORD ? 'login' : row?.session?.token ? 'session' : 'none',
      alexa: Boolean(env.ALEXA_SKILL_ID),
      open,
    });
  }

  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const body = await request.json().catch(() => ({}));
  const session = sessionOf(body);
  if (!session) return json({ error: 'bad-session', message: 'su94r Mini did not send a LibreLinkUp sign-in. Sign in to LibreLinkUp in su94r Mini first.' }, 400);

  if (path === 'connect/session') {
    if (!(await keyOk(url.searchParams.get('key')))) return json({ error: 'unauthorized' }, 401);
    const row = await owner.get();
    if (!row || row.account_id !== session.accountId) return json({ error: 'other-account' }, 403);
    let checked;
    try { checked = await verify(session); } catch { return json({ error: 'bad-session' }, 401); }
    await owner.saveSession(checked.session);
    onSession?.(checked.session);
    return json({ ok: true });
  }

  if (path !== 'connect') return json({ error: 'not found' }, 404);
  // Refuse before touching the sign-in: a server that is closed, or belongs to another
  // account, never uses someone else's LibreLinkUp session, not even to check it.
  const row = await owner.get();
  if (!row && !open) return json({ error: 'closed', message: 'This su94r server is not open for its first connection. Its owner opens it for 15 minutes during setup.' }, 403);
  if (row && row.account_id !== session.accountId) {
    return json({ error: 'other-account', message: 'This su94r server belongs to another LibreLinkUp account. Sign in to su94r Mini with the same LibreLinkUp account as the server.' }, 403);
  }
  let checked;
  try {
    checked = await verify(session);
  } catch (e) {
    return json({ error: 'bad-session', message: 'LibreLinkUp did not accept that sign-in. Sign in to LibreLinkUp again in su94r Mini, then connect.' }, 401);
  }
  if (!checked.connections.length) return json({ error: 'no-people', message: 'That LibreLinkUp account does not follow anyone yet.' }, 400);
  if (!row) await owner.claim(session.accountId, checked.session);
  else await owner.saveSession(checked.session);
  onSession?.(checked.session);
  const key = randomToken();
  const now = new Date().toISOString();
  const name = clean(body.name) || 'su94r Mini';
  await screens.insert({ id: crypto.randomUUID(), secret_hash: await sha256(randomToken()), token_hash: await sha256(key), kind: 'owner', name, expires_at: now, claimed_at: now });
  return json({ key, name, people: checked.connections.length, alexa: Boolean(env.ALEXA_SKILL_ID) });
}

/** Whether `key` is an owner key (a connected su94r Mini). */
export async function isOwnerKey(screens, key) {
  if (!screens?.ready || !/^[0-9a-f]{64}$/.test(String(key || ''))) return false;
  const row = await screens.byToken(await sha256(key)).catch(() => null);
  if (!row || row.kind !== 'owner') return false;
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 60e3) screens.update(row.id, { last_seen: new Date().toISOString() }).catch(() => {});
  return true;
}

/**
 * owner/rotate and owner/rotate/done; null when the path is not one. Only a su94r Mini key can
 * change itself (the DISPLAY_KEY set on the server is changed there, not here).
 */
export async function rotateRoute(path, request, url, { screens, json }) {
  if (path !== 'owner/rotate' && path !== 'owner/rotate/done') return null;
  if (!screens.ready) return json({ error: 'not configured' }, 503);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const key = url.searchParams.get('key');
  if (!(await isOwnerKey(screens, key))) return json({ error: 'unauthorized' }, 401);
  const row = await screens.byToken(await sha256(key));
  if (path === 'owner/rotate') {
    const fresh = randomToken();
    const now = new Date().toISOString();
    await screens.insert({ id: crypto.randomUUID(), secret_hash: await sha256(randomToken()), token_hash: await sha256(fresh), kind: 'owner', name: row.name || 'su94r Mini', expires_at: now, claimed_at: now });
    return json({ key: fresh });
  }
  const body = await request.json().catch(() => ({}));
  const old = String(body.old || '');
  if (!/^[0-9a-f]{64}$/.test(old) || old === row.token_hash) return json({ error: 'old key hash needed' }, 400);
  const was = await screens.byToken(old).catch(() => null);
  const isOwner = Boolean(was && was.kind === 'owner');
  if (isOwner) await screens.update(was.id, { revoked: true });
  return json({ ok: true, revoked: isOwner });
}
