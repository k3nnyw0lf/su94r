# Care circle — waking someone at 3am

Mutual approval inside su94r governs **who may be alerted**. It does not, and
cannot, govern **how loudly their phone rings**. That is decided by iOS and
Android, not by this app.

This document is the per-device setup that closes the gap. Without it, the
escalation ladder is best-effort. With it, the last rungs are reliable.

---

## What the app cannot do, and why

| | |
|---|---|
| **iOS Critical Alerts** — sound through silent switch and Focus | Requires an Apple entitlement granted to specific reviewed native apps. Not available to web apps at all. No amount of in-app consent unlocks it. |
| **Android alarm-importance channels** — bypass Do Not Disturb | Notification channel importance is set by a native app at install. The Web Push API cannot reach it. |

So su94r escalates instead of relying on any single channel:

```
1. SELF        push to the patient
2. CARE_PUSH   push to the care circle
3. CARE_SMS    text the care circle
4. CARE_CALL   ring them
```

A severe low skips the acknowledgement window and goes to the circle
immediately. A sensor that stops reporting **during** a known low is treated as
an emergency, because it is indistinguishable from someone losing consciousness
with the sensor still attached.

---

## Android (the caregiver's phone)

An installed PWA gets a real entry in Android's notification settings, and Do
Not Disturb can be overridden per app.

1. Install su94r to the home screen (Chrome → **Install app**). This step is
   required — a browser tab has no notification channel.
2. **Settings → Apps → su94r → Notifications** — allow all.
3. **Settings → Sound → Do Not Disturb → Apps** → add **su94r**.
4. Test it: set DND, then use **Send test alert** in su94r Settings.

If su94r does not appear under DND → Apps, it was not installed to the home
screen. Repeat step 1.

---

## iPhone (the caregiver's phone)

There is no way to make a web push bypass silent mode on iOS. Do not try to
configure one; it does not exist.

**Use the call rung and Emergency Bypass instead.** iOS will ring a specific
contact through silent mode and Focus:

1. Save the su94r alert number as a contact — name it something unmissable at
   3am, e.g. **"su94r EMERGENCY"**.
2. Open the contact → **Edit** → **Ringtone** → turn **Emergency Bypass ON**.
3. Repeat under **Text Tone** so the SMS rung also cuts through.
4. Enable **Settings → Focus → Sleep → People → Allow calls from** that contact.

This is the only reliable path on iOS, which is why `CARE_CALL` exists as the
final rung rather than a nicety.

---

## Consent model

Enforced in Postgres, not in the UI:

- A link is `pending` until the caregiver **explicitly accepts**. No data flows
  and no alert can fire before that.
- `with check` on the RLS policy permits creating a row only where **you are the
  patient** — you cannot insert yourself into someone else's circle.
- SMS and call are separate per-link consents from push, and require a phone
  number (`su94r_care_link_phone` constraint). Escalation may not use a channel
  the caregiver did not agree to.
- Sharing activity for the leaderboard is a **separate** flag again. Agreeing to
  be woken in an emergency is not agreeing to share your step count.
- Either side can revoke at any time.

---

## What still needs setting up

The decision logic and consent model are built and tested. Delivery needs
credentials that must not pass through this app:

| Rung | Needs |
|---|---|
| Push | VAPID keypair → `VITE_VAPID_PUBLIC_KEY` + Worker secret |
| SMS | An SMS sender. Twilio is ~$0.007/message. |
| Call | A voice provider. A self-hosted one such as Fonoster is the cheapest route. |

---

## The honest limitation

**Do not make su94r the only safeguard against severe nocturnal
hypoglycaemia.** It is a second line of defence, not a replacement for CGM
alarms on a dedicated device, a pump low-glucose-suspend feature, or a
conversation with your care team about overnight patterns.

The escalation ladder exists precisely because no single channel is
trustworthy enough on its own.

---

## Home devices — the rung that actually wakes people

A lamp and a speaker ignore Do Not Disturb entirely, which makes them more
reliable than any notification a web app can send. su94r integrates with **Home
Assistant only** — HA already speaks Alexa, Nest, Hue, Chromecast, TVs and
sirens, so one connection covers every device in the house.

### Two zones, because the point is to reach another room

Someone in a severe hypo may be unable to help themselves — that is what makes
it severe. Alerting only their bedroom solves nothing.

| Zone | Devices | When |
|---|---|---|
| `patient` | The room of the person with diabetes | Woken gently from the first rung |
| `helpers` | Son's room, partner's room, hallway | Only once someone needs to get up — then loud |

The zones hear **different words**:

- Patient: *"Your blood sugar is very low. Treat now with fast sugar."*
- Helper: *"Ken's blood sugar is very low and they have not responded. **Go to Ken now.**"*

Waking someone without telling them what to do wastes the seconds this exists
to buy. No numbers, no trend arrows — nobody parses "68 and falling" at 3am.

### Escalation

| Rung | Patient room | Helper rooms |
|---|---|---|
| SELF | lamp at 30% | — |
| CARE_PUSH | full red light + speech | full red light + speech |
| CARE_SMS | " | + siren |
| CARE_CALL | " | + siren + TV on |

Restricted to night-time **or** severe. A light show for a daytime low you would
treat yourself is how this feature gets switched off.

On stand-down, sirens and TVs go off but **lights stay on** — someone is up
dealing with a hypo in the dark.

### Setup

1. Home Assistant reachable from the internet. **Cloudflare Tunnel is free** and
   is the clean route — no ports opened.
2. Long-lived access token: HA → profile → Security → Long-lived access tokens.
   Store as a **Worker secret**, never in the browser.
3. Configure entity IDs per zone in su94r Settings.

**Alexa specifically:** Echo devices cannot be made to announce from a generic
API — that needs a published Alexa Skill. The practical route is HA's Alexa
Media Player integration, which exposes each Echo as a `media_player` entity
that TTS can target. Nest speakers and Chromecast work natively via
`tts.google_translate_say`.

**Cheapest reliable siren:** any Zigbee/Z-Wave siren, or a smart plug with a
mains doorbell. A TV turning itself on at full volume is remarkably hard to
sleep through, which is why it sits at the top rung.
