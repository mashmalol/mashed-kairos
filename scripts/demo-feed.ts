/**
 * Synthetic SSE feed for working on the dashboard when the live market is quiet.
 *
 *     bun run scripts/demo-feed.ts          # :3003
 *     DEMO_FEED_PORT=3004 bun run scripts/demo-feed.ts
 *
 * (Not PORT: the bot's .env is auto-loaded here too, and that would collide with :3000.)
 *
 * It speaks the same contract as `src/server.ts` (GET /events): a `snapshot` frame with
 * flat meta + history, then `block` frames carrying an embedded `quote`, `quote` frames
 * when a receipt lands (placed / reverted), and `fill` frames. Booked quotes in history
 * keep `status: "sent"`, exactly like the real bot — which is why the dashboard's trade
 * log has to merge receipt frames instead of trusting history alone.
 *
 * Point the UI at it with `PROXY_TARGET=http://localhost:3003` in ui/.env.
 * This is test data: nothing here touches the chain, a wallet, or the model.
 */

const PORT = Number(process.env.DEMO_FEED_PORT ?? 3003);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error(`bad DEMO_FEED_PORT: ${process.env.DEMO_FEED_PORT}`);

/** Fixed at process start, like the real bot's `startedAt` — the dashboard keys its persisted
 *  fills to it, so a page reload must not look like a new trading session. */
const STARTED_AT = Date.now() - 600_000;

/** cbBTC-USDC-ish prices, in USDC per cbBTC. */
const MID = 87_500;
const SIZE = 0.000125; // the market's minSize; ~11 USDC notional at this price

const hex = (n = 16) =>
  "0x" + Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: unknown;
  quote: unknown | null;
  fill: null;
  resting: { bidMon: number; askMon: number };
  position: { side: string; size: number; entryPrice: number; unrealizedUsd: number; unrealizedMon: number };
  totals: Record<string, number>;
  minaraFailures: number;
}

const history: BlockEvent[] = [];
let block = 105_488_269;
let lastOrderId = 100_295_800;
let steps = 0;
let fills = 0;
let reverted = 0;
let lateBlocks = 0;
let pnlUsd = -0.003;
let gasMon = 0;

type Receipt = { due: number; block: number; quote: Record<string, unknown> };
type PendingFill = { due: number; fill: Record<string, unknown> };

const receipts: Receipt[] = [];
const pendingFills: PendingFill[] = [];

function step(ts = Date.now()): BlockEvent {
  block++;
  steps++;
  const buy = 0.5 + 0.46 * Math.sin(block / 9) + (Math.random() - 0.5) * 0.08;
  const late = Math.random() < 0.05;
  if (late) lateBlocks++;

  const side = buy > 0.5 ? "buy" : "sell";
  const mid = MID + Math.sin(block / 11) * 60;
  const price = side === "buy" ? mid - 6 : mid + 6;

  const quote = {
    side,
    price,
    size: SIZE,
    txHash: hex(),
    gasMon: 0.0378,
    cancel: [] as number[],
    status: "sent",
    orderId: null as number | null,
    capped: false,
  };
  gasMon += quote.gasMon;

  // A receipt lands one or two blocks later; ~12% revert (the price moved through us).
  if (!late) {
    receipts.push({
      due: block + 1 + Math.floor(Math.random() * 2),
      block,
      quote:
        Math.random() < 0.12
          ? { ...quote, status: "reverted" }
          : { ...quote, status: "placed", orderId: ++lastOrderId },
    });
  }

  // A taker occasionally hits one of the orders we know is resting.
  if (lastOrderId > 100_295_800 && Math.random() < 0.22) {
    pendingFills.push({
      due: block + 1,
      fill: {
        side: Math.random() < 0.5 ? "buy" : "sell",
        size: SIZE,
        price: price + (side === "buy" ? 2 : -2),
        txHash: hex(),
        orderId: lastOrderId,
        simulated: true,
      },
    });
  }

  const event: BlockEvent = {
    block,
    ts,
    mid,
    bestBid: mid - 4,
    bestAsk: mid + 4,
    spreadBps: 9.1,
    decision: {
      action: late ? "hold" : side,
      probabilities: late ? { buy: 0, sell: 0, hold: 1 } : { buy, sell: 1 - buy, hold: 0 },
      upIn10: buy,
      latencyMs: late ? 0 : 55 + Math.round(Math.random() * 70),
      late,
    },
    quote: late ? null : quote,
    fill: null,
    resting: { bidMon: SIZE * 1e8, askMon: SIZE * 1e8 },
    position: {
      side: "long",
      size: SIZE * 1e8,
      entryPrice: 87_496.6,
      unrealizedUsd: 0.0004,
      unrealizedMon: 0.018,
    },
    totals: {
      blocks: steps,
      decisions: steps,
      quotes: steps - lateBlocks,
      fills,
      reverted,
      lateBlocks,
      jevUsd: 0.000004,
      gasMon,
      gasUsd: gasMon * mid,
      realizedUsd: pnlUsd,
      pnlUsd,
      pnlMon: pnlUsd / mid,
      pnlPct: (pnlUsd / 50) * 100,
    },
    minaraFailures: block % 37 === 0 ? 1 : 0,
  };

  history.push(event);
  if (history.length > 400) history.shift();
  return event;
}

// Seed enough history that a freshly opened dashboard has rows immediately. Timestamps are
// backdated one block apart so the ledger's newest-first order is meaningful.
for (let i = 0; i < 60; i++) step(Date.now() - (60 - i) * 320);

const enc = new TextEncoder();
const frame = (event: string, data: unknown) =>
  enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

Bun.serve({
  port: PORT,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/history") return Response.json(history);
    if (pathname !== "/events") return Response.json({ ok: true, hint: "GET /events" });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(frame(event, data));
          } catch {
            /* client disconnected */
          }
        };

        send("snapshot", {
          model: "minara",
          wallet: null,
          dryRun: true,
          market: "0x40c49F171202F91ff5d2faE34c22dD2BFdD22aF0",
          startedAt: STARTED_AT,
          pair: "cbBTC/USDC",
          running: true,
          latest: history.at(-1) ?? null,
          history,
        });

        // ~3 blocks/second, like Monad.
        const timer = setInterval(() => {
          const event = step();
          send("block", event);

          for (let i = receipts.length - 1; i >= 0; i--) {
            const r = receipts[i]!;
            if (r.due > event.block) continue;
            receipts.splice(i, 1);
            if (r.quote.status === "reverted") reverted++;
            send("quote", { block: r.block, quote: r.quote });
          }

          for (let i = pendingFills.length - 1; i >= 0; i--) {
            const f = pendingFills[i]!;
            if (f.due > event.block) continue;
            pendingFills.splice(i, 1);
            fills++;
            pnlUsd += 0.0008;
            send("fill", { block: event.block, fill: f.fill });
          }
        }, 320);
      },
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});

console.log(`demo feed on :${PORT} — point ui/.env PROXY_TARGET at it`);
