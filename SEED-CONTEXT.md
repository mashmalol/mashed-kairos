Seed Context: Migrate jev-traderbot from JevModel to Minara Agent API (Kairos)
1. System Identity
This is jev-traderbot: a single-decision-per-block market-making bot on Monad.

It watches the Kuru cbBTC-USDC order book and emits a buy, sell, or hold decision every block. Block time on Monad is approximately 300 ms.

The decision loop is block-bound. A late decision is worse than no decision. If the model misses the block deadline, the loop must emit hold and skip the quote entirely.

The current JevModel (via Typesafe AI) satisfies this because it was built with a hard latency budget. The migration to Minara must preserve this property, not assume Minara will be fast.

Critical clarification on “Kairos”: Minara’s public API does not expose a model named “Kairos” as a raw inference endpoint. The Kairos functionality is delivered through the Minara Agent API (POST /v1/developer/chat), which is a conversational endpoint supporting fast and expert modes. The fast mode is the closest available analogue to a low-latency decision model. Treat “Kairos” as the Agent API integration, not a selectable model string.

2. Current Provider Contract (What Must Not Break)
The existing Model interface and Decision shape are the non-negotiable contract. The adapter must implement the same interface and return exactly the same decision shape.

2.1 TypeScript Interface (Reference from src/model.ts)
typescript
export interface Model {
  decide(context: MarketContext): Promise<Decision>;
}

export interface Decision {
  action: "buy" | "sell" | "hold";
  probabilities: { buy: number; sell: number; hold: number };
  upIn10: number;
  latencyMs: number;
  late: boolean;
}
2.2 Decision Shape (Verbatim from the SSE Event Contract)
json
"decision": {
  "action": "buy",
  "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 },
  "upIn10": 0.77,
  "latencyMs": 81,
  "late": false
}
The MinaraModel must:

Set latencyMs to the wall-clock time of the Minara call.

Set late: true if the call exceeds the block deadline (BLOCK_DEADLINE_MS).

When late: true, action must be "hold" and probabilities.hold must be 1.

2.3 Existing Provider Switch
The bot currently selects the model via an environment variable (e.g., MODEL=jev or MODEL=mock). The new provider must follow the same pattern: MODEL=minara.

3. Minara Agent API Contract (Verified)
The following is extracted from the official Minara API reference and the Minara Skills repository.

3.1 Endpoint
text
POST https://api.minara.ai/v1/developer/chat
An alternative host https://api-developer.minara.ai also appears in the docs; use api.minara.ai as the primary base URL.

3.2 Authentication
text
Authorization: Bearer <MINARA_API_KEY>
API Key access requires a Pro or Partner Minara subscription. If the subscription is downgraded, active API keys are automatically suspended.

3.3 Request Body
Field	Type	Required	Description
mode	string	Yes	"fast" for quick responses, "expert" for in-depth analysis. Use "fast".
stream	boolean	No	Default false. Set false for standard JSON response. Cannot be true if background is true.
background	boolean	No	Default false. Set true to run asynchronously and poll later. Requires stream: false.
requestId	string	No	Idempotency key. 1–128 chars, pattern ^[A-Za-z0-9._:-]+$.
chatId	string	No	Omit to create a new chat.
message	object	Yes	{ "role": "user", "content": "<prompt>" }
Source: Minara API Reference (API Key); Minara API Skill documentation.

3.4 Response (Non-Streaming, Synchronous)
json
{
  "id": "string",
  "requestId": "string",
  "chatId": "string",
  "messageId": "string",
  "content": "string",
  "usage": {}
}
The field the adapter must parse is content (a string).

3.5 Error Codes
Code	Meaning
400	Bad Request (e.g., background=true combined with stream=true)
401	Unauthorized — invalid or missing API key
409	Conflict — requestId already used with a different request, or expired
Source: Minara API Reference.

3.6 Background Mode (Degraded Fallback)
If background: true is sent (with stream: false), the API returns 202 Accepted immediately. The result must then be retrieved via:

text
GET /v1/developer/chat/{id}
where {id} is either the server-assigned id or your requestId. Records are retained for 24 hours.

Do not use background mode as the default. It introduces staleness. It is a degraded fallback only when the synchronous call consistently times out.

3.7 Kairos Skill Installation (Context Only)
The Minara Skills repository describes installing the Minara CLI and skill files to ~/.claude/skills/minara. Do not spawn a CLI subprocess per block. That is fragile and slow. The adapter must call the Agent API directly via HTTP. The skill installation is mentioned only so the agent understands the broader Minara ecosystem — it is not the integration path for this bot.

4. Latency Strategy (The Core Architectural Problem)
The block deadline is 300 ms. The Minara Agent API is a conversational endpoint. Its fast mode is designed for “quick responses,” but it is not guaranteed to respond within 300 ms.

The adapter must implement three latency strategies simultaneously.

Strategy A: Hard Timeout with hold Fallback
typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), BLOCK_DEADLINE_MS);

