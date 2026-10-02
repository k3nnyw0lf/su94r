# Glucose on a TV, an Echo Show, Alexa and any screen

Three things read live LibreLinkUp data from a server, so they work with the laptop off:

- **Big-screen page:** a link you open once on a TV browser, an Echo Show, a tablet, a phone or a spare monitor. One person fills the screen; several become tiles, most urgent first.
- **Alexa skill:** "Alexa, ask my sugar how I'm doing." It speaks the reading, the trend and how old it is. On an Echo Show it also shows the number.
- **Night monitor feed:** `su94r-monitor` gets real readings at last (`/glucose/latest`).

## How it fits together

```
TV / Echo Show / phone ─┐
Alexa ──────────────────┼─▶ su94r-proxy (Cloudflare Worker) ─▶ su94r-cgm (Supabase edge function) ─▶ LibreLinkUp
su94r-monitor ──────────┘        serves the page                  holds the secrets, checks keys
```

LibreView does not answer requests that come from Cloudflare Workers (HTTP 403), so the Worker hands every LibreLinkUp request to `su94r-cgm`, a Supabase edge function, which makes it the way the LibreLinkUp app does. LibreLinkUp has no public API; it may change or stop working at any time. Source: `workers/proxy.js`, `workers/cgm-core.js`, `workers/display.js`, `workers/alexa.js`, `supabase/functions/su94r-cgm/`.

## 1. Connect su94r Mini (once, no secrets to type)

1. Open the server for its first connection for 15 minutes: set the Supabase secret `SU94R_CLAIM_OPEN_UNTIL` to a time in milliseconds (`Date.now() + 15 * 60e3`).
2. In su94r Mini → Settings → **Alexa and screens**, press **Connect to my su94r server**. su94r Mini shows the server the LibreLinkUp sign-in it already has; the server checks it with LibreLinkUp, keeps that sign-in (no password is stored), and gives this computer its own key. su94r Mini hands it a fresh sign-in every 6 hours.
3. From then on only the same LibreLinkUp account can connect more computers; the window is not needed again. `GET /connect/status` shows `{ owner, llu, alexa, open }`.

On your own computers you can skip the click: put a `connect-here.json` file with `{ "server": "https://<your-proxy>.workers.dev" }` in the extension folder; su94r Mini connects by itself within 5 minutes while nothing is connected. Remove the file afterwards (it is never committed).

Optional Supabase secrets:

| Name | Value |
|---|---|
| `SU94R_LLU_EMAIL`, `SU94R_LLU_PASSWORD` | only if you prefer the server to sign in to LibreLinkUp by itself instead of using su94r Mini's sign-in |
| `SU94R_DISPLAY_KEY` | an extra fixed key for the big-screen link (each connected computer already has its own) |
| `SU94R_HEALTH_INGEST_TOKEN` | the same value as `HEALTH_INGEST_TOKEN` on the `su94r-monitor` Worker |
| `SU94R_ALEXA_SKILL_ID` | from step 3 |

## 2. Big-screen page

Open this on the screen and bookmark it (or add it to the home screen); su94r Mini Settings shows it once connected:

```
https://<your-proxy>.workers.dev/d/<this computer's key>
```

- **Samsung / LG TV:** open the TV's Internet browser, type the address once, then add a bookmark. The page keeps the screen awake where the browser allows it, and refreshes every minute.
- **Echo Show:** say "Alexa, open Silk", type the address, bookmark it. (For a quick look, the Alexa skill below also shows the number.)
- **Fire TV:** Silk Browser, same as above.
- **Phone / tablet:** open the link, then Share → Add to Home Screen.

Anyone with the link can see the readings, so keep it private. Paired screens can be removed in su94r Mini Settings; a computer's own key is revoked by deleting its `owner` row in `su94r_screens` (then press Connect again).

### Share to another phone (QR code, nothing to type)

su94r Mini → Health vault → **Share to another phone** → **My other phone** or **A family member's phone**. It shows a QR code; scan it with that phone's camera and open the link. The phone links itself (`/tv#join=…`: the one-time invite rides after the `#`, so it never reaches a server log), keeps its own token, and shows the glucose live. The first time it opens **Phone options**:

