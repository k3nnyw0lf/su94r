// ═══════════════════════════════════════════════════════════════════════════
// Sign-in allowlist and roles.
//
// ⚠️  THIS IS A UI GATE, NOT SECURITY.
//
// Everything in this file runs in the browser, so anyone who opens devtools can
// bypass it. It exists so that a stray sign-in gets a clear "not your app"
// screen instead of a broken session, and so the admin panel is not rendered
// for people who cannot use it — nothing more.
//
// Real enforcement lives in Postgres, where the client cannot reach it:
//   - public.su94r_is_allowed_user()  gates who can read anything
//   - public.su94r_is_admin()         gates the app_secrets table
//
// Keep the lists here in sync with those functions. The database is the one
// that counts; if the two disagree, the database wins and the UI is the bug.
//
// Running your own copy? Set VITE_ADMIN_EMAILS and VITE_ALLOWED_EMAILS
// (comma-separated) at build time and update the two SQL functions to match.
//
// See docs/access-control.md.
// ═══════════════════════════════════════════════════════════════════════════

const fromEnv = (v) => (typeof v === 'string' ? v.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) : []);
const ENV = import.meta.env || {};

/**
 * Admins can open the admin panel and read/write shared API keys.
 * Everyone in ALLOWED_EMAILS can use the app itself.
 */
export const ADMIN_EMAILS = fromEnv(ENV.VITE_ADMIN_EMAILS).length
  ? fromEnv(ENV.VITE_ADMIN_EMAILS)
  : ['k3nny.w0lf@gmail.com'];   // su94r.com's owner

/** Accounts permitted to sign in and sync. Admins are implicitly included. */
export const ALLOWED_EMAILS = [
  ...ADMIN_EMAILS,
  ...fromEnv(ENV.VITE_ALLOWED_EMAILS),
];

const normalize = e => (typeof e === 'string' ? e.trim().toLowerCase() : '');

export function isAllowedEmail(email) {
  return ALLOWED_EMAILS.includes(normalize(email));
}

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(normalize(email));
}

/**
 * @param {object|null} user  Supabase user object.
 * @returns {boolean} true when there is no user (local-only use is fine) or
 *                    the signed-in user is on the allowlist.
 */
export function isAllowedUser(user) {
  if (!user) return true;
  return isAllowedEmail(user.email);
}

/**
 * Admin status requires an actual session. Unlike isAllowedUser, a signed-out
 * visitor is NOT an admin — otherwise the panel would render before login.
 */
export function isAdminUser(user) {
  return !!user && isAdminEmail(user.email);
}

export const ROLE = { ADMIN: 'admin', USER: 'user', GUEST: 'guest' };

export function roleOf(user) {
  if (!user) return ROLE.GUEST;
  if (isAdminEmail(user.email)) return ROLE.ADMIN;
  if (isAllowedEmail(user.email)) return ROLE.USER;
  return ROLE.GUEST;
}