try {
  const response = await fetch(MINARA_ENDPOINT, {
    signal: controller.signal,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "fast",
      stream: false,
      background: false,
      message: { role: "user", content: prompt },
    }),
  });

  if (!response.ok) {
    throw new Error(`Minara HTTP ${response.status}`);
  }

  const data = await response.json();
  const parsed = parseDecision(data.content);
  return { ...parsed, latencyMs: Date.now() - started, late: false };
} catch (e) {
  return {
    action: "hold",
    probabilities: { buy: 0, sell: 0, hold: 1 },
    upIn10: 0,
    latencyMs: Date.now() - started,
    late: true,
  };
} finally {
  clearTimeout(timeout);
}
Strategy B: Bounded Last-Known-Good Cache
Cache the most recent successful Minara decision. If the current call exceeds the deadline, reuse the cache only if:

The cached decision is no older than 3 blocks, AND

The current spread has not widened by more than 2× since the cache was written.

If either condition fails, emit hold with late: true.

Strategy C: Background Polling Fallback (Degraded Mode)
If synchronous calls consistently time out, switch to background mode:

Send background: true with stream: false.

Receive 202 Accepted and a requestId or id.

On subsequent blocks, poll GET /v1/developer/chat/{id}.

Until a result arrives, emit hold with late: true.

This mode is not the default. It exists only to prevent total failure when latency degrades.

5. Adapter Design
5.1 File Boundaries
File	Action
src/model.ts	Add MinaraModel implements Model. Do not modify existing Model, JevModel, or MockModel.
src/trader.ts	DO NOT MODIFY. The adapter must fit behind the existing Model interface.
src/server.ts	DO NOT MODIFY.
5.2 Class Skeleton
typescript
export class MinaraModel implements Model {
  private cache: { decision: Decision; blockNumber: number; spread: number } | null = null;

  constructor(
    private apiKey: string,
    private blockDeadlineMs: number,
    private cacheMaxBlocks: number = 3,
  ) {}

  async decide(context: MarketContext): Promise<Decision> {
    const started = Date.now();
    try {
      const content = await this.callMinara(context);
      const parsed = this.parseDecision(content);
      this.updateCache(parsed, context);
      return { ...parsed, latencyMs: Date.now() - started, late: false };
    } catch (e) {
      const cached = this.getValidCache(context);
      if (cached) {
        return { ...cached, latencyMs: Date.now() - started, late: true };
      }
      return {
        action: "hold",
        probabilities: { buy: 0, sell: 0, hold: 1 },
        upIn10: 0,
        latencyMs: Date.now() - started,
        late: true,
      };
    }
  }

  private async callMinara(context: MarketContext): Promise<string> {
    // Implementation per Section 3 and Section 4, Strategy A.
  }

  private parseDecision(content: string): Decision {
    // Strict JSON parse. Throw on failure.
  }

  private updateCache(decision: Decision, context: MarketContext): void {
    // Store decision, block number, and current spread.
  }

  private getValidCache(context: MarketContext): Decision | null {
    // Return cached decision only if age <= cacheMaxBlocks AND spread not > 2x.
  }
}
5.3 Prompt Contract (Strict JSON)
The prompt sent to Minara must be deterministic and structured so the response can be parsed reliably. Do not allow free-form text.

text
You are a market-making decision model for the Kuru cbBTC-USDC order book on Monad.
Given the following block snapshot, return ONLY a JSON object with this exact shape:
{"action":"buy"|"sell"|"hold","probabilities":{"buy":number,"sell":number,"hold":number},"upIn10":number}

Rules:
- "action" must be exactly one of "buy", "sell", or "hold".
- "probabilities" values must sum to 1.0.
- "upIn10" is the probability that the price will be higher in 10 blocks.

Block Snapshot:
{serialized market context}
If Minara returns content that is not valid JSON matching this schema, treat the call as failed and fall back to hold or cache per Section 4.

5.4 Environment Variables
bash
MODEL=minara
MINARA_API_KEY=sk-minara-xxxxxxxx
MINARA_MODE=fast
MINARA_BLOCK_DEADLINE_MS=250
MINARA_CACHE_MAX_BLOCKS=3
MINARA_BLOCK_DEADLINE_MS is set to 250 (not 300) to leave 50 ms of headroom for parsing and loop overhead.

6. Failure Contract — Red Lines
The implementing agent must not do any of the following:

DO NOT retry a timed-out Minara call within the same block. The block is already lost; retrying only extends the late window.

DO NOT call Minara more than once per block in synchronous mode.

DO NOT fall back to the mock model silently. If Minara fails, emit hold and increment a minaraFailures counter in the event payload.

DO NOT parse free-form text. If content is not valid JSON matching the decision schema, treat the call as failed.

DO NOT change src/trader.ts or src/server.ts. The adapter must fit behind the existing Model interface.

DO NOT assume upIn10 is a probability unless Minara returns it. If the field is missing, set it to the buy probability as a conservative default.

DO NOT spawn the Minara CLI as a subprocess per block. Use the HTTP Agent API directly.

