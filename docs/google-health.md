# Google Health API → su94r (Android / Pixel)

The Android path, and the better of the two. Unlike the iOS Shortcuts bridge
this is **server-to-server OAuth**, so it keeps syncing while the phone is
locked — the exact window where the iOS route goes blind, and the exact window
where post-exercise overnight lows happen.

## Why not the alternatives

| Option | Verdict |
|---|---|
| **Apple Watch on a Pixel** | Impossible. Requires an iPhone to activate and to run. No workaround exists. |
| **Apple Health on Android** | Does not exist. HealthKit is an iOS-only framework. |
| **Google Fit API** | Deprecated, and closed to new developer signups since 1 May 2024. Cannot be adopted. |
| **Fitbit legacy Web API** | Live but deprecated September 2026. Google Health API is its stated successor. |
| **Health Connect** | Native Android only — no REST or web API, so a PWA cannot read it without shipping an Android app. |
| **Google Health API** | ✅ REST + OAuth 2.0, reads Pixel Watch / Fitbit / third-party, no native app. |

## What gets synced

`workers/google-health.js` pulls these into `public.health_samples` with
`source = 'google-health'`, alongside anything the iOS bridge writes.

`heart-rate` · `heart-rate-variability` · `steps` · `active-energy-burned` ·
`active-zone-minutes` · `sedentary-period` · `oxygen-saturation` · `weight` ·
`blood-glucose` · `sleep` · `exercise`

`sedentary-period` has no Apple equivalent and is the one that most directly
describes a desk job — minutes actually spent sitting, which is what the
movement-snack schedule is trying to break up.

## Setup

### 1. Create the OAuth client

In the Google Cloud console, create a project just for su94r (keep health data
out of projects you use for anything else), then:

1. **APIs & Services → Library**: enable the **Google Health API**.
2. **OAuth consent screen**: External, publishing status **Testing**, and add
   your own Google account as the only test user.
3. **Credentials → Create OAuth client ID** (Web application):

| Setting | Value |
|---|---|
| JS origin | your app, e.g. `https://su94r.com` |
| Redirect URIs | `https://<your-project>.supabase.co/auth/v1/callback` (sign-in)<br>`https://<your-proxy>.workers.dev/google/callback` (Health API) |

One client serves both jobs: Supabase sign-in and the Health API.

The client ID is not a secret; it travels in every authorisation URL. The
**client secret is**. Keep it out of the repo and put it only in the Worker
secrets below.

**Keep the app in Testing with only your account listed.** `/google/start` is
not tied to a su94r sign-in; Google refusing everyone who is not a test user is
what stops a stranger from connecting their account to your Worker.

You do not need Google's verification review: an app in Testing works at once
for its test users (up to 100). The cost is that refresh tokens expire after
7 days, so expect to reconnect weekly.

### 2. Set the Worker secrets

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REDIRECT_URI   # https://<your-proxy>.workers.dev/google/callback
wrangler secret put APP_URL               # https://su94r.com
```

`HEALTH_INGEST_TOKEN`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are shared with
`health-ingest.js` — set them once.

### 3. Add the hourly cron

In `wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]
```

Then `wrangler deploy`.

### 4. Connect

In su94r: **Settings → Fitness & Wearable APIs → Connect Google Health**. You
are redirected to Google, approve the read-only scopes, and land back on the
settings page. From then on the Worker's cron pulls hourly with no further
interaction.

## Verify

```sql
select type, count(*), min(recorded_at), max(recorded_at)
from public.health_samples
where source = 'google-health'
group by type order by 2 desc;
```

Manual sync (needs the ingest token, so run it from your machine, not the app):

```bash
curl -s -X POST "https://<your-proxy>.workers.dev/google/sync?days=7" \
  -H "Authorization: Bearer $HEALTH_INGEST_TOKEN"
```

Returns `{"written": N, "since": "...", "errors": []}`. Entries in `errors` are
per-data-type and non-fatal — a type you have no data for, or did not grant, is
skipped without failing the rest of the sync.

## Security notes

- Only **read-only** scopes are requested. su94r never writes to Google Health.
- The client secret and the refresh token never reach the browser. The refresh
  token lives in `public.google_health_tokens`, which has RLS enabled, **zero
  policies**, and no grants to `anon` or `authenticated` — it is reachable only
  by the Worker's service-role key.
- The OAuth `state` parameter is an HMAC over a timestamp, keyed on the ingest
  token, with a 10-minute window. That gives CSRF protection with no KV
  dependency.
- Disconnecting in su94r only clears local state. To fully revoke, remove su94r
  at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Both platforms at once

The Apple and Google paths write to the same table and are distinguished by the
`source` column, so nothing breaks if you use an iPhone and a Pixel in the same
period. The dedupe index is `(type, recorded_at, source)`, which means the same
reading arriving from both platforms is stored twice **by design** — they are
different observations from different devices, not duplicates. If you ever want
one to win, filter on `source` at read time rather than changing the index.
