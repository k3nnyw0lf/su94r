// ═══════════════════════════════════════════════════════════════════════════
// Shared API-key store (admin panel backing).
//
// WHAT BELONGS HERE
//   Service API keys the BROWSER itself calls with: Groq, Gemini, USDA, Oura…
//   These are already exposed to whoever is using the app, because the fetch
//   happens client-side. Putting them in Postgres behind RLS buys one thing —
//   the keys follow the admin across devices instead of living in one browser's
//   localStorage, and no other signed-in user can read them.
//
// WHAT DOES NOT BELONG HERE  (the DB rejects scope != 'client')
//   • Supabase service-role key      → Worker secret
//   • Google OAuth client secret     → Worker secret
//   • HEALTH_INGEST_TOKEN            → Worker secret
//   • Wyze / Libre / Dexcom passwords → never in a database, never in this app
//
// The distinction is not cosmetic. A client key is one the architecture already
// exposes; a server secret is one that exposure would actually compromise.
// Moving the second kind here would hand every one of them to any XSS on the
// page. If you are tempted, don't.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase';

/**
 * Keys the admin panel manages. `hint` explains what breaks without it, so the
 * panel is self-documenting rather than a wall of unlabelled inputs.
 */
export const SECRET_REGISTRY = [
  {
    group: 'AI models',
    items: [
      { key: 'groqKey', label: 'Groq', hint: 'Powers all 10 AI agents. Free at console.groq.com — the one to set first.' },
      { key: 'geminiKey', label: 'Google Gemini', hint: 'Backup model, nutrition analysis, and the equipment photo scanner. Free at aistudio.google.com.' },
      { key: 'mistralKey', label: 'Mistral', hint: 'Third fallback. Optional.' },
    ],
  },
  {
    group: 'Food & nutrition',
    items: [
      { key: 'usdaKey', label: 'USDA FoodData', hint: 'Carb counting from the USDA database. Free at fdc.nal.usda.gov.' },
      { key: 'nutritionixId', label: 'Nutritionix App ID', hint: 'Restaurant food data. Free 500/day.' },
      { key: 'nutritionixKey', label: 'Nutritionix Key', hint: 'Paired with the App ID above.' },
    ],
  },
  {
    group: 'Wearables',
    items: [
      { key: 'ouraToken', label: 'Oura', hint: 'Sleep stages and HRV. Personal access token from cloud.ouraring.com.' },
      { key: 'withingsToken', label: 'Withings', hint: 'Blood pressure and weight.' },
      { key: 'garminToken', label: 'Garmin', hint: 'Requires approval at developer.garmin.com.' },
    ],
  },
];

export const REGISTRY_KEYS = SECRET_REGISTRY.flatMap(g => g.items.map(i => i.key));

/**
 * Keys deliberately NOT managed here. Rendered in the panel as a read-only
 * notice so an admin looking for them learns where they actually live instead
 * of concluding the panel is incomplete.
 */
export const SERVER_ONLY = [
  { name: 'SUPABASE_SERVICE_KEY', where: 'Cloudflare Worker secret' },
  { name: 'GOOGLE_CLIENT_SECRET', where: 'Cloudflare Worker secret' },
  { name: 'HEALTH_INGEST_TOKEN', where: 'Cloudflare Worker secret' },
  { name: 'WYZE_PASSWORD / WYZE_API_KEY', where: 'VPS1 environment, cron job' },
  { name: 'Libre / Dexcom account passwords', where: 'Per-device Settings only — never synced' },
];

/** Fetches all shared keys. Returns {} for non-admins: RLS yields zero rows. */
export async function loadSecrets() {
  const { data, error } = await supabase.from('app_secrets').select('key,value,updated_at');
  if (error) throw error;
  return Object.fromEntries((data || []).map(r => [r.key, r.value]));
}

/**
 * Upserts one key. An empty value deletes the row rather than storing '' —
 * otherwise "no key set" and "key set to empty" become indistinguishable and
 * the app would try to authenticate with a blank string.
 */
export async function saveSecret(key, value, email) {
  if (!REGISTRY_KEYS.includes(key)) throw new Error(`Unknown key: ${key}`);
  const trimmed = (value ?? '').trim();

  if (!trimmed) {
    const { error } = await supabase.from('app_secrets').delete().eq('key', key);
    if (error) throw error;
    return { deleted: true };
  }

  const { error } = await supabase.from('app_secrets').upsert({
    key,
    value: trimmed,
    scope: 'client',
    updated_at: new Date().toISOString(),
    updated_by: email || null,
  });
  if (error) throw error;
  return { saved: true };
}

/** Shows enough to recognise a key without revealing it. */
export function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}
