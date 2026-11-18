/** Wire types for the bot's SSE feed — copied from src/trader.ts / src/market.ts, never imported. */

export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
export type QuoteStatus = "sent" | "placed" | "reverted" | "lost" | "sim";

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  late: boolean;
}

export interface Quote {
  side: Side;
  price: number;
  size: number;
  txHash: string | null;
  gasMon: number;
  cancel: number[];
  status: QuoteStatus;
  orderId: number | null;
  capped: boolean;
}

export interface Fill {
  side: Side;
  size: number;
  price: number;
  txHash: string | null;
  orderId: number;
  simulated: boolean;
}

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: Decision | null;
  quote: Quote | null;
  fill: Fill | null;
  resting: { bidMon: number; askMon: number };
  position: {
    side: "long" | "short" | "flat";
    size: number;
    entryPrice: number | null;
    unrealizedUsd: number;
    unrealizedMon: number;
  };
  totals: Totals;
  /** Emitted by the backend for the Minara adapter; 0 when MODEL is not minara. */
  minaraFailures?: number;
}

export interface Meta {
  model: string;
  wallet: string | null;
  dryRun: boolean;
  market: string;
  startedAt: number;
  pair: string;
  running?: boolean;
}

export type FeedEvent =
  | { type: "snapshot"; meta: Meta; latest: BlockEvent | null; history: BlockEvent[] }
  | { type: "block"; event: BlockEvent }
  | { type: "quote"; block: number; quote: Quote }
  | { type: "fill"; block: number; fill: Fill }
  | { type: "control"; running: boolean };
