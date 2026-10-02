// Sign in with Google, and keep a copy of everything in the person's own Google Drive.
//
// Sign-in uses the browser's own Google window (chrome.identity.launchWebAuthFlow), so the
// password is typed into Google, never into su94r Mini. The access token lasts an hour and
// is renewed silently while the person stays signed in to Google in this browser.
//
// Drive access is the narrowest Google offers (drive.file): su94r Mini sees only the files
// it created, in a folder called "su94r" that the person can open, download or delete like
// any other. Each person who signs in saves to their own Drive; nothing passes through any
// su94r server.
//
// Every computer saves into the same monthly file (su94r-YYYY-MM.json). A save reads the
// file, adds what this computer has, and writes it back, so a save that crosses another
// computer's save heals at the next one: nothing is ever only on one side for long.

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'su94r';
export const DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
export const GOOGLE_HOSTS = ['https://www.googleapis.com/*', 'https://health.googleapis.com/*', 'https://openidconnect.googleapis.com/*', 'https://oauth2.googleapis.com/*'];

// The OAuth client su94r Mini signs in with: the "su94r" Web application client in the su94r
// Google Cloud project, whose redirect URIs include this extension's chrome.identity.getRedirectURL()
// (https://gcdoahfflgpabebcbhohaklfmpnnggpi.chromiumapp.org/). A client ID is public by design (it
// is in every sign-in link). The app is in Google's Testing mode, so only the test users added
// in that project can sign in; a copy of su94r run by someone else should set its own client ID
// on the vault page's Google Drive card.
export const BUILT_IN_CLIENT_ID = '1009934716310-6qf6p6344544bngramu28vl9u7l1r5vf.apps.googleusercontent.com';

import { mergeMonth } from './drive-month.js';
export { mergeMonth, monthOf, monthRange } from './drive-month.js';

export class GoogleError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const store = chrome.storage.local;

export async function clientId() {
  const { settings } = await store.get('settings');
  return (settings?.googleClientId || BUILT_IN_CLIENT_ID || '').trim();
}

/** The signed-in Google account on this computer, or null. */
export async function googleAccount() {
  const { google } = await store.get('google');
  return google?.email ? { email: google.email, scopes: google.scopes || [], drive: google.drive || null } : null;
}

/**
 * A working access token with at least `scopes`. With `interactive`, opens Google's window
 * (needs a click); otherwise renews silently or throws code 'signin'.
 */
/** Google answers "email" as the userinfo.email address; both mean the same. */
export function hasScope(granted = [], s) {
  if (granted.includes(s)) return true;
  if (s === 'email') return granted.includes('https://www.googleapis.com/auth/userinfo.email');
  if (s === 'profile') return granted.includes('https://www.googleapis.com/auth/userinfo.profile');
  return false;
}

export async function getToken(scopes = DRIVE_SCOPES, { interactive = false } = {}) {
  const { google } = await store.get('google');
  // Always ask for the email too, so silent renewal knows which Google account to use.
  const asked = [...new Set(['openid', 'email', ...scopes])];
  const want = [...new Set([...(google?.scopes || []), ...asked])];
  if (google?.token && google.expires > Date.now() + 120e3 && asked.every((s) => hasScope(google.scopes, s))) return google.token;
  const id = await clientId();
  if (!id) throw new GoogleError('Google sign-in is not set up in this copy of su94r Mini yet.', 'noclient');
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: 'token',
    scope: want.join(' '),
    include_granted_scopes: 'true',
    prompt: interactive ? (google?.email ? 'consent' : 'select_account consent') : 'none',
    ...(google?.email ? { login_hint: google.email } : {}),
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: `${AUTH}?${params}`, interactive });
  } catch (e) {
    throw new GoogleError(interactive ? 'Google sign-in was closed before it finished.' : 'Sign in to Google again to keep saving.', interactive ? 'cancelled' : 'signin');
  }
  const back = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (back.get('error')) throw new GoogleError(back.get('error') === 'access_denied' ? 'Google access was not allowed.' : 'Sign in to Google again to keep saving.', back.get('error') === 'access_denied' ? 'denied' : 'signin');
  const token = back.get('access_token');
  const granted = (back.get('scope') || want.join(' ')).split(' ');
  if (!token) throw new GoogleError('Google did not return access.', 'signin');
  // Google's window lets people untick a permission; say which one is missing.
  const missing = scopes.filter((s) => !hasScope(granted, s));
  if (missing.length) {
    const what = missing.some((s) => s.includes('drive')) ? 'saving to Drive' : missing.some((s) => s.includes('googlehealth')) ? 'reading Google Health' : 'this';
    throw new GoogleError(`Google did not allow ${what}. Press the button again and leave that box ticked.`, 'denied');
  }
  const email = google?.email || await fetchEmail(token);
  await store.set({ google: { ...(google || {}), email, token, scopes: granted, expires: Date.now() + Number(back.get('expires_in') || 3600) * 1000 } });
  return token;
}

async function fetchEmail(token) {
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? (await r.json()).email || '' : '';
}

/** Clears the cached token (after Google refused it), so the next call renews it. */
export async function forgetToken() {
  const { google } = await store.get('google');
  if (google) await store.set({ google: { ...google, token: null, expires: 0 } });
}

