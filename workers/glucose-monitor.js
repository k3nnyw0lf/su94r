// ═══════════════════════════════════════════════════════════════════════════
// Glucose monitor — the runner for the escalation ladder.
//
// WHY THIS EXISTS
//
// escalation.js decides what should happen when someone is low and not
// responding. Until this Worker existed, nothing CALLED it. The whole care
// circle — the lights, the siren, waking someone in another room — was inert
// logic. A safety net that nothing is holding up is not a safety net.
//
// This runs on a cron every five minutes, independent of whether any phone is
// awake, any browser tab is open, or the PWA has been killed by the OS. That
// independence is the point: at 3am none of those things are true.
//
// DESIGN RULES
//
//   Fail loud, not silent. If the CGM fetch fails during a known low, that is
//   escalated, not swallowed — a sensor going quiet mid-hypo is indistinguishable
//   from someone losing consciousness.
//
//   Episode state lives in the database, not in memory. Workers are stateless
//   and may run on any machine; "which rung have we already fired" must survive
//   that.
//
//   Consent is re-read every run. A caregiver who revokes must stop being
//   contacted immediately, not at the next deploy.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY, HEALTH_INGEST_TOKEN,
//          HA_BASE_URL, HA_TOKEN (optional), TWILIO_* (optional)
// ═══════════════════════════════════════════════════════════════════════════

import { evaluateEscalation, alertPayload, RUNG } from '../src/lib/care/escalation.js';
import { planHomeAlert } from '../src/lib/care/homeAlert.js';
import { validateSeries } from '../src/lib/cgm/validate.js';

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// ─── Supabase helpers ───────────────────────────────────────────────────────

async function sb(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

/** Active caregivers only. Re-read every run so a revocation takes effect now. */
async function careCircle(env, patientEmail) {
  return sb(env, `su94r_care_link?patient_email=eq.${encodeURIComponent(patientEmail)}&status=eq.active&select=*`);
}

async function openEpisode(env, patientEmail) {
  const rows = await sb(
    env,
    `su94r_care_alert?patient_email=eq.${encodeURIComponent(patientEmail)}` +
      `&acknowledged_at=is.null&order=created_at.desc&limit=1&select=*`
  );
  const last = rows?.[0];
  if (!last) return null;
  // Older than six hours is a stale episode, not an ongoing one.
  if (Date.now() - new Date(last.created_at).getTime() > 6 * 3_600_000) return null;
  return last;
}

async function recordAlert(env, row) {
  return sb(env, 'su94r_care_alert', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([row]),
  });
}

// ─── Delivery ───────────────────────────────────────────────────────────────

