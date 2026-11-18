# jev-traderbot — ui

React dashboard (Vite + React 18 + Tailwind), per `SEED-CONTEXT.md`. **Read-only**: it
consumes the bot's `GET /events` SSE stream and never imports from `src/` or calls
the Minara API.

Branding: the header is **mashed kairos**. The asset pair next to it is a user
display choice (persisted in `localStorage`, key `kairos.pair`); the bot's actual
market is fixed by its `MARKET` env var.

## Run

```bash
cp .env.example .env        # VITE_API_URL=http://localhost:3000
bun install
bun run dev                 # http://localhost:5173
```

The backend must be running (`bun run start` at the repo root, port 3000).

## Structure

```
ui/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.ts / postcss.config.js
└── src/
    ├── main.tsx / App.tsx          # shell: backdrop → veil → bento cards
    ├── components/
    │   ├── MagicBento.tsx          # ReactBits MagicBento (TS-TW registry, verbatim)
    │   ├── BentoCard.tsx           # card content + probability bars
    │   ├── Hyperspeed.jsx/.css     # ReactBits Hyperspeed (verbatim, .jsx)
    │   └── HyperspeedBackdrop.tsx  # fixed z-0 wrapper, pointer-events: none
    └── lib/
        ├── types.ts                # SSE wire types (copied from src/trader.ts)
        ├── sse.ts                  # EventSource client for /events
        └── useHyperspeedDriver.ts  # SSE → Hyperspeed props contract
```

## Deviations from the seed (documented per seed §4.1)

- **Hyperspeed is `.jsx`** (option (a)): kept verbatim from ReactBits; `tsconfig.json`
  has `allowJs: true`, `checkJs: false`.
- **MagicBento is the TS-TW registry version**, which is items-based
  (`items: [{ content, colSpan, rowSpan }]`). The seed's illustrative App shows a
  children API from an older ReactBits iteration; here `BentoCard` renders inside
  `item.content` and card spans use `colSpan`/`rowSpan`. All seed props are
  supported: `enableStars`, `enableSpotlight`, `enableBorderGlow`, `enableTilt`,
  `enableMagnetism`, `clickEffect`, `spotlightRadius`, `glowColor` (blue
  `"59, 130, 246"`), `disableAnimations`.
- The engine injects its own styles (`<style>{STYLE}</style>`), so no extra CSS
  import is needed for it; `MagicBento.css` is not used by the TS-TW version.

## Behavioral contract highlights

- Hyperspeed mounts **only after the first SSE block** (`latest && <HyperspeedBackdrop/>`)
  and is never re-keyed on block numbers.
- `interactive` is false by default; the header's **warp** button (or Escape to exit)
  opts into pointer events + hold-to-boost and dims the cards. Boost is visual only —
  it is never wired to trading actions.
- `prefers-reduced-motion`: speed ×0.3, dimmed glow, no boost pulses.
- Weak hardware (`hardwareConcurrency ≤ 4`): density 20, no stars, animations off,
  smaller spotlight radius — decided once at mount.
- `minaraFailures` (emitted by the backend once the Minara adapter is active) drives
  model health: failures > 0 ⇒ no poles, no dust, glow 0.05 — the road goes dark.
