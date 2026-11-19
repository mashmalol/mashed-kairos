/**
 * Trade ledger — the user's window into what the bot actually did.
 *
 * Read-only by design (seed §2): it can filter, sort, search, freeze and export what the
 * stream already delivered, but it never posts an order or a control command.
 *
 * Rows are of two kinds:
 *   booked — an order the bot put on the book that block (status sent/sim, then
 *            placed/reverted/lost once the receipt lands);
 *   done   — a taker hit one of our resting orders (a real fill).
 *
 * The panel lives below the bento grid rather than inside it: MagicBento tilts cards on
 * pointer move, which fights with a scrolling table.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { compareEntries, type LedgerEntry, type LedgerStatus } from "../lib/ledger";

type Filter = "all" | "booked" | "done" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "all" },
  { id: "booked", label: "booked" },
  { id: "done", label: "done" },
  { id: "failed", label: "failed" },
];

const STATUS_STYLE: Record<LedgerStatus, string> = {
  sim: "text-white/50",
  sent: "text-amber-300/80",
  placed: "text-sky-300",
  reverted: "text-rose-400",
  lost: "text-rose-400",
  filled: "text-emerald-400",
};

const STATUS_LABEL: Record<LedgerStatus, string> = {
  sim: "sim rest",
  sent: "sent",
  placed: "placed",
  reverted: "reverted",
  lost: "lost",
  filled: "filled",
};

const PAGE = 60;

const timeOf = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

const notionalOf = (e: LedgerEntry) => e.size * e.price;

const fmtNotional = (n: number) => (n >= 1 ? n.toFixed(2) : n.toFixed(4));
const fmtPrice = (n: number) =>
  n >= 1
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toFixed(6);
const short = (h: string | null, head = 6, tail = 4) =>
  !h ? "—" : h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;

function matches(e: LedgerEntry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "booked") return e.kind === "booked";
  if (filter === "done") return e.kind === "done";
  return e.status === "reverted" || e.status === "lost";
}

function searchable(e: LedgerEntry): string {
  return [
    e.kind,
    e.side,
    e.status,
    `#${e.block}`,
    String(e.block),
    e.orderId != null ? `#${e.orderId}` : "",
    e.orderId != null ? String(e.orderId) : "",
    e.txHash ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function TradeLog({ entries, pair }: { entries: LedgerEntry[]; pair: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Freeze the view so rows stop moving underneath a click. The stream keeps flowing;
  // only the render target is pinned, and the header shows how many rows arrived since.
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LedgerEntry[] | null>(null);
  const frozenIds = useRef<Set<string>>(new Set());

  const quoteSymbol = pair.includes("/") ? pair.split("/")[1]! : "";

  const togglePause = () => {
    if (paused) {
      setFrozen(null);
      frozenIds.current = new Set();
      setPaused(false);
    } else {
      setFrozen(entries);
      frozenIds.current = new Set(entries.map((e) => e.id));
      setPaused(true);
    }
  };

  const view = paused && frozen ? frozen : entries;

  const counts = useMemo(() => {
    let booked = 0;
    let done = 0;
    let failed = 0;
    let bookedNotional = 0;
    let doneNotional = 0;
    let gas = 0;
    for (const e of view) {
      if (e.kind === "booked") {
        booked++;
        bookedNotional += notionalOf(e);
        gas += e.gasMon;
      } else {
        done++;
        doneNotional += notionalOf(e);
      }
      if (e.status === "reverted" || e.status === "lost") failed++;
    }
    return { booked, done, failed, bookedNotional, doneNotional, gas };
  }, [view]);

  const pending = paused ? entries.filter((e) => !frozenIds.current.has(e.id)).length : 0;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = view
      .filter((e) => matches(e, filter) && (!q || searchable(e).includes(q)))
      .sort(compareEntries);
    return newestFirst ? out : out.reverse();
  }, [view, filter, search, newestFirst]);

  // A new filter or search starts at the top of its own list.
  useEffect(() => setLimit(PAGE), [filter, search, newestFirst]);

  const shown = rows.slice(0, limit);

  const exportCsv = () => {
    const header = "time,block,kind,side,size,price,notional,status,order_id,tx_hash,gas_mon,capped,simulated";
    const lines = rows.map((e) =>
      [
        new Date(e.ts).toISOString(),
        e.block,
        e.kind,
        e.side,
        e.size,
        e.price,
        notionalOf(e).toFixed(6),
        e.status,
        e.orderId ?? "",
        e.txHash ?? "",
        e.gasMon,
        e.capped,
        e.simulated,
      ].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mashed-kairos-trades-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {
      // Clipboard blocked (insecure context): nothing to recover from, the value is on screen.
    }
  };

  return (
    <section
      aria-label="Trade log"
      className="mt-4 overflow-hidden rounded-[20px] border border-white/[0.07] shadow-[0_24px_48px_-28px_rgba(0,0,0,0.85)]"
      style={{
        background: "linear-gradient(180deg, rgba(26,24,32,0.72) 0%, rgba(18,17,22,0.86) 100%)",
        backdropFilter: "blur(14px)",
      }}
    >
      {/* Header: identity, session totals, freeze + export */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold tracking-tight text-white/90">Trade log</h2>
          <span className="text-[11px] text-white/40">
            {counts.booked} booked · {counts.done} filled
            {counts.done > 0 && counts.booked > 0 ? ` · ${((counts.done / counts.booked) * 100).toFixed(0)}% hit` : ""}
            {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {pending > 0 && (
            <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-sky-300">
              +{pending} new
            </span>
          )}
          <button
            type="button"
            onClick={togglePause}
            aria-pressed={paused}
            className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
              paused
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/10 text-white/60 hover:bg-white/5"
            }`}
          >
            {paused ? "frozen" : "live"}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!rows.length}
            className="rounded-full border border-white/10 px-3 py-1 text-[11px] uppercase tracking-wider text-white/60 transition-colors hover:bg-white/5 disabled:opacity-30"
          >
            csv
          </button>
        </div>
      </div>

      {/* Controls: kind filter, search, sort */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-5 py-3">
        <div className="flex items-center gap-1" role="tablist" aria-label="Filter by kind">
          {FILTERS.map((f) => {
            const active = filter === f.id;
            const n =
              f.id === "all"
                ? view.length
                : f.id === "booked"
                  ? counts.booked
                  : f.id === "done"
                    ? counts.done
                    : counts.failed;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  active ? "bg-white/10 text-white/90" : "text-white/45 hover:text-white/70"
                }`}
              >
                {f.label}
                <span className={`ml-1 tabular-nums ${active ? "text-white/50" : "text-white/25"}`}>{n}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="block, order, tx…"
            aria-label="Search the trade log"
            className="w-40 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-white/80 placeholder:text-white/25 focus:border-white/25 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setNewestFirst((v) => !v)}
            aria-label={newestFirst ? "Newest first" : "Oldest first"}
            className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/60 transition-colors hover:bg-white/5"
          >
            {newestFirst ? "↓ newest" : "↑ oldest"}
          </button>
        </div>
      </div>

      {/* The ledger */}
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full border-collapse text-left text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-[#141319]/95 backdrop-blur">
            <tr className="text-[9.5px] uppercase tracking-[0.12em] text-white/35">
              <th scope="col" className="px-4 py-2 font-medium">time</th>
              <th scope="col" className="px-2 py-2 font-medium">block</th>
              <th scope="col" className="px-2 py-2 font-medium">kind</th>
              <th scope="col" className="px-2 py-2 font-medium">side</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">size</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">price</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">notional</th>
              <th scope="col" className="px-2 py-2 font-medium">status</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">order / tx</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const open = expanded === e.id;
              const key = `${e.id}`;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => setExpanded(open ? null : e.id)}
                    aria-expanded={open}
                    className={`cursor-pointer border-t border-white/[0.04] transition-colors hover:bg-white/[0.035] ${
                      e.kind === "done" ? "bg-emerald-400/[0.04]" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-1.5 font-mono text-[10.5px] text-white/40">{timeOf(e.ts)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[10.5px] text-white/55">#{e.block}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider ${
                          e.kind === "done"
                            ? "bg-emerald-400/10 text-emerald-300"
                            : "bg-white/[0.06] text-white/45"
                        }`}
                      >
                        {e.kind === "done" ? "done" : "booked"}
                      </span>
                    </td>
                    <td className={`px-2 py-1.5 font-semibold ${e.side === "buy" ? "text-emerald-400" : "text-rose-400"}`}>
                      {e.side.toUpperCase()}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/75">{e.size}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/75">{fmtPrice(e.price)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/50">
                      {fmtNotional(notionalOf(e))}
                      <span className="ml-1 text-white/25">{quoteSymbol}</span>
                    </td>
                    <td className={`px-2 py-1.5 ${STATUS_STYLE[e.status]}`}>
                      {STATUS_LABEL[e.status]}
                      {e.capped && <span className="ml-1 text-amber-300/70">cap</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-right font-mono text-[10.5px] text-white/40">
                      {e.orderId != null ? `#${e.orderId}` : short(e.txHash)}
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-t border-white/[0.04] bg-black/25">
                      <td colSpan={9} className="px-4 py-3">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] sm:grid-cols-4">
                          <Field label="block" value={`#${e.block}`} />
                          <Field label="status" value={STATUS_LABEL[e.status]} />
                          <Field label="order id" value={e.orderId != null ? `#${e.orderId}` : "not assigned"} />
                          {/* Fills carry no gas of their own: Monad charges the order's transaction. */}
                          <Field
                            label="gas"
                            value={e.kind === "done" ? "— (on the order)" : `${e.gasMon.toFixed(6)} MON`}
                          />
                          <Field label="model p(buy)" value={e.buyProb != null ? `${(e.buyProb * 100).toFixed(1)}%` : "—"} />
                          <Field label="capped" value={e.capped ? "yes (side flipped by cap/funds)" : "no"} />
                          <Field label="simulated" value={e.simulated ? "yes" : "no"} />
                          <Field label="notional" value={`${notionalOf(e).toFixed(6)} ${quoteSymbol}`} />
                          <div className="col-span-2 sm:col-span-4">
                            <div className="text-[9.5px] uppercase tracking-[0.12em] text-white/30">tx hash</div>
                            <div className="mt-0.5 flex items-center gap-2">
                              <code className="truncate font-mono text-[10.5px] text-white/60">{e.txHash ?? "—"}</code>
                              {e.txHash && (
                                <button
                                  type="button"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    void copy(e.txHash!, e.id);
                                  }}
                                  className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[10px] text-white/50 hover:bg-white/5"
                                >
                                  {copied === e.id ? "copied" : "copy"}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {!rows.length && (
          <div className="px-5 py-10 text-center text-[12px] text-white/35">
            {entries.length ? "nothing matches this filter" : "no orders booked yet — the bot books one per traded block"}
          </div>
        )}

        {rows.length > shown.length && (
          <div className="border-t border-white/[0.05] px-4 py-2 text-center">
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE)}
              className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-white/55 transition-colors hover:bg-white/5"
            >
              show {Math.min(PAGE, rows.length - shown.length)} more · {rows.length - shown.length} hidden
            </button>
          </div>
        )}
      </div>

      {/* Footer: what the numbers cover */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-5 py-2.5 text-[10.5px] text-white/35">
        <span>
          booked {fmtNotional(counts.bookedNotional)} {quoteSymbol} · filled{" "}
          {fmtNotional(counts.doneNotional)} {quoteSymbol} · gas {counts.gas.toFixed(5)} MON
        </span>
        <span>
          showing {shown.length} of {rows.length}
          {paused ? " · frozen" : ""} · kept: 300 booked / 200 filled
        </span>
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-[0.12em] text-white/30">{label}</div>
      <div className="mt-0.5 font-mono text-[10.5px] text-white/60">{value}</div>
    </div>
  );
}