DO NOT use mode: "expert" for the trading loop. Expert mode is for in-depth analysis and is not latency-compatible.

7. Acceptance Tests (Definition of Done)
The implementation is complete only when all of the following pass:

#	Test	Expected Outcome
1	Valid Minara response within deadline	decision.action matches parsed content; late: false; latencyMs reflects wall-clock time.
2	Minara response exceeds BLOCK_DEADLINE_MS	decision.action === "hold"; probabilities.hold === 1; late: true.
3	Minara returns non-JSON content	Call treated as failed; hold emitted (or valid cache used); late: true if no cache.
4	Minara returns HTTP 401	Call treated as failed; hold emitted; minaraFailures incremented.
5	Cached decision is fresh (≤ 3 blocks) and spread stable	Cache reused on timeout; late: true; decision matches cached action.
6	Cached decision is stale (> 3 blocks) or spread > 2×	Cache not reused; hold emitted.
7	Loop p50 latency	Must not regress beyond BLOCK_DEADLINE_MS + 20 ms.
8	MODEL=mock and MODEL=jev still work	Existing providers are unchanged and selectable.
8. Ambiguity Resolution Before Implementation
Before writing any code, the implementing agent must resolve the following:

Confirm the base URL. Docs show both https://api.minara.ai and https://api-developer.minara.ai. Use api.minara.ai as the default; api-developer.minara.ai appears in the OpenAPI host declaration.

Confirm that “Kairos” is invoked via the Agent API. There is no raw model: "kairos" parameter in the documented API. The Kairos functionality is delivered through POST /v1/developer/chat with mode: "fast". If a dedicated Kairos parameter or header exists in a private/enterprise deployment, it is not documented in the public API reference and must not be assumed.

If ambiguity remains, implement the adapter behind a KairosInvoker interface with a RawAgentApiInvoker default (using mode: "fast"). This allows the call strategy to be swapped without touching the decision parser.
📁 Recommended Folder Structure
Create a standalone ui/ folder at the repo root, sibling to src/. This keeps the React dashboard completely isolated from the trading loop — no bundler conflicts, no accidental imports, and you can deploy the UI separately later.

text
jev-traderbot/
├── src/                  # Existing bot (DO NOT MODIFY)
│   ├── trader.ts
│   ├── server.ts
│   └── model.ts
├── ui/                   # New: React dashboard
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── MagicBento.tsx      # From ReactBits
│       │   └── BentoCard.tsx       # Your wrapper
│       ├── lib/
│       │   ├── sse.ts              # SSE client for GET /events
│       │   └── types.ts            # Event types (copied, not imported)
│       └── styles/
│           └── globals.css
└── ...
Why a separate ui/ folder? jev-traderbot is a Bun runtime backend. React needs Vite + a browser environment. Keeping them separate means bun run start still builds only src/, and ui/ has its own npm run dev / npm run build.

📦 Installing Magic Bento
The recommended path is via the shadcn CLI, which gives you full source code you can edit:

bash
cd ui
npx shadcn@latest add @react-bits/MagicBento-TS-TW
Or copy MagicBento.tsx directly from the ReactBits source tab into ui/src/components/. Core dependencies:

json
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "gsap": "^3.12.0",
    "lucide-react": "^0.454.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4"
  }
}
Key Magic Bento props:

Prop	Type	Default	Effect
enableStars	boolean	true	Particle animation on hover
enableSpotlight	boolean	true	Mouse-following global spotlight
enableBorderGlow	boolean	true	Card edge glow
enableTilt	boolean	true	3D perspective tilt
enableMagnetism	boolean	true	Card magnetically snaps to cursor
clickEffect	boolean	true	Click ripple
spotlightRadius	number	300	Spotlight radius (px)
glowColor	string	"132, 0, 255"	Glow color (RGB string)
disableAnimations	boolean	false	Global animation kill switch
🎨 Mapping Kairos Decisions to Bento Cards
Your GET /events SSE stream pushes a block event every ~300 ms with decision, quote, fill, totals, etc. The UI should not render every frame — it should keep a sliding window and show aggregated state for the most recent N blocks.

Suggested 6-card layout
text
┌─────────────────────┬─────────────────────┐
│  1. Kairos Decision  │  2. Latency / Late   │
│  (latest action +    │  (latencyMs trend,   │
│   probabilities)     │   lateBlocks count)  │
├─────────────────────┼─────────────────────┤
│  3. Quote Status     │  4. Position & PnL   │
│  (side, price, size, │  (position.side,     │
│   status)            │   unrealizedUsd)     │
├─────────────────────┼─────────────────────┤
│  5. Recent Fills     │  6. Model Health     │
│  (latest fill list)  │  (success rate,      │
│                     │   cache hit rate)    │
└─────────────────────┴─────────────────────┘
Data source per card
Card	Fields from SSE block event
Kairos Decision	decision.action, decision.probabilities, decision.upIn10
Latency / Late	decision.latencyMs, decision.late, totals.lateBlocks
Quote Status	quote.side, quote.price, quote.size, quote.status
Position & PnL	position.side, position.size, position.unrealizedUsd, totals.pnlUsd
Recent Fills	fill (latest non-null fill event)
Model Health	minaraFailures counter you add to MinaraModel (see seed-context §6)
Example: App.tsx
tsx
// ui/src/App.tsx
import { useEffect, useState } from "react";
import MagicBento from "./components/MagicBento";
import { BentoCard } from "./components/BentoCard";
import { connectSSE } from "./lib/sse";
import type { BlockEvent } from "./lib/types";

