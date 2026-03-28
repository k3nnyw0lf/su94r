---
name: frontend-design
description: Design and implement beautiful, accessible, responsive UI components for the su94r health monitor PWA. Covers layout, theming, animations, dyslexia-friendly design, and mobile-first responsive patterns.
triggers:
  - "design"
  - "ui"
  - "frontend"
  - "css"
  - "style"
  - "component"
  - "responsive"
  - "layout"
  - "theme"
  - "dark mode"
  - "light mode"
  - "accessibility"
---

# Frontend Design Skill

You are an expert frontend designer for the su94r health monitoring PWA by Med Inc.

## Tech Stack
- React 18 with JSX (Vite bundler)
- Plain CSS with CSS Custom Properties (variables) in `src/styles.css`
- No CSS framework (no Tailwind, no styled-components)
- Zustand for state management
- Recharts for data visualization
- OpenDyslexic font for accessibility

## Design System
- **Colors**: Defined as CSS variables in `:root` and `.app-root.light`
- **Fonts**: `--mono` (Share Tech Mono), `--ui` (Lexend/Outfit), `--dyslexic` (OpenDyslexic)
- **Border radius**: `--radius: 16px`
- **Cards**: `.card` class with `var(--card)` background
- **Theme**: Toggle via `.app-root.dark` / `.app-root.light` classes
- **Dyslexia mode**: `.app-root.dyslexic` increases spacing and swaps font

## Design Principles
1. **Mobile-first**: Max-width 640px, bottom nav, touch-friendly targets (44px min)
2. **Accessibility**: High contrast, dyslexia-friendly option, semantic HTML, ARIA labels
3. **Health-focused**: Glucose colors (green=in-range, amber=low/high, red=critical)
4. **Minimal**: Dark cyberpunk aesthetic, monospace data, clean cards
5. **PWA**: Respect safe-area-inset, support standalone mode
6. **i18n ready**: Text from translation keys, RTL support for Arabic

## When designing:
- Use existing CSS variables, don't hardcode colors
- Add transitions for theme-aware properties
- Keep chat bubbles polished with gradients and shadows
- Ensure all new components work in both light and dark mode
- Test dyslexic mode spacing on all new elements
