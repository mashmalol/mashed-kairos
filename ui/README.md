# jev-traderbot — ui

React dashboard (Vite + React 18 + Tailwind), per `SEED-CONTEXT.md`. **Read-only**: it
consumes the bot's `GET /events` SSE stream and never imports from `src/` or calls
the Minara API.

Branding: the header is **mashed kairos**. The asset pair next to it is a user
display choice (persisted in `localStorage`, key `kairos.pair`); the bot's actual
market is fixed by its `MARKET` env var.

## Run

```bash
cp .env.example .env        # PROXY_TARGET=http://localhost:3000
npm install                 # package-lock.json is committed; bun's registry fetch 403s here
npm run dev                 # http://localhost:5173
```

The backend must be running (`bun run start` at the repo root, port 3000).

**No live backend?** `bun run scripts/demo-feed.ts` at the repo root serves a synthetic
feed on `:3003` with the same contract (blocks, async receipts, fills, late blocks).
Point the UI at it with `PROXY_TARGET=http://localhost:3003` and restart `npm run dev`.

## Structure

```
ui/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.ts / postcss.config.js
└── src/
    ├── main.tsx / App.tsx          # shell: backdrop → veil → bento cards → trade log
    ├── components/
    │   ├── MagicBento.tsx          # ReactBits MagicBento (TS-TW registry, verbatim)
    │   ├── BentoCard.tsx           # card content + probability bars
    │   ├── TradeLog.tsx            # the ledger panel: filter, search, freeze, csv
    │   ├── Hyperspeed.jsx/.css     # ReactBits Hyperspeed (verbatim, .jsx)
    │   └── HyperspeedBackdrop.tsx  # fixed z-0 wrapper, pointer-events: none
    └── lib/
        ├── types.ts                # SSE wire types (copied from src/trader.ts)
        ├── sse.ts                  # EventSource client for /events
        ├── ledger.ts               # booked/filled rows: merge, cap, persist (pure)
        ├── useLedger.ts            # SSE → ledger state
        └── useHyperspeedDriver.ts  # SSE → Hyperspeed props contract
```

## Trade log

A full-width ledger under the bento grid, in two row kinds:

| kind | source | meaning |
|---|---|---|
| **booked** | `quote` on a block event, then patched by the async `quote` frame | the order that block put on the book: `sent`/`sim` → `placed`/`reverted`/`lost` with the real order id and gas |
| **done** | `fill` frame | a taker hit one of our resting orders |

It cannot simply read `history`: that keeps block events with `fill: null` (fills are
separate frames) and the original `status: "sent"` (receipts land later). So `ledger.ts`
merges both streams by block, never downgrades a final receipt, and persists **filled**
rows in `localStorage` (`kairos.fills.v1`) keyed to the bot's `startedAt` — a dashboard
reload keeps the log, a bot restart starts a fresh one.

Controls, all view-side (nothing is ever sent to the bot):

- **all / booked / done / failed** filter chips with live counts
- **search** across block, side, status, order id and tx hash
- **↓ newest / ↑ oldest** sort (block is the primary key, so a burst of events in the
  same millisecond still reads in block order)
- **live / frozen**: freeze the view to click into a row; new rows keep arriving and the
  header shows how many are waiting
- **csv**: exports the current filtered view
- click any row to expand block, status, order id, gas, model p(buy), capped/simulated
  flags, notional and the full tx hash with a copy button

Retention is per kind — 300 booked, 200 filled — so a flood of orders (one per block,
~3/s) cannot evict the fills the log exists for.

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