export default function App() {
  const [latest, setLatest] = useState<BlockEvent | null>(null);
  const [history, setHistory] = useState<BlockEvent[]>([]);

  useEffect(() => {
    return connectSSE((event) => {
      if (event.type === "block") {
        setLatest(event);
        setHistory((prev) => [...prev.slice(-99), event]);
      }
    });
  }, []);

  if (!latest) return <div>Connecting to jev-traderbot…</div>;

  return (
    <div className="min-h-screen w-full bg-[#0a0a0a] p-8">
      <MagicBento
        enableStars={true}
        enableSpotlight={true}
        enableBorderGlow={true}
        enableTilt={true}
        spotlightRadius={400}
        glowColor="59, 130, 246" // Blue glow, distinct from default purple
      >
        <BentoCard title="Kairos Decision" span={2}>
          <div className="text-4xl font-bold">
            {latest.decision.action.toUpperCase()}
          </div>
          <div className="text-sm opacity-70">
            buy {(latest.decision.probabilities.buy * 100).toFixed(0)}% ·{" "}
            sell {(latest.decision.probabilities.sell * 100).toFixed(0)}%
          </div>
        </BentoCard>

        <BentoCard title="Latency / Late">
          <div>{latest.decision.latencyMs} ms</div>
          <div className={latest.decision.late ? "text-red-400" : "text-green-400"}>
            {latest.decision.late ? "LATE" : "ON TIME"}
          </div>
          <div className="text-xs opacity-60">
            Late blocks: {latest.totals.lateBlocks}
          </div>
        </BentoCard>

        <BentoCard title="Quote">
          <div>
            {latest.quote?.side ?? "—"} @ {latest.quote?.price ?? "—"}
          </div>
          <div className="text-xs opacity-60">
            {latest.quote?.status ?? "no quote"}
          </div>
        </BentoCard>

        <BentoCard title="Position">
          <div>
            {latest.position.side} {latest.position.size}
          </div>
          <div
            className={
              latest.position.unrealizedUsd >= 0
                ? "text-green-400"
                : "text-red-400"
            }
          >
            {latest.position.unrealizedUsd.toFixed(4)} USD
          </div>
        </BentoCard>

        <BentoCard title="PnL" span={2}>
          <div className="text-3xl">{latest.totals.pnlUsd.toFixed(4)} USD</div>
          <div className="text-xs opacity-60">
            {latest.totals.blocks} blocks · {latest.totals.fills} fills
          </div>
        </BentoCard>
      </MagicBento>
    </div>
  );
}
BentoCard.tsx wrapper
tsx
// ui/src/components/BentoCard.tsx
export function BentoCard({
  title,
  children,
  span = 1,
}: {
  title: string;
  children: React.ReactNode;
  span?: number;
}) {
  return (
    <div
      className={`bento-card p-6 rounded-2xl bg-white/5 border border-white/10 ${
        span === 2 ? "col-span-2" : ""
      }`}
    >
      <div className="text-xs uppercase tracking-wider opacity-50 mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}
🔌 SSE Client
jev-traderbot already exposes a GET /events SSE endpoint. The UI only needs a standard EventSource connection:

typescript
// ui/src/lib/sse.ts
export function connectSSE(onEvent: (event: any) => void): () => void {
  const source = new EventSource(`${import.meta.env.VITE_API_URL}/events`);

  source.addEventListener("block", (e) => {
    onEvent({ type: "block", ...JSON.parse(e.data) });
  });

  source.addEventListener("snapshot", (e) => {
    onEvent({ type: "snapshot", ...JSON.parse(e.data) });
  });

  source.onerror = () => {
    console.error("SSE connection lost, retrying…");
  };

  return () => source.close();
}
In ui/.env:

bash
VITE_API_URL=http://localhost:3000
⚠️ The Key Boundary: The UI Is Read-Only
This is the most important architectural constraint of the whole integration. Add it to your seed-context.md or PLAN.md:

The UI only reads, never writes. Nothing in ui/ may import from src/trader.ts or src/model.ts. The UI consumes data purely via HTTP/SSE.

Any UI "action" buttons (if added later) may only hit backend admin endpoints (e.g. POST /admin/pause) — never call Minara directly, never mutate trade state.

UI builds don't affect the backend. bun run start still builds only src/. ui/ has its own npm run dev / npm run build.

🧩 Optional: Add UI Layer to seed-context.md
If you want the AI agent to keep the UI consistent when it generates code, append this section to your seed-context.md:

markdown
## 9. UI Layer (Optional, Read-Only)

A separate `ui/` folder contains a React dashboard using ReactBits Magic Bento.
- The UI consumes `GET /events` via SSE. It does NOT import from `src/`.
- Cards: Kairos Decision, Latency/Late, Quote Status, Position/PnL, Fills, Model Health.
- Use `glowColor="59, 130, 246"` (blue) to distinguish from ReactBits' default purple.
- The UI must not call the Minara API directly. It only displays data emitted by the bot.
- Build with Vite + Tailwind. Magic Bento installed via `npx shadcn@latest add @react-bits/MagicBento-TS-TW`.
This way, the AI agent implements the backend adapter and understands the UI boundary and design intent — without ever mixing UI logic into the trading loop.
. Core Idea
The Hyperspeed component is not decoration. It is the dashboard's ambient signal display. The road, the light trails, the dust, the bloom — every visual parameter is driven by the trading loop's state. When Kairos is confident, the road warps. When the model is failing, the road goes dark. When a fill lands, the lights pulse.

The design principle: a trader should be able to glance at the Hyperspeed field for 300 ms and know whether the bot is healthy, confident, and profitable — before reading a single number in the bento cards.

The bento cards are the ledger. The Hyperspeed is the mood.

Non-negotiable constraints:

Hyperspeed renders behind the bento cards, full-viewport, as a fixed backdrop.

It must never block pointer events on the bento cards. pointer-events: none on the wrapper is mandatory.

It must never re-mount on every SSE event. The component's useEffect(..., []) mount and settingsRef.current = settings per-render pattern is exactly right — do not "optimize" it into a keyed remount.

It runs at reduced speed under prefers-reduced-motion (the component handles this natively).

When the tab is hidden, requestAnimationFrame throttles automatically — do not add extra pause logic.

2. Layering & Z-Index Model
text
┌──────────────────────────────────────────────────┐
│  z-0   Hyperspeed canvas (fixed, inset-0)         │  ← background, pointer-events: none
│  z-10  Gradient veil (optional, see §6.3)         │  ← darkens center for readability
│  z-20  Content wrapper (pointer-events: none)     │  ← layout shell
│  z-30  Bento cards (pointer-events: auto)         │  ← interactive, clickable
│  z-40  Header / toast / modal                     │  ← topmost
└──────────────────────────────────────────────────┘
Rules:

Hyperspeed's own container (.hyperspeed) is position: absolute; inset: 0 — it does not accept a z-index by default. Wrap it in a <div className="fixed inset-0 pointer-events-none z-0">.

Do not set background or roadOpacity on the Hyperspeed that would make it opaque — the page background must remain visible through it. Use background="transparent" (the default) and roadOpacity={0.08} to keep the road barely there.

The bento grid lives inside <main className="relative z-20 pointer-events-none"> with individual cards re-enabling pointer-events-auto.

3. Data → Visual Mapping (The Contract)
This is the heart of the seed. Every Hyperspeed prop maps to a specific signal from the SSE block event. The mapping must be smoothed — no prop should flip on every block.

3.1 Primary mappings
Signal (from SSE block event)	Hyperspeed prop	Behaviour	Notes
decision.action	boosting (pulsed)	true for 400 ms on buy or sell, else false	Pulse, don't hold. See §5.
decision.probabilities.buy	speed	0.5 + buy_prob * 1.5	High buy confidence → faster road
decision.probabilities.sell	headColors swap	Cyan spectrum when buy-biased, magenta when sell-biased	See §3.2
decision.late	glow	Multiply by 0.4 on late blocks (dimming = warning)	One late block dims; recovers over 2 s
totals.lateBlocks (delta)	dust	100 - min(80, lateBlocks * 4)	Persistent lateness kills the dust streaks
totals.fills (delta)	boosting pulse + glow spike	Boost 300 ms, glow +0.3 for 1 s	A fill is a positive event
position.unrealizedUsd	tailColors	Green tint positive, red tint negative (smoothed)	Keep base palette, tint one channel
totals.pnlUsd (delta)	glow	Scale 0.4 → 1.2 with smoothed PnL slope	Bloom = money
minaraFailures (new field)	dust = 0, glow = 0.05	Model health degraded = dead calm	See seed-context.md §6
3.2 Market regime → curve
The curve prop morphs smoothly (the component blends weights over ~600 ms), so it's safe to switch. But don't switch on every block — use dwell time of at least 3 s.

Regime condition	curve
Default / calm	'straight'
Buy confidence > 0.6 (trending up)	'winding'
Sell confidence > 0.6 (trending down)	'deep'
Spread widening > 2× over 10 blocks	'racing'
Spread oscillating (choppy)	'hills'
Model is late for > 3 consecutive blocks	'gentle' (slow down, degrade gracefully)
3.3 Colour palettes
ts
const PALETTES = {
  bullish: {
    tailColors: ['#22c55e', '#16a34a', '#0ea5e9'],   // greens + cyan
    headColors: ['#03b3c3', '#0e5ea5', '#324555'],   // default cyan
    poleColors: ['#22c55e'],
  },
  bearish: {
    tailColors: ['#ef4444', '#dc2626', '#a855f7'],   // reds + violet
    headColors: ['#f97316', '#ef4444', '#7f1d1d'],   // hot oranges
    poleColors: ['#ef4444'],
  },
  neutral: {
    tailColors: ['#d856bf', '#6750a2', '#c247ac'],   // ReactBits default
    headColors: ['#03b3c3', '#0e5ea5', '#324555'],
    poleColors: ['#03b3c3'],
  },
};
Selection logic: pick bullish when smoothedBuyProb > 0.58, bearish when smoothedSellProb > 0.58, else neutral. Smooth colour transitions by lerping the hex values over 1.2 s — do not swap arrays abruptly (the shader re-uploads them and you will see a pop).

3.4 What must NOT be driven by data
Leave these fixed across the session unless the user explicitly toggles a "focus mode" (§7):

fov / boostFov (keep 90/130 — changing these causes camera spring jitter)

steer (keep 0.35, or 0 if pointer-following is disabled)

interactive (see §7)

lanes, roadWidth, medianWidth (structural; changing them morphs geometry)

4. Component Integration
4.1 File placement
text
ui/
└── src/
    ├── components/
    │   ├── Hyperspeed.jsx          # ← verbatim from ReactBits source
    │   ├── Hyperspeed.css          # ← verbatim (imported by Hyperspeed.jsx)
    │   ├── HyperspeedBackdrop.tsx  # ← wrapper + driver hook (this seed)
    │   ├── MagicBento.tsx
    │   └── BentoCard.tsx
    └── lib/
        ├── useHyperspeedDriver.ts  # ← data → props mapper
        └── sse.ts
File extension note: the ReactBits source is .jsx, not .tsx. It uses JSX without type annotations. If the project is TypeScript, either:

(a) keep it as .jsx and ensure tsconfig.json has "allowJs": true and "jsx": "preserve", or

(b) rename to .tsx and add : any to the Hyperspeed props destructure, or

(c) leave it as .jsx and add a .d.ts shim: declare module './components/Hyperspeed'.

Option (a) is the least invasive. Document the choice in ui/README.md.

4.2 Dependencies
bash
cd ui
npm install three
npm install -D @types/three   # if using TypeScript
Only three is required. The component uses three core only — no postprocessing package, no OrbitControls. Bloom is hand-rolled via render targets.

4.3 Minimal mount
tsx
// ui/src/components/HyperspeedBackdrop.tsx
import Hyperspeed from './Hyperspeed';
import './Hyperspeed.css';

export function HyperspeedBackdrop(props: HyperspeedProps) {
  return (
    <div className="fixed inset-0 pointer-events-none z-0">
      <Hyperspeed {...props} interactive={false} />
    </div>
  );
}
interactive={false} is mandatory here — the wrapper already blocks pointer events; passing interactive would be dead code, but it also disables the contextmenu preventDefault and the pointerdown boost trigger, which is exactly what we want for a background.

5. The Driver Hook (useHyperspeedDriver)
This is where the data → visual contract becomes code. It takes the latest SSE block event and returns a stable, smoothed prop object that changes at most a few times per second.

5.1 Signature
ts
// ui/src/lib/useHyperspeedDriver.ts
export interface BlockEvent {
  decision: {
    action: 'buy' | 'sell' | 'hold';
    probabilities: { buy: number; sell: number; hold: number };
    upIn10: number;
    latencyMs: number;
    late: boolean;
  };
  quote: { side: string; price: string; size: string; status: string } | null;
  position: { side: string; size: string; unrealizedUsd: number };
  totals: { blocks: number; fills: number; lateBlocks: number; pnlUsd: number };
  fill: unknown | null;
  minaraFailures: number;  // added by backend (seed-context.md §6)
}

export function useHyperspeedDriver(latest: BlockEvent | null): HyperspeedProps {
  // ...
}
5.2 Reference implementation
ts
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlockEvent } from './types';

const PULSE_MS = 400;
const REGIME_DWELL_MS = 3000;
const COLOR_LERP_MS = 1200;

export function useHyperspeedDriver(latest: BlockEvent | null) {
  // Smoothed buy probability (EMA)
  const [buyProb, setBuyProb] = useState(0.5);
  // Current regime curve + last switch time
  const [curve, setCurve] = useState<'straight'|'gentle'|'winding'|'hills'|'racing'|'deep'>('straight');
  const lastCurveSwitch = useRef(0);
  // Pulse boost
  const [boosting, setBoosting] = useState(false);
  const boostTimer = useRef<number | null>(null);
  const lastFills = useRef(0);
  const lastAction = useRef<'buy'|'sell'|'hold'>('hold');

  // 1. Update smoothed probability + trigger pulses
  useEffect(() => {
    if (!latest) return;
    const targetBuy = latest.decision.probabilities.buy;
    setBuyProb(prev => prev + (targetBuy - prev) * 0.15); // ~15% per block

    // Fill → boost pulse
    if (latest.totals.fills > lastFills.current) {
      lastFills.current = latest.totals.fills;
      triggerBoost();
    }
    // Action change from hold → buy/sell → boost pulse
    if (latest.decision.action !== 'hold' && latest.decision.action !== lastAction.current) {
      triggerBoost();
    }
    lastAction.current = latest.decision.action;
  }, [latest]);

  const triggerBoost = () => {
    setBoosting(true);
    if (boostTimer.current) window.clearTimeout(boostTimer.current);
    boostTimer.current = window.setTimeout(() => setBoosting(false), PULSE_MS);
  };

  // 2. Regime curve selection (dwell-time guarded)
  useEffect(() => {
    if (!latest) return;
    const now = Date.now();
    if (now - lastCurveSwitch.current < REGIME_DWELL_MS) return;

    const { buy, sell } = latest.decision.probabilities;
    let next: typeof curve = 'straight';
    if (buy > 0.6) next = 'winding';
    else if (sell > 0.6) next = 'deep';
    else if (latest.totals.lateBlocks > 3) next = 'gentle';

    if (next !== curve) {
      setCurve(next);
      lastCurveSwitch.current = now;
    }
  }, [latest, curve]);

  // 3. Derive stable props
  return useMemo(() => {
    const late = latest?.decision.late ?? false;
    const failures = latest?.minaraFailures ?? 0;
    const healthy = failures === 0;

    const palette = buyProb > 0.58
      ? { tailColors: ['#22c55e', '#16a34a', '#0ea5e9'], poleColors: ['#22c55e'] }
      : buyProb < 0.42
      ? { tailColors: ['#ef4444', '#dc2626', '#a855f7'], poleColors: ['#ef4444'] }
      : {};

    return {
      // Structure — fixed
      lanes: 3,
      roadWidth: 10,
      medianWidth: 2,
      trailLength: 1,
      lightSize: 1,
      poles: healthy ? 20 : 0,
      dust: healthy ? (late ? 40 : 100) : 0,
      reflections: 0.5,
      roadOpacity: 0.08,
      fov: 90,
      boostFov: 130,
      // Dynamic
      curve,
      boosting,
      speed: 0.5 + buyProb * 1.5,
      glow: healthy ? (late ? 0.2 : 0.6) : 0.05,
      ...palette,
      // Disabled
      interactive: false,
    };
  }, [buyProb, curve, boosting, latest]);
}
5.3 Why this shape
EMA on buyProb — one block is noise, ten blocks is signal.

Pulse, not hold, for boosting — boosting set from data is a momentary warp; keeping it true would make the road permanently warp-speed and lose meaning.

Dwell time on curve — the component morphs smoothly, but constant regime switching causes nausea.

useMemo on the returned object — prevents the Hyperspeed component from receiving a new settings object every render (it would still work via settingsRef, but it avoids wasted work).

6. Layout
6.1 Full-viewport backdrop (recommended)
tsx
// ui/src/App.tsx
import { useEffect, useState } from 'react';
import { HyperspeedBackdrop } from './components/HyperspeedBackdrop';
import { useHyperspeedDriver } from './lib/useHyperspeedDriver';
import { connectSSE } from './lib/sse';
import MagicBento from './components/MagicBento';
import { BentoCard } from './components/BentoCard';

export default function App() {
  const [latest, setLatest] = useState<any>(null);
  useEffect(() => connectSSE(setLatest), []);

  const hyperspeedProps = useHyperspeedDriver(latest);

  return (
    <div className="relative min-h-screen bg-[#050507]">
      {/* Layer 0: Hyperspeed */}
      <HyperspeedBackdrop {...hyperspeedProps} />

      {/* Layer 10: gradient veil for readability */}
      <div
        className="fixed inset-0 z-10 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%)',
        }}
      />

      {/* Layer 20: content */}
      <main className="relative z-20 pointer-events-none min-h-screen p-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-white/90 text-2xl font-semibold tracking-tight">
            jev-traderbot · Monad
          </h1>
          <div className="text-white/60 text-sm">
            {latest ? `${latest.totals.blocks} blocks · ${latest.totals.fills} fills` : 'connecting…'}
          </div>
        </header>

        <div className="pointer-events-auto">
          <MagicBento glowColor="59, 130, 246" spotlightRadius={400}>
            {/* bento cards here — see prior seed-context */}
          </MagicBento>
        </div>
      </main>
    </div>
  );
}
6.2 Hero-split alternative (more readable)
If the full-backdrop approach makes text hard to read, restrict the Hyperspeed to the top 40%:

