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

## 1. Secrets (once)

In the Supabase dashboard → **Edge Functions → Secrets**, add:

| Name | Value |
|---|---|
| `SU94R_LLU_EMAIL` | a LibreLinkUp follower email (the one that follows you) |
| `SU94R_LLU_PASSWORD` | its password |
| `SU94R_DISPLAY_KEY` | a long phrase you make up, e.g. five random words. It is the password of the display link. |
| `SU94R_HEALTH_INGEST_TOKEN` | the same value as `HEALTH_INGEST_TOKEN` on the `su94r-monitor` Worker |
| `SU94R_ALEXA_SKILL_ID` | from step 3 |

Each route stays off (HTTP 503) until its secrets exist.

## 2. Big-screen page

Open this on the screen and bookmark it (or add it to the home screen):

```
https://<your-proxy>.workers.dev/d/<SU94R_DISPLAY_KEY>
```

- **Samsung / LG TV:** open the TV's Internet browser, type the address once, then add a bookmark. The page keeps the screen awake where the browser allows it, and refreshes every minute.
- **Echo Show:** say "Alexa, open Silk", type the address, bookmark it. (For a quick look, the Alexa skill below also shows the number.)
- **Fire TV:** Silk Browser, same as above.
- **Phone / tablet:** open the link, then Share → Add to Home Screen.

Anyone with the link can see the readings. To revoke it, change `SU94R_DISPLAY_KEY` and update your bookmarks.

## 3. Alexa skill (private, on your own Amazon account)

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

If a dose was already logged within the double-dose window (3 hours for rapid or regular, 16 hours for long-acting, 8 hours for NPH or pre-mixed), on any computer or by voice, Alexa says so before asking for the yes. Alexa only records what you say you took; it never suggests an amount.

Doses live in the `su94r_doses` table (`supabase/migrations/20261001_su94r_doses.sql`, service role only) and reach su94r Mini within a minute: in su94r Mini Settings → **Alexa and screens**, paste your big-screen link once.

To say it without "tell my sugar": in the Alexa app, create a **Routine** → *When you say* "4 units of R insulin" → *Add action* → **Customized** → "tell my sugar 4 units of R insulin". One routine per dose you take often.

## 4. Night monitor

`su94r-monitor` already calls `/glucose/latest` every five minutes with `HEALTH_INGEST_TOKEN`. Once `SU94R_HEALTH_INGEST_TOKEN` matches it and the LibreLinkUp login is set, check it with:

```bash
curl -s https://<your-proxy>.workers.dev/glucose/latest -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" | head -c 300
```

## Not a medical device

These screens and the skill are conveniences. LibreLinkUp data can be late or missing. Rely on the Libre app and its alarms for treatment decisions.