async function fireHomeDevices(env, decision, homeConfig, timeZone) {
  // The HA token is a Worker secret and never leaves it; the entity IDs come
  // from Settings, because knowing "light.bedroom" grants nothing on its own.
  if (!env.HA_BASE_URL || !env.HA_TOKEN || !homeConfig) return { attempted: false };

  const plan = planHomeAlert(decision, homeConfig, { timeZone });
  if (!plan.calls.length) return { attempted: false, skipped: plan.skipped };

  const results = await Promise.allSettled(
    plan.calls.map(c =>
      fetch(`${env.HA_BASE_URL}${c.path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.HA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      })
    )
  );

  return {
    attempted: true,
    zones: plan.zones,
    ok: results.filter(r => r.status === 'fulfilled' && r.value.ok).length,
    failed: results.filter(r => r.status === 'rejected' || !r.value?.ok).length,
  };
}

async function fireSms(env, link, payload) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return { sent: false, reason: 'not configured' };
  if (!link.allow_sms || !link.phone_e164) return { sent: false, reason: 'not consented' };

  const body = new URLSearchParams({
    To: link.phone_e164,
    From: env.TWILIO_FROM,
    Body: `${payload.title}. ${payload.body}`,
  });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return { sent: res.ok, status: res.status };
}

// ─── The run ────────────────────────────────────────────────────────────────

/**
 * Behaviour settings, read fresh every run.
 *
 * Deliberately NOT env vars: thresholds, night hours and device entity IDs are
 * things a user tunes, and requiring a CLI redeploy to change a night window
 * means it never gets changed. Credentials stay in Worker secrets — see the
 * comment on su94r_monitor_config.
 */
async function loadConfig(env, patientEmail) {
  try {
    const rows = await sb(
      env,
      `su94r_monitor_config?patient_email=eq.${encodeURIComponent(patientEmail)}&select=*`
    );
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

export async function runMonitor(env, { now = Date.now() } = {}) {
  const patientEmail = env.PATIENT_EMAIL;
  if (!patientEmail) return { error: 'PATIENT_EMAIL not configured' };

  const cfg = await loadConfig(env, patientEmail);

  // Absent config means the user has not set this up. Running with defaults
  // would silently pick a timezone and start paging people — better to do
  // nothing and say so.
  if (!cfg) return { skipped: true, reason: 'no monitor config — set it up in Settings' };
  if (!cfg.enabled) return { skipped: true, reason: 'monitoring disabled in Settings' };

  const policy = {
    lowMgdl: cfg.low_mgdl,
    severeMgdl: cfg.severe_mgdl,
    nightStartHour: cfg.night_start_hour,
    nightEndHour: cfg.night_end_hour,
    selfAckMinutes: cfg.self_ack_minutes,
    carePushMinutes: cfg.care_push_minutes,
    careSmsMinutes: cfg.care_sms_minutes,
  };
  const timeZone = cfg.time_zone || 'UTC';

  // Read glucose through the same proxy the app uses, so there is exactly one
  // implementation of each CGM integration.
  let readings = [];
  let fetchFailed = false;
  try {
    const res = await fetch(`${env.PROXY_URL}/glucose/latest`, {
      headers: { Authorization: `Bearer ${env.HEALTH_INGEST_TOKEN}` },
    });
    readings = res.ok ? await res.json() : [];
    fetchFailed = !res.ok;
  } catch {
    fetchFailed = true;
  }

  const clean = validateSeries(Array.isArray(readings) ? readings : [], { now }).valid;
  const latest = clean.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;

  const episode = await openEpisode(env, patientEmail);
  const circle = await careCircle(env, patientEmail);

  const decision = evaluateEscalation({
    // A failed fetch presents as an absent reading, which is exactly how
    // escalation.js detects a data gap during a known low.
    reading: fetchFailed ? { value: null } : latest,
    lowSince: episode ? new Date(episode.created_at).getTime() : null,
    acknowledged: !!episode?.acknowledged_at,
    highestRungFired: episode?.rung || RUNG.NONE,
    lastRungAt: episode ? new Date(episode.created_at).getTime() : null,
    circleSize: circle.length,
    policy,
    timeZone,
    now,
  });

  if (decision.rung === RUNG.NONE) {
    return { fired: false, resolved: !!decision.resolved, glucose: latest?.value ?? null };
  }

  const payload = alertPayload(decision, { name: cfg.patient_name || 'Ken' });

  const recipients =
    decision.rung === RUNG.SELF ? [patientEmail] : circle.map(l => l.caregiver_email);

  const delivery = { home: null, sms: [] };

  // Home devices run on every rung from SELF upward — they are the most likely
  // thing to actually wake someone, so they do not wait for the ladder to climb.
  delivery.home = await fireHomeDevices(env, decision, cfg.home_config, timeZone);

  if (decision.rung === RUNG.CARE_SMS || decision.rung === RUNG.CARE_CALL) {
    for (const link of circle) {
      delivery.sms.push({ to: link.caregiver_email, ...(await fireSms(env, link, payload)) });
    }
  }

  await recordAlert(env, {
    patient_email: patientEmail,
    rung: decision.rung,
    glucose_mgdl: latest?.value ?? null,
    severe: !!decision.severe,
    reason: decision.reason,
    recipients,
    delivered: !!(delivery.home?.ok || delivery.sms.some(s => s.sent)),
    delivery_error: fetchFailed ? 'cgm fetch failed' : null,
  });

  return { fired: true, rung: decision.rung, severe: decision.severe, delivery, recipients };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Manual trigger, for testing the whole chain without waiting for a low.
    if (pathname === '/monitor/run') {
      // Refuse outright when the secret is unset. Comparing against
      // `Bearer ${undefined}` would otherwise accept the literal string
      // "Bearer undefined" — a guessable credential on an endpoint that reads
      // health data.
      if (!env.HEALTH_INGEST_TOKEN) {
        return json({ error: 'monitor not configured: HEALTH_INGEST_TOKEN is unset' }, 503);
      }
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.HEALTH_INGEST_TOKEN}`) return json({ error: 'unauthorized' }, 401);

      try {
        return json(await runMonitor(env));
      } catch (err) {
        // Surface the reason rather than an opaque 500 — this endpoint exists
        // precisely to find out why the chain is not working.
        return json({ error: String(err?.message || err).slice(0, 300) }, 500);
      }
    }
    return json({ error: 'not found' }, 404);
  },

  // Cron is declared in wrangler.toml — every five minutes.
  // (Deliberately a line comment: the cron expression contains the character
  // pair that would close a block comment early.)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runMonitor(env).catch(err =>
        // A monitor that dies silently is worse than no monitor, because it
        // looks like everything is fine.
        recordAlert(env, {
          patient_email: env.PATIENT_EMAIL,
          rung: 'monitor-error',
          reason: String(err?.message || err).slice(0, 300),
          delivered: false,
          delivery_error: 'monitor threw',
        }).catch(() => {})
      )
    );
  },
};