tsx
<div className="relative h-[40vh] w-full">
  <HyperspeedBackdrop {...hyperspeedProps} />
</div>
<main className="relative bg-[#050507] p-6">...</main>
In this mode, set roadOpacity={0.15} and background="#050507" so the canvas has a solid floor. The road becomes a dramatic header rather than an ambient backdrop.

6.3 The gradient veil is not optional
On a full-viewport Hyperspeed, the busiest part of the road (the horizon at center) sits directly behind where you'll put the hero card. Without a radial veil, the bento text will fight the light trails. The veil in §6.1 darkens the edges and the center — exactly where UI content lives — while leaving the mid-radius trails visible.

7. Interaction Policy
Default: interactive={false}. Clicks must go to bento cards, not the canvas.

Optional focus mode: add a small button in the header labelled "warp" that toggles a local state focus. When focus === true:

Set the backdrop wrapper's class to pointer-events-auto.

Pass interactive={true} to Hyperspeed.

Dim the bento (CSS opacity-40 transition) so the user can enjoy the warp.

Pressing Escape or clicking "warp" again restores.

This gives the user the "click and hold to boost" ReactBits interaction without breaking the trading dashboard's click targets. It's a deliberate, opt-in mode.

Do not wire onBoostStart / onBoostEnd to any trading action. Boost is a visual, not a signal. The bot does not trade differently because you held the mouse down.

