/**
 * SSE client for the bot's GET /events stream.
 *
 * The UI is read-only: it consumes events, it never posts to the bot. The
 * returned function tears the connection down (used as a useEffect cleanup).
 *
 * EventSource reconnects automatically; the bot's server also pings every 15 s,
 * so no custom heartbeat logic is needed here.
 */
import type { BlockEvent, FeedEvent, Meta } from "./types";

export type FeedHandler = (event: FeedEvent) => void;

export function connectSSE(onEvent: FeedHandler, onError?: (e: Event) => void): () => void {
  // Same-origin by default (vite proxies /events in dev; in production serve the UI from the
  // bot's origin). VITE_API_URL overrides for a standalone deployment.
  const url = `${import.meta.env.VITE_API_URL ?? ""}/events`;
  const source = new EventSource(url);

  const parse = <T,>(e: MessageEvent): T => JSON.parse(e.data) as T;

  source.addEventListener("snapshot", (e) => {
    const data = parse<Partial<Meta> & { meta?: Meta; latest: BlockEvent | null; history?: BlockEvent[] }>(e);
    // The bot sends the meta fields flat ({model, wallet, ..., running, history}); normalise.
    const meta: Meta = data.meta ?? ({ ...data } as Meta);
    onEvent({ type: "snapshot", meta, latest: data.latest ?? null, history: data.history ?? [] });
  });

  source.addEventListener("block", (e) => {
    onEvent({ type: "block", event: parse<BlockEvent>(e) });
  });

  source.addEventListener("quote", (e) => {
    const data = parse<{ block: number; quote: BlockEvent["quote"] }>(e);
    if (data.quote) onEvent({ type: "quote", block: data.block, quote: data.quote });
  });

  source.addEventListener("fill", (e) => {
    const data = parse<{ block: number; fill: BlockEvent["fill"] }>(e);
    if (data.fill) onEvent({ type: "fill", block: data.block, fill: data.fill });
  });

  source.addEventListener("control", (e) => {
    onEvent({ type: "control", running: parse<{ running: boolean }>(e).running });
  });

  source.onerror = (e) => {
    // EventSource retries on its own; surface the state for the connection badge.
    onError?.(e);
  };

  return () => source.close();
}
