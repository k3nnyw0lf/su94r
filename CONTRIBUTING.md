# Contributing to Su94r

Thanks for your interest in contributing! Su94r is a free, open-source PWA for Type 1 Diabetes health monitoring.

## Quick Start

```bash
git clone https://github.com/k3nnyw0lf/su94r.git
cd su94r
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## Tech Stack

- **React 18** + Vite 5
- **Zustand** for state management
- **Recharts** for data visualization
- **CSS** (custom, no frameworks)
- **PWA** with Workbox

## How to Contribute

1. Fork the repo
2. Create a branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `npm run build` to verify
5. Commit and push
6. Open a Pull Request

## What We Need Help With

- **Accessibility** - ARIA labels, keyboard navigation, screen reader support
- **Internationalization** - translations (especially for medical terms)
- **New AI agents** - specialized health coaches
- **Wearable integrations** - Apple Health Shortcuts, Samsung Health
- **Data visualization** - charts, trends, reports
- **Testing** - unit tests with Vitest
- **Documentation** - user guides, API docs

## Guidelines

- Keep it simple. No unnecessary abstractions.
- Privacy first. No tracking, no analytics, no accounts.
- Free first. Prefer free APIs over paid ones.
- Mobile first. Test on phones.
- Medical safety. Never suggest insulin doses. Always recommend consulting a doctor.

## Code Style

- Functional React components with hooks
- CSS variables for theming (dark/light)
- Monospace font (`Share Tech Mono`) for health data
- Sans-serif font (`Outfit`) for UI text

## License

MIT - your contributions will be under the same license.