8. Performance Guard
Hyperspeed uses WebGL2 with a 5-level bloom chain and up to ~160 cars + 80 poles + 1500 dust points. On a laptop this is fine; on a low-end device it can drop frames.

Mandatory guards:

Cap pixel ratio. The component already does Math.min(devicePixelRatio, 2). Do not raise it.

Reduce density and dust on weak hardware. Detect via navigator.hardwareConcurrency <= 4 and pass density={20}, dust={40}. Do this once at mount, not per render.

Respect prefers-reduced-motion. The component handles this (speed ×0.3), but you should also set glow={0.2} and boosting={false} in that mode.

Do not re-render on every SSE tick. The useHyperspeedDriver hook already throttles via EMA and useMemo. Do not add latest to the HyperspeedBackdrop's key.

Lazy-mount after first SSE event. Do not mount Hyperspeed on the empty "connecting…" screen — it burns GPU for nothing. Wrap in {latest && <HyperspeedBackdrop ... />}.

WebGL context loss. Add a fallback: if gl.getExtension('WEBGL_lose_context') fires, unmount Hyperspeed and show a static gradient. This is one addEventListener('webglcontextlost', ...) on the canvas — the component does not handle it itself.

9. Failure Contract — DO NOT
DO NOT set interactive={true} by default. The bento cards must remain clickable.

