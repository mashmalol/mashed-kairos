import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

/** Models answer buy or sell. `hold` only appears on late blocks (no decision was made). */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: string;
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting MON within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  allowed: { buy: boolean; sell: boolean };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
  /** Set by models that answer after their own deadline (Minara): the block was answered late. */
  late?: boolean;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will the base asset be higher or lower than the current mid after `horizonBlocks` more blocks?",
      goal: "Make markets on this book on Kuru. Blocks are ~300 ms; `horizonBlocks` (~30 s) is the horizon. Every block one post-only limit order goes on the side you pick, just inside the touch, replacing the previous one. It never crosses, so we earn `spreadBps` rather than pay it. The cost is adverse selection: a taker fills us exactly when the market is about to run the other way. Pick the side whose inventory you want to be holding `horizonBlocks` from now.",
      timing: "The order rests on the book from the next block until it is replaced, cancelled or filled. It fills only when a taker crosses it: a bid is filled by a taker sell, an ask by a taker buy. Most blocks do not fill.",
      inputs: "Taker flow is the strongest signal: `trades.cvdMon` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book, and therefore who would hit us. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. A wide `spreadBps` means more edge per fill. If `allowed.buy` is false the order goes on the sell side regardless, and vice versa.",
    },
    criteria: {
      buy: "Post a bid: mid more likely to be higher after `horizonBlocks` blocks. A fill here leaves us long the base asset, bought below mid.",
      sell: "Post an ask: mid more likely to be lower after `horizonBlocks` blocks. A fill here leaves us short the base asset, sold above mid.",
    },
  },
} as const;

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel implements Model {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/**
 * Minara Agent API ("Kairos"): one synchronous `POST /v1/developer/chat` per block in
 * `mode: "fast"` (SEED-CONTEXT.md §3-§5). The Minara API is a conversational endpoint and
 * is not guaranteed to answer within the ~300 ms block, so the model enforces its own
 * deadline and never leaves the loop holding the bag:
 *
 * - Strategy A: AbortController at `minaraBlockDeadlineMs`; a timed-out call is dead —
 *   no retry inside the block.
 * - Strategy B: on failure, the last successful decision is reused only if it is at most
 *   `minaraCacheMaxBlocks` old AND the spread has not more than doubled; otherwise hold.
 * - Every failure (timeout, HTTP != 2xx, non-JSON or schema-violating content) increments
 *   `minaraFailures`, which the block event carries for the dashboard and the visual driver.
 * - A failed answer is a hold: `late: true`, `probabilities.hold = 1`, no quote posted.
 *
 * Red lines respected: no retries within a block, one call per block, no free-form
 * parsing, no CLI subprocess, `mode` is never "expert" in the loop.
 */
export class MinaraModel implements Model {
  readonly name = "minara";
  /** Monotonic failure counter; the trader copies it into every block event. */
  minaraFailures = 0;
  private cache: { decision: Decision; block: number; spreadBps: number } | null = null;
  private startedAt = Date.now();
  private calls = 0;

  constructor(
    private apiKey: string,
    private baseUrl: string = config.minaraBaseUrl,
    private mode: "fast" | "expert" = config.minaraMode,
    private blockDeadlineMs: number = config.minaraBlockDeadlineMs,
    private cacheMaxBlocks: number = config.minaraCacheMaxBlocks,
  ) {}

  async decide(state: TradeState): Promise<Decision> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.blockDeadlineMs);
    try {
      const content = await this.call(state, controller.signal);
      const parsed = this.parseDecision(content);
      this.cache = { decision: parsed, block: state.block, spreadBps: state.spreadBps };
      return { ...parsed, latencyMs: performance.now() - started };
    } catch {
      this.minaraFailures++;
      const cached = this.validCache(state);
      if (cached) return { ...cached, latencyMs: performance.now() - started, late: true };
      return {
        action: "hold",
        probabilities: { buy: 0, sell: 0, hold: 1 },
        upIn10: 0,
        latencyMs: performance.now() - started,
        inputTokens: 0,
        late: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Strategy A: one synchronous call, aborted at the deadline. Returns the raw content string or throws. */
  private async call(state: TradeState, signal: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/developer/chat`, {
      signal,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: this.mode,
        stream: false,
        background: false,
        // Idempotency key, unique per process+block so a restart never 409s against history.
        requestId: `jev-${this.startedAt}-${this.calls++}`,
        message: { role: "user", content: this.prompt(state) },
      }),
    });
    if (!res.ok) throw new Error(`Minara HTTP ${res.status}`);
    const data = (await res.json()) as { content?: unknown };
    if (typeof data.content !== "string") throw new Error("Minara: no content");
    return data.content;
  }

  /** Strict structured prompt (seed §5.3): the response must be exactly one JSON object. */
  private prompt(state: TradeState): string {
    return [
      "You are a market-making decision model for the Kuru cbBTC-USDC order book on Monad.",
      "Given the following block snapshot, return ONLY a JSON object with this exact shape:",
      '{"action":"buy"|"sell"|"hold","probabilities":{"buy":number,"sell":number,"hold":number},"upIn10":number}',
      "",
      "Rules:",
      '- "action" must be exactly one of "buy", "sell", or "hold".',
      '- "probabilities" values must sum to 1.0.',
      '- "upIn10" is the probability that the price will be higher in 10 blocks.',
      "",
      `The question is about the move over ${state.horizonBlocks} blocks (~${Math.round(state.horizonBlocks * state.blockMs / 1000)} s).`,
      "",
      "Block Snapshot:",
      JSON.stringify(state),
    ].join("\n");
  }

  /** Strict JSON schema check; anything that does not match is a failed call. */
  private parseDecision(content: string): Decision {
    let obj: unknown;
    try {
      obj = JSON.parse(content);
    } catch {
      throw new Error("Minara: content is not JSON");
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("Minara: not an object");
    const o = obj as Record<string, unknown>;
    const action = o.action;
    if (action !== "buy" && action !== "sell" && action !== "hold") throw new Error("Minara: bad action");
    const p = o.probabilities;
    if (typeof p !== "object" || p === null) throw new Error("Minara: no probabilities");
    const probs = p as Record<string, unknown>;
    const buy = Number(probs.buy), sell = Number(probs.sell), hold = Number(probs.hold);
    for (const v of [buy, sell, hold]) if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new Error("Minara: bad probability");
    if (Math.abs(buy + sell + hold - 1) > 0.01) throw new Error("Minara: probabilities do not sum to 1");
    const upIn10 = typeof o.upIn10 === "number" && Number.isFinite(o.upIn10) ? o.upIn10 : buy; // conservative default
    return {
      action,
      probabilities: { buy, sell, hold },
      upIn10,
      latencyMs: 0, // set by decide()
      inputTokens: Math.round(content.length / 4),
    };
  }

  /** Strategy B: fresh cache (age <= max, spread not > 2x since it was written). */
  private validCache(state: TradeState): Decision | null {
    const c = this.cache;
    if (!c) return null;
    if (state.block - c.block > this.cacheMaxBlocks) return null;
    if (state.spreadBps > c.spreadBps * 2) return null;
    return c.decision;
  }
}

/**
 * Jev needs TYPESAFE_AI_API_KEY. Without one every call fails, so every block is a late hold and
 * the dashboard shows nothing happening. Run the mock instead: the snapshot names it, so the
 * dashboard labels it as a stand-in rather than passing it off as Jev.
 */
export const createModel = (): Model => {
  if (config.model === "minara") {
    if (!config.minaraApiKey?.trim()) {
      console.warn("MODEL=minara but MINARA_API_KEY is not set: running the mock model instead");
      return new MockModel();
    }
    return new MinaraModel(config.minaraApiKey);
  }
  if (config.model !== "jev") return new MockModel();
  if (!process.env.TYPESAFE_AI_API_KEY?.trim()) {
    console.warn("MODEL=jev but TYPESAFE_AI_API_KEY is not set: running the mock model instead");
    return new MockModel();
  }
  return new JevModel();
};

/** Deterministic stand-in: momentum + imbalance + mean reversion toward flat. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // momentum + book imbalance + noise, pulled back toward flat so it trades both ways
    const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.block);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(block: number) {
    let h = block * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}
