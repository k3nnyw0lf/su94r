# su94r 🩸

> **su94r** /ˈʃʊɡər/ — open-source AI health monitor for Type 1 Diabetes and beyond.  
> Free forever. No accounts. No ads. Your data stays yours.

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-06b6d4.svg)](CONTRIBUTING.md)
[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-f38020.svg)](https://dash.cloudflare.com)

**[su94r.com](https://su94r.com)** · [Report Bug](https://github.com/k3nnyw0lf/su94r/issues) · [Request Feature](https://github.com/k3nnyw0lf/su94r/issues)

---

```
 ____  _   _  ___  _  _  ____
/ ___|| | | ||/ _ \| || ||  _ \
\___ \| | | || (_) | || || |_) |
 ___) | |_| | \__, |__  _|  _ <
|____/ \___/    /_/   |_| |_| \_\

su94r = sugar (leet speak)
open source · free forever · your data
```

---

## What is this?

A PWA (installable on iPhone + Android) that:
- Reads your CGM glucose **live** (Libre, Dexcom, Nightscout)
- Tracks **12 health metrics** — sleep, HR, BP, weight, steps, SpO2, ketones, meds, labs + more
- Has **10 AI health agents** powered by free models (Groq, Gemini, Mistral, Ollama)
- Sends **push notifications** for glucose alerts — even when the app is closed
- Connects to **any wearable** — Fitbit, Oura, Garmin, Apple Watch, Withings
- Costs **$0** to run (free APIs + free Cloudflare hosting)

Built by someone with T1D, for everyone with T1D. Health is expensive. Code is free.

---

## One-click deploy

[![Deploy to Cloudflare Pages](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/k3nnyw0lf/su94r)

Or manually:

```bash
git clone https://github.com/k3nnyw0lf/su94r
cd su94r
npm install
cp .env.example .env.local
# Add at least one free API key (Groq recommended)
npm run dev
```

---

## Free API keys — get started in 5 minutes

| Service | Key | What it unlocks | Sign up |
|---|---|---|---|
| **Groq** | `VITE_GROQ_API_KEY` | All 10 AI agents (Llama 3.1 70B, ultra fast) | [console.groq.com](https://console.groq.com) — free |
| **Gemini** | `VITE_GEMINI_API_KEY` | Backup AI + nutrition analysis | [aistudio.google.com](https://aistudio.google.com) — free |
| **Mistral** | `VITE_MISTRAL_API_KEY` | Third AI fallback | [console.mistral.ai](https://console.mistral.ai) — free |
| **USDA** | `VITE_USDA_API_KEY` | Nutrition/food data | [fdc.nal.usda.gov](https://fdc.nal.usda.gov/api-guide.html) — free |
| **Libre/Dexcom** | Settings UI | Your CGM readings | Your existing account |

All other features (weather, drug info, PubMed research) work with **zero keys**.

---

## Paid upgrades (optional)

| Service | Cost | Why it's worth it |
|---|---|---|
| Claude Haiku | ~$0.25/M tokens | Best medical reasoning of any model |
| Supabase | Free tier | Sync data across family devices |
| Twilio | ~$0.007/SMS | SMS alerts to family members |

---

## Supported devices

### CGM (Continuous Glucose Monitors)
| Device | How |
|---|---|
| FreeStyle Libre 2/3/3+ | LibreLinkUp API — add email/password in Settings |
| Dexcom G6/G7 | Dexcom Share API — add username/password in Settings |
| Any CGM | Nightscout — self-hosted bridge, add URL in Settings |

### Wearables
Fitbit · Garmin · Oura Ring · Apple Watch (via Shortcuts) · Withings · Polar · Whoop

### Insulin Pumps (via Nightscout)
Omnipod 5 · Tandem t:slim X2/Mobi · Medtronic 780G · Any Loop/AndroidAPS system

---

## AI Agents

| Agent | What it knows |
|---|---|
| 🎯 GlucoCoach | TIR, HbA1c estimation, dawn phenomenon, CV% |
| 🍽️ MealAdvisor | Carb counting, I:C ratios, fat+protein delays |
| 💤 SleepCoach | Overnight glucose, sleep stages, dawn phenomenon |
| 🏃 ActivityCoach | Exercise glucose effects, temp basal strategies |
| 💊 MedManager | Insulin types, drug interactions, sick-day rules |
| 🔬 LabInterpreter | HbA1c, lipids, eGFR, kidney markers |
| 🧠 MindCoach | Diabetes distress, burnout, hypoglycemia fear |
| 🍎 NutritionAnalyst | Macros, micronutrients, GI/GL, meal planning |
| 📈 TrendAnalyst | Multi-metric correlations, predictive insights |
| 🚨 EmergencyGuide | Severe lows, glucagon (Gvoke/Baqsimi), DKA protocols |

---

## Notifications

**Android** — push notifications work out of the box in Chrome.  
**iPhone** — add to Home Screen first (Share → Add to Home Screen), then allow notifications. Requires iOS 16.4+.  
**Critical alerts** — bypass silent mode, require interaction to dismiss, SOS vibration pattern.

---

## Deploy to Cloudflare Pages (recommended)

1. Fork this repo
2. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
3. Select your fork
4. Build settings:
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
5. Add environment variables (API keys) in Pages settings
6. Add your custom domain under Pages → Custom Domains

---

## Self-host (Docker)

```bash
docker compose up -d
# App runs at http://localhost:3000
```

---

## Contributing

This project exists because healthcare is too expensive and knowledge should be free.

**What we need most:**
- 🔌 New device integrations (Whoop, Polar, iHealth)
- 🌍 Translations (Spanish, Portuguese priority)
- 📱 Apple Shortcuts for Apple Health bridge
- 🧪 Unit tests
- 📖 Device setup guides

See [CONTRIBUTING.md](CONTRIBUTING.md) — no contribution too small.

---

## License

MIT. Take it. Use it. Help people.

---

*Built by [@k3nnyw0lf](https://github.com/k3nnyw0lf) · Cape Coral, FL*  
*"Health is expensive. Let's help each other."*
