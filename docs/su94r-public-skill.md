# su94r for everyone: the public Alexa skill

A free, read-only Alexa skill ("su94r", said "sugar"). Anyone links it with a LibreLinkUp
**follower account made only for su94r**: they and their family share to that follower from the
FreeStyle Libre app, so each person hears and sees only the people who chose to share with them,
and if Abbott ever blocks su94r the patients' own Libre accounts and alarms keep working.

Code: `workers/sugar.js` (linking, tokens, skill, tiles, deletion), `workers/sugar-page.js` and
`workers/sugar-legal.js` (pages), `docs/alexa/sugar/` (skill package), migrations `20261018b`
(tables + Vault key) and `20261018c` (5-minute tile tick). Tests: `tests/sugar.test.js`.

## What it does and does not do

- Says the glucose, trend and age for each person sharing with the follower; on an Echo Show shows
  the last 3 hours; the home-screen tile (the same `su94r-glucose` package as My Sugar) keeps the
  number on screen and refreshes every 5 minutes.
- Read-only: **no alarms or alerts** (FDA treats CGM alerts as a device function: 21 CFR 862.1350,
  FDA's 2022 MDDS guidance), no dosing, no insulin logging, no stored reading history.
- Stores per account: the follower login sealed with AES-256-GCM (key in Supabase Vault, made by
  `sugar_cred_key()`, never seen by a person), the sealed LibreLinkUp session, the consent record,
  the Amazon user id, token fingerprints and tile settings.
- Deletes everything at once when the skill is turned off in the Alexa app (SkillDisabled) or on
  su94r.com/sugar/delete.

## Pages (served by su94r-proxy on su94r.com/sugar/*)

Supabase serves edge-function HTML as text/plain with a sandbox CSP, so su94r-cgm returns pages as
JSON (`x-su94r-page: 1`) and the proxy serves them (`servePage`). Pages: `link` (sign-in with five
unticked consents), `delete`, `terms`, `privacy`, `health-data`. The su94r.com homepage footer
links the Consumer Health Data Privacy Policy separately (Washington RCW 19.373.020).

## Settings (Supabase → Edge Functions → Secrets)

| Name | What |
|---|---|
| `SU94R_SUGAR_SKILL_ID` | the su94r skill id |
| `SU94R_SUGAR_CLIENT_ID` | `su94r-alexa` (account linking client id) |
| `SU94R_SUGAR_CLIENT_SECRET` | a long secret the operator makes up and types in two places: here and the skill's Account Linking form |
| `SU94R_SUGAR_ALEXA_CLIENT_ID`, `SU94R_SUGAR_ALEXA_CLIENT_SECRET` | the su94r skill's Alexa Skill Messaging credentials (tiles) |
| `SU94R_SUGAR_OPERATOR`, `SU94R_SUGAR_CONTACT` | the legal operator (an LLC) and privacy contact shown on the legal pages |
| `SU94R_SUGAR_LEGAL_REVIEWED` | `1` once a lawyer has reviewed the pages (removes the draft banner) |

## Account linking (developer console → su94r → Build → Account Linking)

Auth Code Grant · Authorization URI `https://su94r.com/sugar/link` · Access Token URI
`https://su94r.com/sugar/token` · Client ID `su94r-alexa` · Your Secret: the made-up secret ·
Authentication scheme: HTTP Basic · Scope `glucose` · Domain `su94r.com`.

## Before submitting for certification (the operator's checklist)

1. **Lawyer review** of the Terms, Privacy Policy, Consumer Health Data Privacy Policy and the five
   consents (FDA wording, release of negligence under Florida's Sanislo standard, arbitration and
   class waiver with opt-out, WA/NV/CT consent rules, California CMIA, Florida 501.171 breach
   notice in 30 days, FTC Health Breach Notification Rule). Then set `SU94R_SUGAR_LEGAL_REVIEWED=1`.
2. **Operate through an LLC** and set `SU94R_SUGAR_OPERATOR` / `SU94R_SUGAR_CONTACT`. Ask a broker
   about general liability, cyber and tech E&O that do not exclude bodily injury.
3. **Amazon:** Policy 3a bars skills that collect health information except in unnamed regions;
   several glucose skills are live in the US anyway. Ask Alexa developer support in writing first.
   The invocation name may need two words ("sugar" alone is generic).
4. **Abbott:** the LibreLinkUp terms forbid automated access and services for others; the follower
   design protects patients' own accounts but not the operator. Ask Abbott for its whitelisted
   Libre Data Sharing API (FDA K223537) or go through a partner such as Tidepool.
5. A breach response plan (contacts, log, notice templates; Florida 30 days, FTC 60).
6. Certification test account: a demo Libre user sharing to a test follower.
