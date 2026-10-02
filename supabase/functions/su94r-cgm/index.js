// su94r-cgm — Supabase edge function that does everything needing LibreLinkUp
// from a server. Cloudflare Workers are refused by LibreView's bot shield, so
// su94r-proxy forwards /libre/*, /glucose/latest, /display/data, /alexa and /voice/sync here.
// The logic lives in workers/cgm-core.js (tested in tests/proxy.test.js).
//
// Deploy (custom auth inside, so no Supabase JWT):
//   supabase functions deploy su94r-cgm --no-verify-jwt --project-ref <ref>
//
// Secrets (Supabase dashboard → Edge Functions → Secrets). Supabase secrets are
// shared by every function in the project, so these carry an SU94R_ prefix:
//   SU94R_LLU_EMAIL, SU94R_LLU_PASSWORD   LibreLinkUp follower login (server routes)
//   SU94R_HEALTH_INGEST_TOKEN             same value as HEALTH_INGEST_TOKEN on su94r-monitor
//   SU94R_DISPLAY_KEY                     the secret in the display URL /d/<key>
//   SU94R_ALEXA_SKILL_ID                  amzn1.ask.skill.… (docs/tv-and-alexa.md)

import { handleCgm } from '../../../workers/cgm-core.js';

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself (dose store).
const NAMES = ['LLU_EMAIL', 'LLU_PASSWORD', 'HEALTH_INGEST_TOKEN', 'DISPLAY_KEY', 'ALEXA_SKILL_ID', 'CLAIM_OPEN_UNTIL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function env() {
  const all = Deno.env.toObject();
  return Object.fromEntries(NAMES.map((n) => [n, all[`SU94R_${n}`] ?? all[n]]));
}

Deno.serve((req) => {
  const path = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?su94r-cgm\/?/, '');
  return handleCgm(path, req, env());
});
