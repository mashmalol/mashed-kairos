/**
 * jev-traderbot dashboard (seed-context.md: UI layer, read-only).
 *
 * Layering (seed §2): Hyperspeed z-0 → gradient veil z-10 → content z-20.
 * The UI never imports from src/ and never calls the Minara API; it only
 * consumes GET /events. All writes go through the backend's own control
 * endpoints, none are exposed here.
 */
import { useEffect, useState } from "react";
import { HyperspeedBackdrop } from "./components/HyperspeedBackdrop";
import MagicBento from "./components/MagicBento";
import { BentoCard, ProbBar } from "./components/BentoCard";
import { TradeLog } from "./components/TradeLog";
import { useHyperspeedDriver } from "./lib/useHyperspeedDriver";
import { useLedger } from "./lib/useLedger";
import { connectSSE } from "./lib/sse";
import type { BlockEvent, Meta } from "./lib/types";

const WEAK_HARDWARE =
  typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 8) <= 4;

export default function App() {
  const [latest, setLatest] = useState<BlockEvent | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(true);
  const [focus, setFocus] = useState(false);
  const [pairOverride, setPairOverride] = useState<string | null>(() =>
    typeof window === "undefined" ? null : localStorage.getItem("kairos.pair"),
  );
  const ledger = useLedger();
  // The bot's actual market is fixed by its MARKET env; the header select is the user's
  // display choice. The live pair is always in the list, the stored override wins.
  const pairOptions = Array.from(
    new Set(["cbBTC/USDC", "MON/USDC", "WMON/USDC", "ETH/USDC", meta?.pair ?? ""].filter(Boolean)),
  );
  const pair = pairOverride ?? meta?.pair ?? "…";

  const { onSnapshot, onBlock, onQuote, onFill } = ledger;

  useEffect(() => {
    return connectSSE(
      (event) => {
        setConnected(true);
        if (event.type === "snapshot") {
          setMeta(event.meta);
          if (event.latest) setLatest(event.latest);
          if (event.meta.running !== undefined) setRunning(event.meta.running);
          onSnapshot(event.meta, event.history);
        } else if (event.type === "block") {
          setLatest(event.event);
          onBlock(event.event);
        } else if (event.type === "quote") {
          setLatest((prev) => (prev ? { ...prev, quote: event.quote } : prev));
          onQuote(event.block, event.quote);
        } else if (event.type === "fill") {
          setLatest((prev) => (prev ? { ...prev, fill: event.fill } : prev));
          onFill(event.block, event.fill);
        } else if (event.type === "control") {
          setRunning(event.running);
        }
      },
      () => setConnected(false),
    );
  }, [onSnapshot, onBlock, onQuote, onFill]);

  // Escape exits focus mode.
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const hyperspeedProps = useHyperspeedDriver(latest);

  return (
    <div className="relative min-h-screen bg-[#050507]">
      {/* Layer 0: Hyperspeed — mounted only after the first event (seed §8). */}
      {latest && <HyperspeedBackdrop {...hyperspeedProps} interactive={focus} />}

      {/* Layer 10: gradient veil — keeps card text readable over the road. */}
      <div
        className="fixed inset-0 z-10"
        style={{
          pointerEvents: "none",
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%)",
        }}
      />

      {/* Layer 20: content */}
      <main className={`relative z-20 min-h-screen p-6 transition-opacity ${focus ? "opacity-40" : ""}`}>
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-white/90">
              mashed kairos
            </h1>
            {/* The pair is display metadata: the bot's market is fixed by its MARKET env var.
                The override is kept in localStorage so a reload keeps the user's choice. */}
            <select
              value={pair}
              onChange={(e) => {
                const v = e.target.value;
                setPairOverride(v === meta?.pair ? null : v);
                localStorage.setItem("kairos.pair", v);
              }}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/70 outline-none"
              aria-label="Asset pair"
            >
              {pairOptions.map((p) => (
                <option key={p} value={p} className="bg-[#0a0a0a]">
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 text-sm text-white/60">
            {meta && (
              <span className="rounded-full border border-white/10 px-2.5 py-1">
                {meta.model} · {meta.dryRun ? "dry run" : "live"}
              </span>
            )}
            <span className="rounded-full border border-white/10 px-2.5 py-1">
              {!running ? "stopped" : connected ? "connected" : "connecting…"}
            </span>
            <button
              type="button"
              onClick={() => setFocus((f) => !f)}
              className="rounded-full border border-white/15 px-3 py-1 text-xs uppercase tracking-wider text-white/70 transition-colors hover:bg-white/10"
            >
              {focus ? "exit warp" : "warp"}
            </button>
          </div>
        </header>

        {latest ? (
          <div className={focus ? "pointer-events-none" : "pointer-events-auto"}>
            <MagicBento
              columns={4}
              rowHeight={180}
              gap={14}
              radius={20}
              glowColor="59, 130, 246"
              spotlightRadius={WEAK_HARDWARE ? 200 : 400}
              enableStars={!WEAK_HARDWARE}
              enableSpotlight
              enableBorderGlow
              enableTilt
              enableMagnetism
              clickEffect
              disableAnimations={WEAK_HARDWARE}
              items={[
                { content: <DecisionCard latest={latest} />, colSpan: 2 },
                { content: <LatencyCard latest={latest} /> },
                { content: <QuoteCard latest={latest} /> },
                { content: <PositionCard latest={latest} /> },
                { content: <ModelHealthCard latest={latest} /> },
                // The fills live in the trade log below — no duplicate card here.
                { content: <PnlCard latest={latest} />, colSpan: 2 },
              ]}
            />
            <TradeLog entries={ledger.entries} pair={pair} />
          </div>
        ) : (
          <div className="flex h-[50vh] items-center justify-center text-white/50">
            Connecting to mashed kairos…
          </div>
        )}
      </main>
    </div>
  );
}

function DecisionCard({ latest }: { latest: BlockEvent }) {
  const d = latest.decision;
  return (
    <BentoCard
      title="Kairos Decision"
      badge={`block ${latest.block}`}
    >
      {d ? (
        <div className="flex h-full flex-col justify-center gap-3">
          <div
            className={`text-4xl font-bold ${
              d.action === "buy"
                ? "text-emerald-400"
                : d.action === "sell"
                  ? "text-rose-400"
                  : "text-white/50"
            }`}
          >
            {d.action.toUpperCase()}
          </div>
          <div className="flex flex-col gap-1.5">
            <ProbBar label="buy" value={d.probabilities.buy ?? 0} />
            <ProbBar label="sell" value={d.probabilities.sell ?? 0} />
          </div>
          <div className="text-xs opacity-60">
            upIn10 {(d.upIn10 * 100).toFixed(0)}% · mid {latest.mid.toFixed(6)}
          </div>
        </div>
      ) : (
        <div className="text-sm opacity-50">no decision yet</div>
      )}
    </BentoCard>
  );
}

function LatencyCard({ latest }: { latest: BlockEvent }) {
  const d = latest.decision;
  return (
    <BentoCard title="Latency / Late">
      <div className="flex h-full flex-col justify-center gap-2">
        <div className="text-2xl font-semibold">{d ? `${d.latencyMs} ms` : "—"}</div>
        <div className={d?.late ? "text-red-400" : "text-green-400"}>
          {d ? (d.late ? "LATE" : "ON TIME") : "—"}
        </div>
        <div className="text-xs opacity-60">late blocks: {latest.totals.lateBlocks}</div>
      </div>
    </BentoCard>
  );
}

function QuoteCard({ latest }: { latest: BlockEvent }) {
  const q = latest.quote;
  return (
    <BentoCard title="Quote">
      <div className="flex h-full flex-col justify-center gap-2">
        <div className="text-lg font-semibold">
          {q ? `${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}` : "—"}
        </div>
        <div className="text-xs opacity-60">
          {q ? `${q.status}${q.capped ? " · capped" : ""}` : "no quote"}
        </div>
        <div className="text-xs opacity-60">
          resting {latest.resting.bidMon} bid / {latest.resting.askMon} ask
        </div>
      </div>
    </BentoCard>
  );
}

function PositionCard({ latest }: { latest: BlockEvent }) {
  const p = latest.position;
  const u = p.unrealizedUsd;
  return (
    <BentoCard title="Position">
      <div className="flex h-full flex-col justify-center gap-2">
        <div className="text-lg font-semibold">
          {p.side} {p.size}
        </div>
        <div className={u >= 0 ? "text-green-400" : "text-red-400"}>
          {u >= 0 ? "+" : ""}
          {u.toFixed(6)} USD
        </div>
        <div className="text-xs opacity-60">
          entry {p.entryPrice != null ? p.entryPrice.toFixed(6) : "—"}
        </div>
      </div>
    </BentoCard>
  );
}

function ModelHealthCard({ latest }: { latest: BlockEvent }) {
  const failures = latest.minaraFailures ?? 0;
  const decisions = latest.totals.decisions;
  const late = latest.totals.lateBlocks;
  const okRate = decisions ? ((decisions - late) / decisions) * 100 : 100;
  return (
    <BentoCard title="Model Health">
      <div className="flex h-full flex-col justify-center gap-2">
        <div className={`text-lg font-semibold ${failures ? "text-red-400" : "text-green-400"}`}>
          {failures ? `${failures} failures` : "healthy"}
        </div>
        <div className="text-xs opacity-60">on-time: {okRate.toFixed(0)}%</div>
        <div className="text-xs opacity-60">
          {latest.totals.decisions} decisions · {latest.totals.quotes} quotes
        </div>
      </div>
    </BentoCard>
  );
}

function PnlCard({ latest }: { latest: BlockEvent }) {
  const t = latest.totals;
  return (
    <BentoCard title="PnL">
      <div className="flex h-full flex-col justify-center gap-2">
        <div className={`text-3xl ${t.pnlUsd >= 0 ? "text-green-400" : "text-red-400"}`}>
          {t.pnlUsd >= 0 ? "+" : ""}
          {t.pnlUsd.toFixed(4)} USD
        </div>
        <div className="text-xs opacity-60">
          {t.blocks} blocks · {t.fills} fills · {t.gasMon.toFixed(3)} MON gas
        </div>
      </div>
    </BentoCard>
  );
}
