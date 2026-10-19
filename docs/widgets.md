# Glucose on your phone's home screen and your watch

**Fastest: share by QR code.** su94r Mini → Health vault → **Share to another phone**, scan the
code with the phone. The phone links itself and its **Phone options** hand it a watch / widget
token with Copy buttons, so the steps below need no typing. (See docs/tv-and-alexa.md.)

### Pixel Watch, step by step (about 3 minutes)

1. On the phone, install **GlucoDataHandler** from the Play Store and open it.
2. **Sources → Nightscout**: paste the address (`https://<your server>/ns`) and the token from
   Phone options (or from the link below). Turn the source on; the reading shows in a few seconds.
3. On the watch, open the Play Store and install **GlucoDataHandler** there too (it pairs itself).
4. Long-press the watch face → **Customize** → tap a complication slot → **GlucoDataHandler** →
   glucose value (or value + arrow).
5. Optional: GlucoDataHandler → **Alarms** for watch vibration on lows. The su94r night alerts
   (ntfy) keep working either way.

All of these read your own su94r server with a private link. Make it in su94r Mini:
**Settings → Health vault → Watch faces and phone widgets → Make a link**. You get:

* a **widget link**: `https://<your server>/screen/glance?token=<token>` (a small JSON with the
  value, arrow, change and colour), and
* a **Nightscout address** `https://<your server>/ns` with the same **token**.

Anyone with the link can see your glucose (nothing else). Remove it any time under
**Settings → Alexa and screens → Screens and widgets**.

## Pixel Watch (Wear OS)

**GlucoDataHandler** (free): on the phone choose **Sources → Nightscout**, URL
`https://<your server>/ns`, token = the token. (Or skip su94r and choose **LibreLinkUp** with your
follower account.) Install GlucoDataHandler on the watch too and add its complication to the
watch face. xDrip+ ("Nightscout follower") and Juggluco accept the same address and token.

## Android home screen (KWGT)

1. Install **KWGT** and add a KWGT widget to the home screen; tap it to edit.
2. Add a **Text** item with the formula `$wg("<widget link>", json, .value)$ $wg("<widget link>", json, .arrow)$`
3. Add a second **Text** with `$wg("<widget link>", json, .delta)$ · $wg("<widget link>", json, .ago)$`
4. For the colour, set the text **Paint → Color** to the formula `$wg("<widget link>", json, .color)$`.
5. KWGT refreshes web data about every 15 minutes (Settings → Advanced → Update interval).

## iPhone home screen and lock screen (Scriptable)

The script lives at **su94r.com/widgets/su94r-scriptable.js** (source: `public/widgets/su94r-scriptable.js`).

1. In su94r Mini: **Settings → Health vault → Watch faces and phone widgets → Make a link**, and send the widget link to the iPhone.
2. On the iPhone open **su94r.com/widgets/su94r-scriptable.js** in Safari, select all and copy. In **Scriptable** (free) tap **+**, paste, name it `su94r`.
3. Add a Scriptable widget to the home screen, or to the lock screen (press and hold the lock screen → **Customize** → **Lock Screen** → add Scriptable). Press and hold the widget → **Edit Widget** → Script **su94r**, Parameter: the widget link.

Home screen: name, number and arrow in colour, the change over 15 minutes, how old it is, a red background during a low. Lock screen (inline, round or rectangular): the number, arrow and a LOW / HIGH / OLD word, since iOS tints lock-screen widgets. The link stays in the widget's Parameter, never in the script. iOS decides how often widgets refresh (often every 5–15 minutes); it is not an alarm.

## Echo Show

The Alexa skill (docs/tv-and-alexa.md) shows the number, the trend and the last 3 hours on an Echo
Show when you ask "Alexa, ask my sugar how I am". Turn on **Interfaces → Alexa Presentation
Language** in the skill's build settings.

## Fridge, TV, tablet

Open **su94r.com/tv** on the screen and type its code in su94r Mini (Settings → Alexa and screens).
