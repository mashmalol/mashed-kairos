/**
 * Drives the trade ledger from the SSE stream.
 *
 * All four handlers are stable (`useCallback([])`), because App wires them into a single
 * `useEffect` that runs once per mount. State updates are pure functions from `ledger.ts`;
 * the only side effect is persisting fills, which happens in the event handler — never
 * inside a state updater (StrictMode invokes those twice).
 */
import { useCallback, useRef, useState } from "react";
import type { BlockEvent, Fill, Meta, Quote } from "./types";
import {
  entryFromBlock,
  entryFromFill,
  ingestHistory,
  loadDone,
  mergeEntries,
  patchQuote,
  saveDone,
  upsertBooked,
  type LedgerEntry,
} from "./ledger";

const DONE_CAP = 200;

export interface LedgerApi {
  entries: LedgerEntry[];
  onSnapshot: (meta: Meta, history: BlockEvent[]) => void;
  onBlock: (event: BlockEvent) => void;
  onQuote: (block: number, quote: Quote) => void;
  onFill: (block: number, fill: Fill) => void;
}

export function useLedger(): LedgerApi {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  /** The bot's `startedAt` — the identity of the trading session. */
  const session = useRef<number | null>(null);
  /** Mirror of the done rows, so a fill can be persisted without reading React state. */
  const done = useRef<LedgerEntry[]>([]);

  const onSnapshot = useCallback((meta: Meta, history: BlockEvent[]) => {
    if (session.current !== meta.startedAt) {
      session.current = meta.startedAt;
      done.current = loadDone(meta.startedAt);
    }
    setEntries((prev) =>
      mergeEntries(ingestHistory(prev, history), done.current),
    );
  }, []);

  const onBlock = useCallback((event: BlockEvent) => {
    const entry = entryFromBlock(event);
    if (!entry) return;
    setEntries((prev) => upsertBooked(prev, entry));
  }, []);

  const onQuote = useCallback((block: number, quote: Quote) => {
    setEntries((prev) => patchQuote(prev, block, quote));
  }, []);

  const onFill = useCallback((block: number, fill: Fill) => {
    const entry = entryFromFill(block, fill);
    if (done.current.some((e) => e.id === entry.id)) return; // duplicate frame after a reconnect
    done.current = [entry, ...done.current].slice(0, DONE_CAP);
    if (session.current !== null) saveDone(session.current, done.current);
    setEntries((prev) => mergeEntries(prev, [entry]));
  }, []);

  return { entries, onSnapshot, onBlock, onQuote, onFill };
}
