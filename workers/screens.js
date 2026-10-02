// Screens and widgets (a fridge, a TV, a tablet, a widget on a phone) without typing a long
// link: the screen opens su94r.com/tv and shows a short code, you type the code once in
// su94r Mini, and the screen gets its own token. Each screen can be named and removed.
//
// Table public.su94r_screens (supabase/migrations/20261001_su94r_screens.sql), service role only.
// Only hashes of the screen's secret and token are stored; the token itself is held just
// long enough for the screen to collect it once.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const CODE_TTL_MS = 15 * 60e3;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
export const randomToken = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export function randomCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  const c = [...r].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}
/** "k7q 4md" → "K7Q-4MD"; null unless it is 6 characters from the code alphabet. */
export const normalCode = (s) => {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === 6 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? `${c.slice(0, 3)}-${c.slice(3)}` : null;
};

export function screenStore(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = env.SUPABASE_URL && `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/su94r_screens`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ready = Boolean(base && key);
  async function call(path, init = {}) {
    if (!ready) throw Object.assign(new Error('Screens are not configured'), { code: 'config' });
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Screens store answered ${res.status}`);
    return res.status === 204 ? [] : res.json();
  }
  const q = encodeURIComponent;
  return {
    ready,
    insert: (row) => call('', { method: 'POST', body: JSON.stringify(row) }),
    bySecret: async (h) => (await call(`?select=*&secret_hash=eq.${q(h)}&revoked=is.false`))[0] || null,
    byCode: async (code) => (await call(`?select=*&code=eq.${q(code)}&claimed_at=is.null&revoked=is.false&expires_at=gt.${q(new Date().toISOString())}`))[0] || null,
    byToken: async (h) => (await call(`?select=*&token_hash=eq.${q(h)}&revoked=is.false`))[0] || null,
    update: (id, patch) => call(`?id=eq.${q(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    /** Claims a row only if nobody has yet; true when this call won. */
    claimIfOpen: async (id, patch) => (await call(`?id=eq.${q(id)}&claimed_at=is.null&revoked=is.false`, { method: 'PATCH', body: JSON.stringify(patch) })).length > 0,
    list: () => call('?select=id,name,kind,created_at,claimed_at,last_seen,expires_at&claimed_at=not.is.null&revoked=is.false&order=last_seen.desc.nullslast'),
    sweep: () => call(`?claimed_at=is.null&expires_at=lt.${q(new Date().toISOString())}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  };
}

const clean = (s, max = 40) => String(s || '').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, max);

/** POST pair/start — a screen asks for a code. Returns { code, secret, expiresIn }. */
export async function pairStart(request, store) {
  const body = await request.json().catch(() => ({}));
  await store.sweep().catch(() => {});
  const secret = randomToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await store.insert({
        id: crypto.randomUUID(), code, secret_hash: await sha256(secret),
        kind: body.kind === 'widget' ? 'widget' : 'screen', name: clean(body.name) || null,
        expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      });
      return { code, secret, expiresIn: CODE_TTL_MS / 1000 };
    } catch { /* code taken by another waiting screen: try another */ }
  }
  throw new Error('Could not make a code. Try again.');
}

/** POST pair/poll — the screen checks whether its code was entered. Hands the token over once. */
export async function pairPoll(request, store) {
  const { secret } = await request.json().catch(() => ({}));
  if (!secret) return { status: 'unknown' };
  const row = await store.bySecret(await sha256(secret));
  if (!row) return { status: 'unknown' };
  if (!row.claimed_at) return new Date(row.expires_at).getTime() < Date.now() ? { status: 'expired' } : { status: 'waiting', code: row.code };
  if (row.token_once) {
    const { token_once: token, name } = row;
    await store.update(row.id, { token_once: null });
    return { status: 'paired', token, name };
  }
  return { status: 'paired' };
}

/** POST pair/claim — su94r Mini (holding the display key) enters a screen's code and names it. */
export async function pairClaim(request, store) {
  const { code, name } = await request.json().catch(() => ({}));
  const c = normalCode(code);
  if (!c) return { ok: false, error: 'That code does not look right. It has 6 letters and numbers.' };
  const row = await store.byCode(c);
  if (!row) return { ok: false, error: 'No screen is waiting with that code. Codes last 15 minutes; refresh the screen for a new one.' };
  const token = randomToken();
  await store.update(row.id, {
    claimed_at: new Date().toISOString(), code: null, name: clean(name) || row.name || 'Screen',
    token_hash: await sha256(token), token_once: token,
  });
  return { ok: true, name: clean(name) || row.name || 'Screen' };
}

// ---- sharing to another phone: a QR code from su94r Mini, nothing to type on the phone ----
//
// su94r Mini (owner key) makes a one-time invite; its QR code holds <server>/tv#join=<invite>
// (in the part after #, which browsers never send to a server). The phone opens it, the page
// claims the invite once, before it expires, and keeps its own revocable token like a paired
// screen. role 'me' (another phone of the owner) or 'family' decides which alert topic the
// phone is offered (share/extras in cgm-core.js).

const SHARE_TTL_MS = 10 * 60e3;

/** POST share/new — a one-time invite for another phone. Returns { invite, role, expiresIn }. */
export async function shareNew(request, store) {
  const body = await request.json().catch(() => ({}));
  await store.sweep().catch(() => {});
  const invite = randomToken();
  const role = body.role === 'family' ? 'family' : 'me';
  await store.insert({
    id: crypto.randomUUID(), secret_hash: await sha256(invite), kind: 'screen', role,
    name: clean(body.name) || (role === 'family' ? 'Family phone' : 'My other phone'),
    expires_at: new Date(Date.now() + SHARE_TTL_MS).toISOString(),
  });
  return { invite, role, expiresIn: SHARE_TTL_MS / 1000 };
}

/** POST share/claim — the phone that opened the invite takes its own token, once. */
export async function shareClaim(request, store) {
  const { invite } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f]{64}$/.test(String(invite || ''))) return { ok: false, error: 'This share link is not complete. Scan the code again.' };
  const row = await store.bySecret(await sha256(invite));
  // Only share invites: a waiting TV's polling secret must not turn into a token here.
  if (!row || !row.role || row.claimed_at) return { ok: false, error: 'This share code was already used. Make a new one in su94r Mini.' };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: 'This share code has expired (they last 10 minutes). Make a new one in su94r Mini.' };
  const token = randomToken();
  const won = await store.claimIfOpen(row.id, { claimed_at: new Date().toISOString(), token_hash: await sha256(token), secret_hash: await sha256(randomToken()), token_once: null });
  if (!won) return { ok: false, error: 'This share code was already used. Make a new one in su94r Mini.' };
  return { ok: true, token, name: row.name, role: row.role };
}

/**
 * The screen behind a token, or null. The token comes in the Authorization header, or, for
 * widget apps that cannot set headers (KWGT on Android), as ?token= in the link.
 * Updates last_seen at most once a minute.
 */
export async function screenFor(request, store, queryToken = '') {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(queryToken || '').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await store.byToken(await sha256(token));
  if (!row) return null;
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 60e3) store.update(row.id, { last_seen: new Date().toISOString() }).catch(() => {});
  return row;
}
