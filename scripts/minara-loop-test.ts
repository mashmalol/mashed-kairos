/**
 * Loop-level acceptance test: Trader + MinaraModel wired together against a stub market and a
 * local mock of the Minara Agent API (SEED-CONTEXT.md §7, tests #1, #2 and the red line "a failed
 * Minara answer posts no order").
 *
 *     bun run scripts/minara-loop-test.ts
 */
import { serve } from "bun";
import { Trader } from "../src/trader";
import { MinaraModel, type Decision } from "../src/model";
import type { Book, Fill, Quote, QuoteResult, Side } from "../src/market";
import type { BlockEvent } from "../src/trader";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const JSON_OK = JSON.stringify({ action: "buy", probabilities: { buy: 0.7, sell: 0.3, hold: 0 }, upIn10: 0.7 });
let mode: "ok" | "slow" = "ok";
serve({
  port: 0,
  fetch() {
    if (mode === "slow") return new Promise(() => {});
    return Response.json({ content: JSON_OK });
  },
});

const twoSided = (): Book => ({
  block: 1, bid: 0.0226, ask: 0.0227, mid: 0.02265, spreadBps: 4.4, imbalance: 0,
  levels: { bids: [[0.0226, 10]], asks: [[0.0227, 10]] },
  depthBps: { "10": { bid: 10, ask: 10 }, "25": { bid: 10, ask: 10 }, "50": { bid: 10, ask: 10 } },
});

/** Stub market: no chain, no wallet — dry run all the way down. */
const stubMarket = {
  address: null as string | null,
  wallet: null,
  margin: { base: 0, quote: 0 },
  baseSymbol: "cbBTC", quoteSymbol: "USDC",
  params: { sizePrecision: { toString: () => "100000000" } },
  async init() {},
  async refresh() {},
  async readBook() { return twoSided(); },
  async send(block: number, side: Side, size: number, book: Book, cancel: number[], capped: boolean): Promise<Quote> {
    return { side, price: side === "buy" ? book.bid : book.ask, size, txHash: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
  },
  async pollPending(): Promise<QuoteResult[]> { return []; },
};

const events: BlockEvent[] = [];
const mock = Bun.serve({
  port: 0,
  fetch() { if (mode === "slow") return new Promise(() => {}); return Response.json({ content: JSON_OK }); },
});
const trader = new Trader(stubMarket as any, new MinaraModel("sk-test", `http://localhost:${mock.port}`, "fast", 100), (e: BlockEvent) => events.push(e));
/** A second, cache-less model for the "no last-known-good answer" case. */
const traderCold = new Trader(stubMarket as any, new MinaraModel("sk-test", `http://localhost:${mock.port}`, "fast", 100), (e: BlockEvent) => events.push(e));

// #1 healthy model: a real decision and a real (simulated) order
await trader.onBlock(100);
const e1 = events.at(-1)!;
check(
  "healthy: decision parsed, order posted, failures 0",
  e1.decision?.action === "buy" && e1.decision.late === false && e1.quote?.side === "buy" && e1.quote.status === "sim" && (e1.minaraFailures ?? -1) === 0,
  JSON.stringify(e1.decision?.probabilities),
);

// #2/#red-line: model misses the deadline with NO cached answer -> hold, NO order, late counted
mode = "slow";
await traderCold.onBlock(101);
const e2 = events.at(-1)!;
check(
  "late: hold, no quote, late flagged, failures incremented",
  e2.decision?.action === "hold" && e2.decision.late === true && e2.quote === null && e2.totals.lateBlocks === 1 && (e2.minaraFailures ?? -1) === 1,
  `lateBlocks=${e2.totals.lateBlocks} failures=${e2.minaraFailures}`,
);

// #5: fresh cache turns the next failure into a delayed-but-actionable answer
mode = "ok";
await trader.onBlock(102); // re-seed cache at block 102
mode = "slow";
await trader.onBlock(103);
const e3 = events.at(-1)!;
check(
  "cache: stale-free reuse keeps the position side, still flagged late",
  e3.decision?.action === "buy" && e3.decision.late === true && (e3.minaraFailures ?? -1) === 1,
  `failures=${e3.minaraFailures}`,
);

mock.stop(true);
console.log(failures ? `\n${failures} test(s) FAILED` : "\nall tests passed");
process.exit(failures ? 1 : 0);
