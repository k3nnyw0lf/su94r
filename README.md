# su94r 🩸

> **su94r** /ˈʃʊɡər/: an open-source health monitor for Type 1 diabetes.
> Free, no ads, MIT licensed. Built by someone who has T1D.

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-06b6d4.svg)](CONTRIBUTING.md)

**[su94r.com](https://su94r.com)** · [Report a bug](https://github.com/k3nnyw0lf/su94r/issues) · [Request a feature](https://github.com/k3nnyw0lf/su94r/issues)

> [!IMPORTANT]
> **su94r is not a medical device.** It is not cleared or approved by the FDA or any regulator.
> Readings can be late, missing or wrong. Never make a treatment decision from su94r alone:
> check your sensor app or a fingerstick, and follow your care team. su94r never recommends
> an insulin dose, a ratio, a basal rate or a pump setting.

---

## What's in this repo

| Part | What it is | Folder |
|---|---|---|
| **The app** | A PWA (installable on iPhone and Android) for live glucose, logging, exercise and 10 AI agents | `src/` |
| **su94r Mini** | A Chrome extension: a small always-visible graph of your FreeStyle Libre readings on your laptop | `extension/` |
| **Big screen and Alexa** | A page for a TV, Echo Show or spare monitor, and an Alexa skill ("Alexa, ask my sugar…") | `workers/`, `docs/tv-and-alexa.md` |
| **Night monitor** | A scheduled Worker that keeps checking when every phone is asleep and can escalate to caregivers | `workers/glucose-monitor.js`, `docs/care-circle.md` |

## The app

- Live glucose from **FreeStyle Libre** (through LibreLinkUp), **Dexcom G6/G7** (through Dexcom Share) or **any CGM through Nightscout**
- Logs for insulin, food, sleep, weight, blood pressure, ketones, medicines, labs and more
- An exercise library with a glucose check before each session
- 10 AI agents that run on free models (Groq, Gemini, Mistral, local Ollama) or a paid one you choose
- Alerts while the app is open. Alerts with the app closed need the optional night monitor (SMS through Twilio, or Home Assistant)
- Other data: Pixel Watch and Fitbit through the Google Health API (`docs/google-health.md`), Apple Health through a Shortcut (`docs/apple-health.md`), a Wyze scale (`scripts/wyze-sync.py`)

### Run it

```bash
git clone https://github.com/k3nnyw0lf/su94r
cd su94r
npm install
cp .env.example .env.local
npm run dev
```

Every key in `.env.example` is optional. Keys you put in `VITE_*` variables are built into the page
and anyone who opens your site can read them, so only use free-tier keys there, or enter keys in
the app's Settings (they stay in your browser).

### Deploy on Cloudflare Pages

1. Fork this repo
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → your fork
3. Build command `npm run build`, output directory `dist`
4. Optional: your own domain under Custom Domains

To reach LibreLinkUp, Dexcom Share or Nightscout the app talks to a small proxy (`workers/proxy.js`).
You can run your own; see `docs/tv-and-alexa.md` for the setup.

## su94r Mini (Chrome extension)

A floating graph that stays on screen while you work. It reads your own LibreLinkUp account,
keeps a local history, warns before you log the same insulin twice, and shows how long your
insulin seems to take to act from your own data. Several people can be followed at once
(families, care homes). Everything stays in your browser unless you turn on Chrome sync or
an AI service. Install and use: [extension/README.md](extension/README.md).

## AI agents

| Agent | What it covers |
|---|---|
| 🎯 GlucoCoach | Time in range, estimated A1c, dawn phenomenon, variability |
| 🍽️ MealAdvisor | Carb counting, how fat and protein delay a rise |
| 💤 SleepCoach | Overnight patterns, sleep and glucose |
| 🏃 ActivityCoach | How exercise moves glucose, delayed lows |
| 💊 MedManager | Insulin types, drug interactions, sick-day rules |
| 🔬 LabInterpreter | A1c, lipids, kidney markers |
| 🧠 MindCoach | Diabetes distress, burnout, fear of lows |
| 🍎 NutritionAnalyst | Macros, glycemic index and load, meal ideas |
| 📈 TrendAnalyst | Patterns across your metrics |
| 🚨 EmergencyGuide | Severe lows, glucagon, DKA warning signs |

Every agent has the same hard limit: it explains, it never calculates or changes a dose or a pump
setting. When you use an agent, your question and a summary of your data go to the AI service you
picked; read that service's privacy terms.

## Notifications

**Android:** Chrome notifications work while the app is open.
**iPhone:** add su94r to the Home Screen first (Share → Add to Home Screen), then allow notifications (iOS 16.4+).
Web notifications follow your phone's silent and focus settings; they cannot override them.
Do not rely on su94r as your only low alarm. Keep your sensor app's alarms on.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: no ads, no tracking, no selling data. CGM logins and
readings pass through the proxy only to reach your CGM service.

## Trademarks

su94r is independent. It is not made, endorsed or supported by Abbott, Dexcom, Google, Apple,
Amazon, Samsung or any device maker. FreeStyle Libre and LibreLinkUp are trademarks of Abbott.
Dexcom is a trademark of Dexcom, Inc. Other names belong to their owners and are used only to
say what su94r works with. LibreLinkUp and Dexcom Share have no public API for this; su94r uses
them the way their own apps do, and they may change or stop working at any time.

## Contributing

What helps most: device integrations, translations (Spanish and Portuguese first), Apple Health
Shortcuts, tests and setup guides. See [CONTRIBUTING.md](CONTRIBUTING.md).

Third-party code and data used here are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. Take it, use it, help people.

*Built by [@k3nnyw0lf](https://github.com/k3nnyw0lf)*
