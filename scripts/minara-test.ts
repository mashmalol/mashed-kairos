/**
 * Acceptance tests for MinaraModel (SEED-CONTEXT.md §7), run against a local mock of the
 * Minara Agent API — no network, no real key.
 *
 *     bun run scripts/minara-test.ts
 *
 * Covers, per test id in the seed:
 *   1 valid response within deadline   2 timeout -> hold/late
 *   3 non-JSON content                 4 HTTP 401 -> failure counter
 *   5 fresh cache reused               6 stale cache rejected
 *   8 mock + jev selection unaffected  (7, the loop p50, is measured in the live dry run)
 */
import { serve } from "bun";
import { MinaraModel, MockModel, type TradeState } from "../src/model";

let failures = 0;
const check = (id: number, name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  #${id} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A minimal valid TradeState; the model only reads block, spreadBps and (for the prompt) the rest.
const state = (block: number, spreadBps = 7): TradeState => ({
  market: "0x40c4", block, horizonBlocks: 100, blockMs: 300,
  mid: 0.0226, spreadBps, bookImbalance: 0,
  depth: {}, book: { bids: [], asks: [] },
  returnsBps: { last1: 0, last5: 0, last20: 0, last100: 0 },
  recentMids: "", trades: { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null },
  recentTrades: [], allowed: { buy: true, sell: true },
});

const JSON_OK = JSON.stringify({ action: "buy", probabilities: { buy: 0.7, sell: 0.3, hold: 0 }, upIn10: 0.7 });

/** One server whose behaviour is switched per test via `mode`. */
let mode: "ok" | "bad" | "slow" | "unauthorized" = "ok";
const server = serve({
  port: 0,
  fetch() {
    if (mode === "bad") return Response.json({ content: "I think we should buy." });
    if (mode === "slow") return new Promise(() => {}); // never answers -> AbortController fires
    if (mode === "unauthorized") return new Response("no", { status: 401 });
    return Response.json({ content: JSON_OK });
  },
});
const base = `http://localhost:${server.port}`;
const setMode = (m: typeof mode) => { mode = m; };

// --- #1 valid response within deadline --------------------------------------------------
{
  setMode("ok");
  const m = new MinaraModel("sk-test", base, "fast", 250);
  const d = await m.decide(state(1));
  check(1, "valid response parsed", d.action === "buy" && !d.late && d.probabilities.buy === 0.7, `latency ${Math.round(d.latencyMs)}ms`);
}

// --- #2 response exceeds the deadline -> hold, late --------------------------------------
{
  setMode("slow");
  const m = new MinaraModel("sk-test", base, "fast", 50);
  const t0 = performance.now();
  const d = await m.decide(state(2));
  const ms = performance.now() - t0;
  check(2, "timeout -> hold + late, within deadline", d.action === "hold" && d.probabilities.hold === 1 && d.late === true && ms < 250, `${Math.round(ms)}ms`);
}

// --- #3 non-JSON content -> failed call -> hold ------------------------------------------
{
  setMode("bad");
  const m = new MinaraModel("sk-test", base, "fast", 250);
  const d = await m.decide(state(3));
  check(3, "non-JSON -> hold + late", d.action === "hold" && d.late === true && m.minaraFailures === 1);
}

// --- #4 HTTP 401 -> failed call, counter increments ---------------------------------------
{
  setMode("unauthorized");
  const m = new MinaraModel("sk-wrong", base, "fast", 250);
  const d = await m.decide(state(4));
  check(4, "401 -> hold, failures incremented", d.action === "hold" && m.minaraFailures === 1);
}

// --- #5 fresh cache reused on a later timeout ---------------------------------------------
{
  setMode("ok");
  const m = new MinaraModel("sk-test", base, "fast", 250);
  const ok = await m.decide(state(11)); // seeds the cache: block 11, spread 7
  setMode("slow");
  const reuse = await m.decide(state(13, 7)); // 2 blocks later, same spread -> cache hit
  check(5, "fresh cache reused on timeout", ok.action === "buy" && reuse.action === "buy" && reuse.late === true, `age ${13 - 11} blocks`);
}

// --- #6 stale cache (> max blocks) NOT reused ---------------------------------------------
{
  setMode("ok");
  const m = new MinaraModel("sk-test", base, "fast", 250);
  await m.decide(state(21));
  setMode("slow");
  const d = await m.decide(state(25, 7)); // 4 blocks later with default max 3 -> stale
  check(6, "stale cache rejected -> hold", d.action === "hold" && d.late === true);

  const m2 = new MinaraModel("sk-test", base, "fast", 250);
  await m2.decide(state(31, 7));
  const d2 = await m2.decide(state(32, 20)); // 1 block later but spread 2x+ -> cache rejected
  check(6, "widened spread rejected -> hold", d2.action === "hold" && d2.late === true);
}

// --- #8 MODEL selection untouched ----------------------------------------------------------
{
  setMode("ok");
  const m = new MinaraModel("sk-test", base, "fast", 250);
  const d = await m.decide(state(41));
  check(8, "mock/jev interface intact", typeof new MockModel().decide === "function" && d.inputTokens > 0);
}

server.stop(true);
console.log(failures ? `\n${failures} test(s) FAILED` : "\nall tests passed");
process.exit(failures ? 1 : 0);
