/**
 * Card content for the bento grid.
 *
 * ReactBits' MagicBento (TS-TW registry) is items-based: cards are passed as
 * `items: [{ content, colSpan, rowSpan }]`. `BentoCard` renders INSIDE
 * `item.content` — it is the card's ink, not the card surface itself.
 * The engine (MagicBento.tsx) owns the surface: spotlight, border glow,
 * stars, tilt, magnetism, click ripple.
 */
import type { ReactNode } from "react";

export function BentoCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col justify-between gap-3 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="mb-title text-[11px] font-semibold uppercase tracking-wider opacity-60">
          {title}
        </div>
        {badge ? <div className="text-[11px] opacity-60">{badge}</div> : null}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** One bar of a two-sided probability meter. */
export function ProbBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  const color =
    label === "buy" ? "bg-emerald-400" : label === "sell" ? "bg-rose-400" : "bg-white/40";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-9 shrink-0 opacity-60">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums opacity-80">{pct.toFixed(0)}%</span>
    </div>
  );
}
