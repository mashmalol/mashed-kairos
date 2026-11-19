/**
 * The trade ledger: one durable, filterable record of what the bot *booked* (posted an
 * order for) and what *filled*.
 *
 * Why it is not just `history`:
 *   - The bot's `history` keeps block events, and those carry `quote` but always
 *     `fill: null`; fills are broadcast as their own SSE frames (see src/server.ts).
 *   - A quote's receipt arrives blocks later as a `quote` frame, and `history` still
 *     holds the original `status: "sent"`. So statuses have to be merged by block.
 *   - A reload would otherwise lose every fill, because the server cannot replay them.
 *
 * Therefore: booked rows are rebuilt from `history` and patched live by `quote` frames;
 * done rows come from `fill` frames and are persisted in localStorage, keyed to the bot's
 * `startedAt` so a bot restart starts a clean ledger.
 *
 * Pure functions only — no React, no fetching. The hook that drives them lives in
 * `useLedger.ts`.
 */
import type { BlockEvent, Fill, Quote, QuoteStatus, Side } from "./types";

export type LedgerKind = "booked" | "done";
export type LedgerStatus = QuoteStatus | "filled";

export interface LedgerEntry {
  /** `b:<block>` for a booked order (one per block), `f:<block>:<orderId>:<tx>` for a fill. */
  id: string;
  kind: LedgerKind;
  block: number;
  /** When the dashboard learned about it (booked: the block's ts, done: receipt time). */
  ts: number;
  side: Side;
  size: number;
  price: number;
  status: LedgerStatus;
  orderId: number | null;
  txHash: string | null;
  gasMon: number;
  capped: boolean;
  simulated: boolean;
  /** The model's buy probability for the block that booked this order. */
  buyProb: number | null;
}

/** A receipt is final; nothing may move it back to `sent`. */
const TERMINAL: LedgerStatus[] = ["placed", "reverted", "lost"];
const isTerminal = (s: LedgerStatus) => TERMINAL.includes(s);

/**
 * Newest first. Block is the primary key (millisecond timestamps collide when a burst of
 * events lands together, and block order is what the user reasons about), then time, then
 * id so the order is stable between renders.
 */
export const compareEntries = (a: LedgerEntry, b: LedgerEntry) =>
  b.block - a.block || b.ts - a.ts || b.id.localeCompare(a.id);

const sortDesc = compareEntries;

export const bookedId = (block: number) => `b:${block}`;
export const fillId = (block: number, f: Fill) =>
  `f:${block}:${f.orderId}:${f.txHash ?? "sim"}`;

export function entryFromBlock(e: BlockEvent): LedgerEntry | null {
  const q = e.quote;
  if (!q) return null;
  return {
    id: bookedId(e.block),
    kind: "booked",
    block: e.block,
    ts: e.ts,
    side: q.side,
    size: q.size,
    price: q.price,
    status: q.status,
    orderId: q.orderId,
    txHash: q.txHash,
    gasMon: q.gasMon,
    capped: q.capped,
    simulated: q.status === "sim",
    buyProb: e.decision?.probabilities?.buy ?? null,
  };
}

/** A receipt frame may arrive for a block we never saw book (late join, trimmed history). */
function entryFromQuote(block: number, q: Quote): LedgerEntry {
  return {
    id: bookedId(block),
    kind: "booked",
    block,
    ts: Date.now(),
    side: q.side,
    size: q.size,
    price: q.price,
    status: q.status,
    orderId: q.orderId,
    txHash: q.txHash,
    gasMon: q.gasMon,
    capped: q.capped,
    simulated: q.status === "sim",
    buyProb: null,
  };
}

export function entryFromFill(block: number, f: Fill, ts = Date.now()): LedgerEntry {
  return {
    id: fillId(block, f),
    kind: "done",
    block,
    ts,
    side: f.side,
    size: f.size,
    price: f.price,
    status: "filled",
    orderId: f.orderId,
    txHash: f.txHash,
    gasMon: 0,
    capped: false,
    simulated: f.simulated,
    buyProb: null,
  };
}

