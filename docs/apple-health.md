# Apple Health → su94r

Apple Health (HealthKit) has **no server-side API**. There is no OAuth, no webhook,
no "connect Apple Health" button that a website can offer. Health data lives
encrypted on the iPhone and only leaves it if something on the device sends it.

That leaves two options:

| | Native iOS app | Shortcuts bridge |
|---|---|---|
| Build machine | Mac, or Expo EAS cloud build | Any — nothing to build |
| Apple Developer account | Required ($99/yr) | Not required |
| Data freshness | Real-time background delivery | Whatever the schedule is, gaps when locked |
| Effort | Weeks | Under an hour |

su94r uses the **Shortcuts bridge**. It costs nothing, needs no Apple Developer
account, and works from a Windows dev machine. The tradeoff is documented under
[Known limitations](#known-limitations) — read that section, it is not optional.

---

## 1. Install su94r on your iPhone

su94r is a PWA. There is no App Store listing.

1. Open **Safari** (not Chrome — only Safari can install a PWA on iOS) and go to `https://su94r.com`
2. Tap the **Share** button (square with an arrow, bottom centre)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**

su94r now behaves like an app: its own icon, full screen, no browser chrome.

**Do this before enabling notifications.** iOS only grants web push to PWAs that
have been added to the Home Screen. Notifications requested from a Safari tab
are silently ignored. Once installed, open su94r from the Home Screen icon and
allow notifications when prompted.

---

## 2. Create the database table

Run in the Supabase SQL editor:

```sql
create table if not exists public.health_samples (
  id          bigint generated always as identity primary key,
  type        text        not null,
  value       double precision not null,
  unit        text,
  recorded_at timestamptz not null,
  source      text        not null default 'apple-health',
  created_at  timestamptz not null default now()
);

-- Makes re-sends idempotent. Overlapping Shortcut runs are normal and must not
-- create duplicate rows, or the correlation engine will double-count.
create unique index if not exists health_samples_dedupe
  on public.health_samples (type, recorded_at, source);

create index if not exists health_samples_recent
  on public.health_samples (type, recorded_at desc);

alter table public.health_samples enable row level security;
```

RLS is enabled with no policies, so the anon key cannot read or write it. The
Worker uses the service-role key, which bypasses RLS. See
[access-control.md](./access-control.md) before adding any read policy.

---

## 3. Deploy the ingest endpoint

`workers/health-ingest.js` mounts at `POST /health/ingest` on the existing
`su94r-proxy` Worker.

```bash
# Generate an ingest token and keep a copy — you need it in the Shortcut
openssl rand -hex 32

wrangler secret put HEALTH_INGEST_TOKEN
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put SUPABASE_URL
wrangler deploy
```

Verify it rejects an unauthenticated request:

```bash
curl -i -X POST https://<your-proxy>.workers.dev/health/ingest -d '[]'
```

Expect `401`. If you get anything else, stop and fix it before continuing — an
open ingest endpoint lets anyone write junk into your health history.

---

## 4. Build the Shortcut

On the iPhone, in the **Shortcuts** app:

1. **Automation** tab → **+** → **Time of Day**
2. Set it to repeat **Hourly**, and turn **Run After Confirmation** off so it
   runs silently
3. Add these actions:

| Action | Configuration |
|---|---|
| **Find Health Samples** | Type: `Heart Rate` · Sort by `Start Date` · Limit `200` |
| **Repeat with Each** | over the found samples |
| ↳ **Dictionary** | `type` = `heartRate`, `value` = Sample Value, `timestamp` = Sample Start Date, `unit` = `count/min` |
| ↳ **Add to Variable** | `samples` |
| **Get Contents of URL** | see below |

**Get Contents of URL:**

- URL — `https://<your-proxy>.workers.dev/health/ingest`
- Method — `POST`
- Headers — `Authorization: Bearer <your HEALTH_INGEST_TOKEN>`, `Content-Type: application/json`
- Request Body — `JSON`, set to the `samples` variable

Duplicate the Find/Repeat pair for each additional metric, changing the sample
type and the `type` string. The Worker accepts:

`heartRate` · `heartRateVariability` · `restingHeartRate` · `steps` ·
`activeEnergy` · `basalEnergy` · `exerciseMinutes` · `standHours` ·
`sleepAnalysis` · `respiratoryRate` · `oxygenSaturation` · `bodyMass` ·
`bodyFatPercentage` · `vo2Max` · `bloodGlucose` · `workout`

Anything else is dropped server-side.

### Test it

Run the automation manually from the Shortcuts app. A healthy response looks
like `{"accepted": 47, "rejected": 0}`. Then confirm the rows landed:

```sql
select type, count(*), max(recorded_at)
from public.health_samples
group by type order by 2 desc;
```

---

## Known limitations

Read these before trusting the data.

**HealthKit is encrypted while the phone is locked.** This is the big one. If
the hourly automation fires while the iPhone is locked in your pocket,
`Find Health Samples` returns nothing and the batch is empty. The Worker treats
an empty batch as a normal outcome, not an error. In practice you get good
coverage during waking hours and gaps overnight — which is exactly when
overnight-low detection would be most useful.

*Mitigation:* the `Limit 200` and `Sort by Start Date` settings mean each run
backfills whatever accumulated since the last successful run, so a missed hour
is usually recovered by the next run once you unlock the phone. Overnight gaps
fill in when you first unlock in the morning. This is backfill, not real-time —
su94r must never be relied on for real-time hypo alerting through this path.
**Your CGM's own app and its native alarms remain the safety-critical channel.**

**Scheduling is best-effort.** iOS throttles background automations. Hourly is a
request, not a guarantee.

**Large fetches can time out.** If you add many sample types, split them across
two automations on staggered schedules rather than one heavy run.

**Glucose via Apple Health is a fallback, not the primary path.** su94r already
pulls CGM data directly from LibreLinkUp, Dexcom Share, or Nightscout, which is
fresher and more reliable than the Health round-trip. Only send `bloodGlucose`
through this bridge if you have no direct CGM connection configured.

---

## If you later want real-time

The upgrade path is an Expo (React Native) companion app using
`react-native-health` for HealthKit background delivery, built via EAS cloud
builds from Windows and installed over TestFlight. It needs an Apple Developer
account. The data model above does not change — the companion app would post to
the same `/health/ingest` endpoint, just continuously instead of hourly.