DO NOT re-mount Hyperspeed on every state update (key={latest.totals.blocks} is forbidden). The component is designed to read settingsRef.current per frame.

DO NOT wire onBoostStart / onBoostEnd to backend calls. Boost is visual only.

DO NOT pass curve from raw latest.decision.action. Use the dwell-time-guarded regime selector (§5.2).

DO NOT set background to an opaque colour unless you also increase roadOpacity and accept that the page background is hidden. In full-backdrop mode, keep background="transparent".

DO NOT import Hyperspeed.jsx from src/ — it belongs in ui/ only. The bot's Bun build must never see three.

DO NOT let minaraFailures > 0 leave the Hyperspeed at full glow. Model health degradation must be visible in the visuals (§3.1).

DO NOT use theme="light" — the traderbot dashboard is dark. Light theme was not designed for this palette and the bento cards are dark glass.

10. Acceptance Tests
The integration is complete only when all of the following pass:

#	Test	Expected
1	Initial load with no SSE data	Hyperspeed is not mounted. "connecting…" shown. No WebGL context created.
2	First SSE block arrives	Hyperspeed mounts once. Road renders with curve='straight', neutral palette.
3	100 consecutive SSE blocks	Hyperspeed component is not re-mounted (verify via React DevTools / console.log in component body).
4	decision.action === 'buy' fires	A 400 ms boosting pulse is observable. Road warps briefly, then returns.
5	totals.fills increments	A 400 ms boosting pulse fires. Glow spikes then decays.
6	4 consecutive decision.late === true blocks	curve switches to 'gentle' after ≥ 3 s dwell. dust reduces to 40.
7	minaraFailures becomes ≥ 1	dust=0, glow=0.05, poles=0. Road goes dark.
8	prefers-reduced-motion: reduce	Speed ×0.3, glow=0.2, no pulses.
9	Click a bento card	Card receives the click. Hyperspeed does not boost.
10	Toggle focus mode	Wrapper gets pointer-events-auto, Hyperspeed interactive=true, bento dims. Hold-to-boost works. Exit restores.
11	Hide tab for 30 s, return	No frame spike. Hyperspeed continues smoothly (rAF throttling is native).
12	WebGL context lost (dev tool: gl.getExtension('WEBGL_lose_context').loseContext())	Hyperspeed unmounts, static gradient fallback shown, no console error spam.
11. Append to Backend seed-context.md
If the backend agent is separate from the UI agent, append this line so the backend contract supports the visual layer:

markdown
## 10. Visual Driver Field

The backend must emit `minaraFailures` in every `block` event payload
(integer, monotonically increasing). The UI's Hyperspeed backdrop uses
it to dim the scene when model health degrades. Do not omit this field.
