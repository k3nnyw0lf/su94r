# su94r Mini, works with FreeStyle Libre (browser extension)

Live FreeStyle Libre glucose on a laptop or a ward screen, as a Chrome / Edge extension. Part of [su94r](https://su94r.com). Formerly "Libre Mini Graph".

> **Not a medical device.** Readings come through LibreLinkUp and can be late or missing. Use your Libre app or reader, and its alarms, for treatment decisions. su94r Mini never suggests an insulin dose. Not made by or affiliated with Abbott.

## What it does

**See it**
- **Mini window per person:** reading, trend arrow, change over 15 minutes, a 3-hour to 7-day graph with the target range, and a dotted line showing where the reading is heading over the next 20 minutes.
- **Always on top:** the pin button floats the window above every app. On Windows, the optional pin helper keeps it there for good, even after a restart.
- **Number only:** shrink the window to just the reading; double-click to get the graph back.
- **Board:** everyone you follow as tiles on one screen, most urgent first. Made for families, care homes and clinics.
- **Toolbar badge:** the reading (or, for several people, how many need attention), coloured by range.
- **Today's stats** (time in range, average, lows of 15+ minutes) and a **sensor countdown** with a reminder the day before it ends.

**Log it, by clicking the graph at the moment it happened**
- **Insulin** with units, type (rapid, regular, NPH, long-acting, pre-mixed) and **injection site**, with a hint naming your last site so you can rotate.
- **Medicines** you take, picked from RxNorm (U.S. National Library of Medicine, free) with your usual amount pre-filled.
- **Meals** (carbs) and **exercise** (minutes). Click any marker to see or delete it.

**Don't double-dose**
- The window always shows your **last dose, how long ago, and how much rapid insulin is still active** (the same curve as su94r).
- Logging a second rapid or regular dose within 3 hours, a second long-acting dose within 16 hours, an NPH or pre-mixed dose within 8 hours, or the same medicine within 4 hours asks you to confirm first. Insulins added from the medicine list count too, and so do doses logged without an amount.
- An insulin dose needs its number of units, and the type always starts at rapid, so a dose can't be saved as the wrong kind by accident.
- Doses sync between your computers, so a dose logged on one counts on the others. A deleted dose stays deleted everywhere.

**Learn from it**
- **What your history shows:** from your own logged doses, when your rapid insulin starts working, works hardest and is mostly done, compared with and without exercise and by injection area. Timing only, never units.
- **AI look:** a plain-language summary of your patterns with follow-up questions, using the AI you choose (below). It is instructed never to suggest doses.
- **Alerts:** urgent low, low, high, falling fast, rising fast and no data, with an alarm sound and snooze. A low stays raised while readings are late, and a signed-out LibreLinkUp account raises its own sticky alert (no readings means no alarms).
- **Full history:** every reading kept in the browser. Gaps of up to 12 hours fill themselves; older gaps fill from a LibreView CSV import. Export to CSV at any time.

**Health vault and the learner** (Settings → Health vault and what it learned; see docs/health-vault.md)
- **Everything else you measure, next to your glucose:** weight, blood pressure, heart rate, steps, workouts, sleep, fingersticks, ketones, A1c, temperature, water, food and body composition. Typed in, imported from a file, or brought in from your Pixel Watch (Google Health), your Android phone's Health Connect (Samsung Health, Withings, Omron, Oura, Garmin, MyFitnessPal…) or Apple Health. When a watch reports through two routes, each day counts it once.
- **The learner:** from your own data it works out how much and when each insulin lowers you, what carbs, exercise, walking and short sleep do, and how you drift through the day, each with a likely range. When its 1-hour estimates beat plain guesses on days it did not learn from, the graph shows its **estimate line with a shaded range**; click an insulin marker to see what that dose does: how much, strongest when, done when, and how much is still to come. It describes your past; it never suggests a dose.
- **Your own Google Drive:** sign in with Google and a copy of everything goes to a "su94r" folder in your Drive, one file per month, which other computers can bring back. su94r Mini can see only the files it made.
- **Claude:** a read-only connector so Claude can answer questions about your glucose and doses.

**Many people, many computers**
- Add any number of LibreLinkUp follower accounts; each can follow many people.
- Markers, doses, medicines and alert settings sync across every Chrome signed in to the same Google account (the last 30 days of markers; alert on/off and sound stay per computer). Settings → Your computers lists each computer, its version and when it was last seen, and shows any sync problem.
- **One ID everywhere:** the manifest carries a fixed key, so every copy has the extension ID `gcdoahfflgpabebcbhohaklfmpnnggpi` wherever its folder is, and all copies share one sync.
- **Updates install themselves:** when the folder changes (synced folder or `git pull`), the extension checks that every file has arrived (`build.json`), reloads itself and reopens your windows.

## Moving from Libre Mini Graph

Load the `su94r-mini` folder (Load unpacked). su94r Mini finds the old copy, brings over your sign-ins, markers, settings and saved readings, and the old copy stops (its toolbar badge shows →). Then remove the old copy in `chrome://extensions`. On a computer where the old copy is in a different folder, su94r Mini offers the move in Settings.

## Install

1. Download this folder (or clone the repo).
2. Windows: right-click `setup-this-pc.ps1` → **Run with PowerShell**. It copies the folder path, opens the extensions page and installs the pin helper. (Or open `chrome://extensions` yourself.)
3. Turn on **Developer mode**, click **Load unpacked**, paste the path and choose **Select Folder**.
4. Pin the extension's icon (puzzle piece → pin). The settings page opens by itself.

## Turn on sharing (once per person)

1. In the FreeStyle Libre 3 app of the person wearing the sensor: Menu → **Connected Apps** → **LibreLinkUp** → **Add Connection**, and invite the follower email.
2. Install **LibreLinkUp** on a phone, create an account with that email, and accept the invitation and the terms.
3. In the extension's settings, add that LibreLinkUp account.

To try everything first, turn on **Demo mode** in settings (four made-up people).

## Connect an AI

Settings → AI analysis. Easiest first:

| Option | Account | Where your data goes |
|---|---|---|
| **This computer** ([Ollama](https://ollama.com), then `ollama pull gemma3`) | none | nowhere: it stays on your PC |
| **OpenRouter** | one-click sign-in, no key to copy | OpenRouter and the model you pick |
| **Claude** | Anthropic API key | Anthropic |
| **Google Gemini** | Gemini API key (free tier) | Google |
| **Other** | any OpenAI-compatible URL, key and model | that service |

Cloud options ask for your consent first. The AI gets a short summary (daily numbers, hour-of-day pattern, lows and highs, what you logged), never your LibreLinkUp login. Keys stay in the browser and never sync.

## Keep it on top for good (Windows, optional)

```powershell
powershell -ExecutionPolicy Bypass -File pin-helper\install.ps1     # start now and at every sign-in
powershell -ExecutionPolicy Bypass -File pin-helper\uninstall.ps1   # remove
```

It only reads window titles and listens on `127.0.0.1`. Without it, the pin button uses Chrome's float window, which needs one click each time Chrome starts.

## For developers

Bump `version` in `manifest.json` whenever you change the code: running copies compare it every 5 minutes and reload themselves when it differs. Develop in a separate copy and replace the installed folder only with a tested build.

## Privacy

- LibreLinkUp passwords go only to Abbott's server (`libreview.io`) and are never saved; only the sign-in token is kept, on the device.
- Readings and history stay in the browser. Markers and settings travel only through Chrome sync. AI summaries go only to the AI you chose.
- The health vault and the learner stay in the browser. With "Save to Google Drive" on, a copy goes to your own Drive (drive.file: su94r Mini sees only its own files). Google Health is read, never written. The phone inbox on your own su94r server holds what your phone sends only until this computer collects it (at most 14 days).

## Not a medical device

Not made by or affiliated with Abbott. FreeStyle Libre, LibreLinkUp and LibreView are Abbott trademarks. Readings can arrive late or not at all. The extension never suggests how much insulin or medicine to take. Use the Libre app or reader, and its alarms, for treatment decisions. Clinics and hospitals: this is a convenience view, not a validated monitoring system.

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Polls every account each minute, back-fills history, alerts, badge, windows, sync, self-update |
| `libre.js` | LibreLinkUp client: sign-in, region redirect, account-id header, automatic app-version bump |
| `glucose.js` | Shared maths and labels: units, stats, projection, sensor status, CSV export |
| `insulin.js` | Active insulin, last dose, double-dose and duplicate-medicine guards |
| `insights.js` | Insulin timing from the person's own history |
| `meds.js` | RxNorm medicine search |
| `ai.js`, `ai-page.js`, `ai.html` | AI providers, data summary, the AI look page |
| `sync.js` | Chrome sync of markers, settings and the device list |
| `archive.js` | Permanent reading history in IndexedDB |
| `learner.js` | The learner: insulin, carbs, exercise, sleep and drift from your own data; the estimate line |
| `vault.js`, `vault-import.js`, `vault.*`, `vault-page.js`, `connectors.js` | Health vault store, file formats, page and connection cards |
| `google.js`, `drive-month.js`, `ghealth.js` | Google sign-in, the Drive month files, Google Health (Pixel Watch) |
| `voice.js` | Your su94r server: Alexa doses, screens, the phone inbox, the Claude connector |
| `report.*`, `vision.js` | Doctor report (AGP), photo estimates |
| `libreview-csv.js` | Reads LibreView's "Download glucose data" CSV (US and EU formats) |
| `store.js` | Storage layout shared by all pages |
| `mini.*`, `board.*`, `options.*` | The per-person window, the board, settings |
| `offscreen.*` | Plays the alarm sound |
| `pin-helper/`, `setup-this-pc.ps1` | Windows helper that keeps windows on top; one-click setup for a new PC |