- **Add to Home screen** so it is one tap away.
- **Low alerts on this phone**: install ntfy, tap **Subscribe in ntfy**. Your other phone gets your own alerts; a family phone gets the care topic, which only speaks when you have switched on **Tell caregivers too** and a low is not handled.
- **Watch and widgets**: the phone gets its own Nightscout-style token for GlucoDataHandler (and the Pixel Watch); address and token have Copy buttons.

Each code works once, for 10 minutes. Linked phones appear with the other screens in su94r Mini Settings, where **Remove** cuts them off at once. Code: `workers/screens.js` (shareNew, shareClaim), `share/extras` in `workers/cgm-core.js`, the page in `workers/display.js`.

## 3. Alexa skill (private, on your own Amazon account)

**With the ASK CLI** (no clicking in the console): sign in once with `ask configure` (if it says there is no Vendor ID, first open <https://developer.amazon.com/alexa/console/ask> and finish the free developer profile). Then:

```bash
ask smapi create-skill-for-vendor --manifest "file:docs/alexa/skill.json"
ask smapi set-interaction-model -s <skill id> -g development -l en-US --interaction-model "file:docs/alexa/interaction-model.json"
ask smapi set-skill-enablement -s <skill id> -g development
```

and put the skill ID in `SU94R_ALEXA_SKILL_ID`. Change the endpoint in `skill.json` to your own proxy first. On Windows inside the Claude desktop app, install the CLI with `npm install --prefix %USERPROFILE%\tools\ask-cli ask-cli` (a global install lands in a private AppData copy other windows cannot see).

**In the console:**

1. Go to <https://developer.amazon.com/alexa/console/ask> and sign in with the Amazon account your Echo uses.
2. **Create Skill** → name `My Sugar` → **Custom** model → **Provision your own** → **Start from Scratch**.
3. **Interaction Model → JSON Editor**: paste `docs/alexa/interaction-model.json`, **Save**, **Build skill**.
4. **Endpoint** → **HTTPS** → `https://<your-proxy>.workers.dev/alexa`, certificate option: *My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority*. **Save**.
5. **Interfaces** → turn on **Alexa Presentation Language** (for the number on Echo Show screens). **Save**, **Build**.
6. Copy the **Skill ID** (`amzn1.ask.skill.…`) into the `SU94R_ALEXA_SKILL_ID` secret.
7. **Test** tab → set testing to **Development**.

Then say: "Alexa, open my sugar", "Alexa, ask my sugar how is Ana doing".

Every request must carry Amazon's signature (checked in `workers/alexa-verify.js`), match the skill ID and be under 150 seconds old. Keep the skill in Development (private) anyway.

### Logging insulin by voice

- "Alexa, tell my sugar 4 units of R insulin." Alexa repeats it back ("Log 4 units of regular insulin now?") and logs it only after you say **yes**.
- "Alexa, tell my sugar I took 20 units of Lantus 30 minutes ago."
- "Alexa, ask my sugar when I last took insulin." Alexa reads the last doses from every device.
- "Alexa, tell my sugar I ate 40 grams." Alexa repeats it back and logs the meal only after **yes**; it reaches su94r Mini as a meal marker (the learner uses it).
- "Alexa, ask my sugar where I'm heading." Alexa reads su94r Mini's estimate for 30 and 60 minutes ahead with its range, only when the learner has passed its accuracy check and su94r Mini sent it in the last 20 minutes. If the low end is under 70 it says to keep fast sugar close. It never suggests a dose.

If a dose was already logged within the double-dose window (3 hours for rapid or regular, 16 hours for long-acting, 8 hours for NPH or pre-mixed), on any computer or by voice, Alexa says so before asking for the yes. Alexa only records what you say you took; it never suggests an amount.

Doses live in the `su94r_doses` table (`supabase/migrations/20261001_su94r_doses.sql`, service role only) and reach su94r Mini within a minute once it is connected (step 1).

To say it without "tell my sugar": in the Alexa app, create a **Routine** → *When you say* "4 units of R insulin" → *Add action* → **Customized** → "tell my sugar 4 units of R insulin". One routine per dose you take often.

## 4. Low alerts on the phone (night safety net)

The server itself checks every 5 minutes (a database cron calls `night/tick`, see `supabase/migrations/20261002e_su94r_night_cron.sql`), with every computer off, and pushes lows to the phone through **ntfy** (free app, no account):

1. su94r Mini → Health vault → **Low alerts on your phone**. Install ntfy on the phone, scan the QR code, subscribe, then **Send a test alert**.
2. A low is pushed with an **I'm OK** button and repeats until it is tapped or the glucose is back up: every 20 minutes by day, 10 at night (22:00–07:00), 5 when severe (below 55). A low whose sensor goes silent, and a server that loses its LibreLinkUp sign-in, are pushed too.
3. Family: they subscribe to the care topic (second QR code) and you switch on **Tell caregivers too**; the care ladder (`src/lib/care/escalation.js`) decides when they hear.

In ntfy, let the topic override Do Not Disturb for urgent alerts, or night alerts stay silent. Optional secrets `SU94R_NTFY_BASE` / `SU94R_NTFY_TOKEN` point it at your own ntfy server or account. Code: `workers/night.js`, table `su94r_night`.

### The same alerts on Telegram (tap a link, press Start)

su94r Mini → Health vault → **Low alerts on Telegram**:

1. Once: **Open BotFather**, send `/newbot`, pick a name and a username ending in "bot", paste the token BotFather gives you into the card and press **Save**. It goes only to your su94r server, which checks it with Telegram and points the bot at itself (with a secret header, so only Telegram can call it). No route ever returns the token.
2. **Link my Telegram** (or a family member's): tap **Open in Telegram** or scan the QR code, then press **Start** in Telegram. The link works once, for 15 minutes. A phone you shared (above) finds the same button in its Phone options.
3. Alerts arrive with an **I'm OK** button; `/sugar` answers with the glucose now; `/stop` unlinks. Chats that never linked get no answer at all.

An alert counts as delivered when ntfy or Telegram took it. **Pause Telegram alerts** stops only this bot. Code: `workers/telegram.js`, tables `su94r_telegram_bot`, `su94r_telegram_chats`, `su94r_telegram_links`.

### The older su94r-monitor Worker

`su94r-monitor` already calls `/glucose/latest` every five minutes with `HEALTH_INGEST_TOKEN`. Once `SU94R_HEALTH_INGEST_TOKEN` matches it and su94r Mini is connected, check it with:

```bash
curl -s https://<your-proxy>.workers.dev/glucose/latest -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" | head -c 300
```

## 5. Google devices

There is no "Hey Google, ask my sugar" skill: Google switched off custom voice apps (Conversational Actions) in June 2023, and Google Home smart-home sensors can only report fixed kinds of numbers (air quality, CO₂ and similar), not glucose. What works instead:

- **Gemini (web, Pixel, any Android phone):** su94r Mini → Health vault → **Claude, Gemini and other AI apps** → **Make the AI address**. Open <https://gemini.google.com/apps> → **Custom apps**, paste the address into "Add a custom app link", press **Next**. Then ask Gemini, or say "Hey Google" on the phone: "@su94r what is my glucose?". Read-only: Gemini cannot log doses (Alexa can, with a spoken yes).
- **Nest Hub, Chromecast, Google TV:** show the big-screen page. In Chrome, open the page → ⋮ → **Cast…** → pick the device (it stays while that Chrome tab is open). Or, from any computer on the same Wi-Fi, `catt cast_site <big-screen link>` (free, `pip install catt`) makes the device load the page itself.
- **Pixel Watch and phone widgets:** the Nightscout-style feed with GlucoDataHandler (see `docs/widgets.md`).

## Not a medical device

These screens and the skill are conveniences. LibreLinkUp data can be late or missing. Rely on the Libre app and its alarms for treatment decisions.
