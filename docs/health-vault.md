# Health vault, the learner, and connections

su94r Mini 2.4 keeps everything your other devices measure next to your glucose, learns what
moves your glucose, and can keep a copy in your own Google Drive. Open it from
**Settings → Health vault and what it learned**.

## What is in it

| Part | What it does | Where the data lives |
|---|---|---|
| Health vault | Weight, blood pressure, heart rate, steps, workouts, sleep, fingersticks, ketones, A1c, temperature, water, food, body composition, VO₂ max… | This computer (IndexedDB `su94r-vault`) |
| The learner | Works out how much and when each insulin lowers you, what carbs, exercise, walking and short sleep do, and how you drift through the day. Draws the estimate line on the graph once it beats plain guesses. | This computer (`learned:<person>`) |
| Google Drive copy | One file per month in a `su94r` folder in your Drive: readings, markers, the vault. Other computers can bring it back. | Your Google Drive (only files su94r made) |

Nothing here is ever a dosing instruction. The learner describes what has happened before, with
an 80% range, and says how far its estimates were off on days it did not learn from.

## How the learner works

Every 15 minutes of glucose is explained as:

```
change = − ISF[kind] · insulin used + CSF · carbs absorbed − exercise − walking
         − raised heart rate + short sleep + drift(time of day) + noise
```

* Insulin "used" follows the standard exponential insulin curve; each kind's peak time (and the
  carb absorption time) is chosen by trying a few and keeping the best fit.
* Weights come from robust Bayesian regression: sensible starting values keep it calm with
  little data, and odd readings (compression lows, unlogged meals) count for less.
* A factor joins only when there is data for it (watch steps, heart rate, sleep come from the vault).
* It re-learns every 6 hours from the last 30 days, and checks itself on the most recent quarter of
  the data, which it did not learn from. Only if its 1-hour estimates beat both "stays the same"
  and "keeps its trend" does the graph show its line; otherwise the plain 20-minute line stays.
* Click an insulin marker on the graph to see what that dose does by your own numbers: how much,
  strongest when, done when, and how much is still to come.

## Connections

### Google (Drive and Pixel Watch): one-time setup by the owner

Google sign-in needs an OAuth client from a Google Cloud project. su94r never sees your password:
you sign in in Google's own window. **The owner creates this once** (su94r does not create
credentials for you):

1. Go to <https://console.cloud.google.com/> and create a project called `su94r`.
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Health API**.
3. **Google Auth Platform → Branding**: app name `su94r`, your support email.
   **Audience**: External, Testing. Under **Test users** add your Google account and anyone in the
   family who will sign in (up to 100 people, no Google review needed).
4. **Data access → Add scopes**: `openid`, `email`, `.../auth/drive.file`, and the three
   `googlehealth.*.readonly` scopes (activity and fitness, health metrics and measurements, sleep).
5. **Clients → Create client → Web application**. Under **Authorized redirect URIs** add
   `https://gcdoahfflgpabebcbhohaklfmpnnggpi.chromiumapp.org/` (su94r Mini's fixed ID).
   Copy the **Client ID** (it ends in `.apps.googleusercontent.com`; it is not a secret).
6. In su94r Mini: **Health vault → Google Drive → Google client ID**, paste it, then
   **Sign in with Google**.

Notes: the Google Health API replaced the Fitbit Web API (which stops on 2026-10-30). Its pages say
Google "is not onboarding new projects at this time"; if enabling it fails, Drive still works and
the Android phone route below brings the same watch data. Link your watch in the **Google Health**
app (the renamed Fitbit app) first, or Google answers `ACCOUNT_NOT_LINKED`.

### Android phone (Health Connect), and everything that shares with it

Samsung Health, Withings scales and cuffs, Omron, Oura, Garmin, MyFitnessPal, Cronometer and the
Pixel Watch all write to Health Connect. One free open-source app forwards it:

1. In su94r Mini: **Health vault → Android phone → Make my phone's address** (needs your su94r
   server's big-screen link in Settings). Copy the address.
2. On the phone install **HC Webhook** from the Play Store (`com.hcwebhook.app`).
3. Allow Health Connect, add a webhook, paste the address, pick the data (blood pressure too), and
   set it to sync every 15 minutes.

The server keeps what the phone sends only until su94r Mini collects it (at most 14 days), then
forgets it. Anyone with the address could add readings to your vault but can never read anything.
Remove the address any time from the same card.

### iPhone and Apple Watch

HC Webhook is also on the App Store and reads Apple Health; Health Auto Export works too. Use the
same address.

### Claude (and other AI apps that speak MCP)

**Health vault → Claude and other AI apps → Make Claude's address**, then in Claude:
**Settings → Connectors → Add custom connector**, name `su94r`, paste the address. In a chat, switch
su94r on and ask ("How was my glucose overnight?"). Tools: `glucose_now`, `glucose_history` (up to
12 hours), `insulin_doses` (up to 48 hours). Read-only; Claude is told never to give insulin dosing
instructions. Switch it off from the same card (or remove "Claude" from Settings → Screens and widgets).

On Android, the Claude app (Pro or Max, US) can also read Health Connect itself:
**Claude → Settings → Health**. ChatGPT's developer mode accepts the same MCP address.

### Glucose on your Pixel Watch

Install **GlucoDataHandler** on the phone (Sources → LibreLinkUp, the same follower account) and on
the watch, then add its complication to your watch face. No su94r server needed.

### By hand and files

Type readings in the vault page, or import a CSV (`type,time,value,unit`, or a `date` column plus
one column per type), an HC Webhook or Health Auto Export JSON, a Health Connect export, or a su94r
Drive month file.

## Server routes (su94r-cgm, forwarded by su94r-proxy)

| Route | Who | What |
|---|---|---|
| `POST /inbox/new?key=` | su94r Mini (display key) | make an inbox; returns its secret once |
| `GET /inboxes?key=`, `POST /inboxes/remove?key=` | su94r Mini | list, remove |
| `POST /inbox/<secret>` (or `POST /inbox` with `X-Api-Key`) | the phone app | JSON ≤ 2 MB |
| `GET /inbox/<secret>/items?after=`, `POST /inbox/<secret>/ack` | su94r Mini | collect, then forget |
| `POST /mcp/new?key=` | su94r Mini | make an AI connector token (kept with screens, kind `ai`) |
| `POST /mcp/<token>` | Claude | MCP JSON-RPC (initialize, tools/list, tools/call) |

Tables: `su94r_inboxes`, `su94r_inbox_items` (migration `20261002_su94r_inbox.sql`). Service role
only; only hashes of secrets are stored.