/**
 * Per-kind caps. Booked rows arrive ~3/second, so a single shared cap would evict every
 * fill within minutes — the exact rows the user opened the log for.
 */
const BOOKED_CAP = 300;
const DONE_CAP = 200;

function trim(entries: LedgerEntry[]): LedgerEntry[] {
  const booked: LedgerEntry[] = [];
  const done: LedgerEntry[] = [];
  for (const e of entries) (e.kind === "booked" ? booked : done).push(e);
  if (booked.length > BOOKED_CAP) booked.length = BOOKED_CAP;
  if (done.length > DONE_CAP) done.length = DONE_CAP;
  return booked.concat(done).sort(sortDesc);
}

/** Add or advance a booked row without ever downgrading a final receipt. */
export function upsertBooked(entries: LedgerEntry[], fresh: LedgerEntry): LedgerEntry[] {
  const i = entries.findIndex((e) => e.id === fresh.id);
  if (i === -1) return trim([fresh, ...entries]);
  const prev = entries[i]!;
  // History replays "sent"; a receipt we already have is newer information.
  if (isTerminal(prev.status) && !isTerminal(fresh.status)) return entries;
  const next = entries.slice();
  next[i] = { ...fresh, ts: prev.ts };
  return next;
}

/** Apply a `quote` frame (the async receipt: placed / reverted / lost). */
export function patchQuote(entries: LedgerEntry[], block: number, q: Quote): LedgerEntry[] {
  const id = bookedId(block);
  const i = entries.findIndex((e) => e.id === id);
  if (i === -1) return trim([entryFromQuote(block, q), ...entries]);
  const prev = entries[i]!;
  if (isTerminal(prev.status)) return entries;
  const next = entries.slice();
  next[i] = {
    ...prev,
    status: q.status,
    orderId: q.orderId ?? prev.orderId,
    txHash: q.txHash ?? prev.txHash,
    // The receipt carries the real gas; the block event only carried the estimate.
    gasMon: q.gasMon || prev.gasMon,
    capped: q.capped,
  };
  return next;
}

/** Rebuild booked rows from a snapshot's history, keeping any receipts already applied. */
export function ingestHistory(entries: LedgerEntry[], history: BlockEvent[]): LedgerEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of history) {
    const fresh = entryFromBlock(e);
    if (!fresh) continue;
    const prev = byId.get(fresh.id);
    if (!prev) byId.set(fresh.id, fresh);
    else if (!isTerminal(prev.status)) byId.set(fresh.id, { ...fresh, ts: prev.ts });
  }
  return trim([...byId.values()].sort(sortDesc));
}

/** Union by id, existing rows winning. Used to fold persisted fills into live state. */
export function mergeEntries(base: LedgerEntry[], extra: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map(base.map((e) => [e.id, e]));
  for (const e of extra) if (!byId.has(e.id)) byId.set(e.id, e);
  return trim([...byId.values()].sort(sortDesc));
}

// --- persistence -----------------------------------------------------------------------
// Keyed to `meta.startedAt`: a new bot process is a new trading session, so the previous
// session's fills must not be mixed into it. Client-side only — the UI stays read-only.

const DONE_KEY = "kairos.fills.v1";

interface Persisted {
  session: number;
  entries: LedgerEntry[];
}

export function loadDone(session: number): LedgerEntry[] {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as Persisted;
    if (p.session !== session || !Array.isArray(p.entries)) return [];
    // Guard against a hand-edited or half-written record.
    return p.entries.filter((e) => e && e.kind === "done" && Number.isFinite(e.block));
  } catch {
    return [];
  }
}

export function saveDone(session: number, entries: LedgerEntry[]): void {
  try {
    const payload: Persisted = { session, entries: entries.filter((e) => e.kind === "done") };
    localStorage.setItem(DONE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or private mode: the in-memory ledger still works, it just will not survive a reload.
  }
}