/** Forgets the Google account here (the files in Drive stay; Google access is revoked). */
export async function signOutGoogle() {
  const { google } = await store.get('google');
  if (google?.token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(google.token)}`, { method: 'POST' }).catch(() => {});
  await store.remove('google');
}

async function api(token, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (r.status === 401) {
    const { google } = await store.get('google');
    if (google) await store.set({ google: { ...google, token: null, expires: 0 } });
    throw new GoogleError('Sign in to Google again to keep saving.', 'signin');
  }
  if (!r.ok) throw new GoogleError(`Google Drive answered ${r.status}.`, 'drive');
  return r;
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The su94r folder in Drive (made the first time), remembered by id. */
async function folderId(token) {
  const { google } = await store.get('google');
  if (google?.folderId) {
    const r = await fetch(`${DRIVE}/files/${google.folderId}?fields=id,trashed`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok && !(await r.json()).trashed) return google.folderId;
  }
  const found = await (await api(token, `${DRIVE}/files?q=${encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    id = (await (await api(token, `${DRIVE}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder', description: 'su94r Mini: your glucose readings, markers and health vault.' }),
    })).json()).id;
    await writeFile(token, id, 'README.txt', README, 'text/plain');
  }
  const { google: g2 } = await store.get('google');
  await store.set({ google: { ...(g2 || {}), folderId: id } });
  return id;
}

async function findFile(token, folder, name) {
  const r = await (await api(token, `${DRIVE}/files?q=${encodeURIComponent(`name='${q(name)}' and '${folder}' in parents and trashed=false`)}&fields=files(id,name,modifiedTime,size)`)).json();
  return r.files?.[0] || null;
}

export async function listFiles(token, folder) {
  const r = await (await api(token, `${DRIVE}/files?q=${encodeURIComponent(`'${folder}' in parents and trashed=false`)}&fields=files(id,name,modifiedTime,size)&orderBy=name&pageSize=200`)).json();
  return r.files || [];
}

async function readJson(token, id) {
  return (await api(token, `${DRIVE}/files/${id}?alt=media`)).json();
}

async function writeFile(token, folder, name, body, type = 'application/json', existingId = null) {
  if (existingId) {
    await api(token, `${UPLOAD}/files/${existingId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': type }, body });
    return existingId;
  }
  const boundary = `su94r${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name, parents: [folder], mimeType: type });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await api(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  return (await r.json()).id;
}

// ---- the monthly file ----

async function fileVersion(token, id) {
  return (await (await api(token, `${DRIVE}/files/${id}?fields=version`)).json()).version;
}

/**
 * Reads, merges and writes one month. `local` is this computer's month in the same shape.
 * Never writes over a file it could not read: any read error stops the save (only "no file yet"
 * starts a new one). If another computer saved the file meanwhile (its version moved), the
 * merge is redone with that copy, so neither save is lost.
 */
export async function saveMonth(token, local) {
  const folder = await folderId(token);
  const name = `su94r-${local.month}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await findFile(token, folder, name);
    let remote = null, version = null;
    if (existing) {
      version = await fileVersion(token, existing.id);
      remote = await readJson(token, existing.id);
      if (!remote || remote.app !== 'su94r') throw new GoogleError(`${name} in Drive is not a su94r file; it was left alone.`, 'drive');
    }
    const merged = mergeMonth(remote, local);
    merged.savedAt = new Date().toISOString();
    if (existing && (await fileVersion(token, existing.id)) !== version) continue;   // saved elsewhere meanwhile
    await writeFile(token, folder, name, JSON.stringify(merged), 'application/json', existing?.id);
    return merged;
  }
  throw new GoogleError(`${name} kept changing on Drive; try again in a minute.`, 'drive');
}

/** Every month file in the su94r folder, newest first, read in full. */
export async function readAllMonths(token, { since = null } = {}) {
  const folder = await folderId(token);
  const files = (await listFiles(token, folder)).filter((f) => /^su94r-\d{4}-\d{2}\.json$/.test(f.name) && (!since || f.name.slice(6, 13) >= since));
  const out = [];
  for (const f of files.reverse()) {
    // A file that cannot be read stops the restore, so its deletions are not silently lost.
    try { out.push(await readJson(token, f.id)); } catch (e) { throw new GoogleError(`Could not read ${f.name} from Drive (${e.message}); nothing was changed. Try again.`, e.code || 'drive'); }
  }
  return out.filter((f) => f?.app === 'su94r');
}

const README = `su94r Mini keeps a copy of your data here, one file per month (su94r-YYYY-MM.json).

Each file holds:
  readings  glucose readings per person: [time in ms since 1970, mg/dL, source]
  markers   insulin, meals, exercise and medicine you logged
  health    your health vault: weight, blood pressure, steps, heart rate, sleep, workouts...
  deleted   markers deleted on purpose, so they stay deleted

The files are yours. su94r Mini can see only the files it made in this folder, nothing
else in your Drive. Delete them any time; turning off "Save to Google Drive" in su94r Mini
stops new copies.
`;

/**
 * Saves a file (the glucose report PDF) into the su94r folder, replacing one with the same
 * name. Returns { id, webViewLink }.
 */
export async function saveBlob(token, name, blob, type) {
  const folder = await folderId(token);
  const existing = await findFile(token, folder, name);
  if (existing) {
    await api(token, `${UPLOAD}/files/${existing.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': type }, body: blob });
    return (await api(token, `${DRIVE}/files/${existing.id}?fields=id,webViewLink`)).json();
  }
  const boundary = `su94r${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name, parents: [folder], mimeType: type });
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
  const r = await api(token, `${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return r.json();
}
