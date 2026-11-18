/**
 * The data → visual contract (seed §3): every Hyperspeed prop derives from the
 * SSE block event, smoothed so nothing flips on a single block.
 *
 * - buyProb EMA: one block is noise, ten blocks is signal.
 * - boosting is a 400 ms pulse (fills, action changes) — never a held state.
 * - the regime curve switches with a 3 s dwell time.
 * - model health (minaraFailures > 0) kills the scene: no poles, no dust,
 *   near-zero glow.
 * - prefers-reduced-motion: slow speed, dim glow, no pulses.
 *
 * Returns a memoized object; Hyperspeed reads props per frame through its own
 * settings ref, so the object identity only matters for wasted work, not for
 * remounting. Never key the backdrop on the block number.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BlockEvent } from "./types";
import type { HyperspeedProps } from "../components/HyperspeedBackdrop";

const PULSE_MS = 400;
const REGIME_DWELL_MS = 3000;
/** 15% per block — ~63% of a step change after 6 blocks. */
const EMA_ALPHA = 0.15;

type Curve = "straight" | "gentle" | "winding" | "hills" | "racing" | "deep";

const REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Weak-hardware density cut, decided once at mount (seed §8). */
const WEAK_HARDWARE =
  typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 8) <= 4;

export function useHyperspeedDriver(latest: BlockEvent | null): HyperspeedProps {
  const buyProb = useRef(0.5);
  const [probState, setProbState] = useState(0.5);
  const [curve, setCurve] = useState<Curve>("straight");
  const lastCurveSwitch = useRef(0);
  const [boosting, setBoosting] = useState(false);
  const boostTimer = useRef<number | null>(null);
  const lastFills = useRef(0);
  const lastAction = useRef<"buy" | "sell" | "hold">("hold");

  useEffect(() => {
    if (!latest) return;
    const target = latest.decision?.probabilities.buy ?? 0.5;
    buyProb.current += (target - buyProb.current) * EMA_ALPHA;
    setProbState(buyProb.current);

    const triggerBoost = () => {
      if (REDUCED_MOTION) return;
      setBoosting(true);
      if (boostTimer.current) window.clearTimeout(boostTimer.current);
      boostTimer.current = window.setTimeout(() => setBoosting(false), PULSE_MS);
    };

    // A fill is a positive event → pulse.
    if (latest.totals.fills > lastFills.current) {
      lastFills.current = latest.totals.fills;
      triggerBoost();
    }
    // An action arriving out of hold → pulse.
    const action = latest.decision?.action ?? "hold";
    if (action !== "hold" && action !== lastAction.current) triggerBoost();
    lastAction.current = action;
  }, [latest]);

  // Regime curve, dwell-time guarded — do not switch on every block.
  useEffect(() => {
    if (!latest) return;
    const now = Date.now();
    if (now - lastCurveSwitch.current < REGIME_DWELL_MS) return;
    const buy = latest.decision?.probabilities.buy ?? 0.5;
    const sell = latest.decision?.probabilities.sell ?? 0.5;
    let next: Curve = "straight";
    if ((latest.minaraFailures ?? 0) > 0) next = "gentle";
    else if (latest.decision?.late && (latest.totals.lateBlocks ?? 0) > 3) next = "gentle";
    else if (buy > 0.6) next = "winding";
    else if (sell > 0.6) next = "deep";
    if (next !== curve) {
      setCurve(next);
      lastCurveSwitch.current = now;
    }
  }, [latest, curve]);

  return useMemo(() => {
    const late = latest?.decision.late ?? false;
    const failures = latest?.minaraFailures ?? 0;
    const healthy = failures === 0;
    const motion = REDUCED_MOTION ? 0.3 : 1;

    const palette =
      probState > 0.58
        ? {
            tailColors: ["#22c55e", "#16a34a", "#0ea5e9"],
            poleColors: ["#22c55e"],
          }
        : probState < 0.42
          ? {
              tailColors: ["#ef4444", "#dc2626", "#a855f7"],
              poleColors: ["#ef4444"],
            }
          : {};

    return {
      // Structure — fixed (seed §3.4): never drive geometry from data.
      lanes: 3,
      roadWidth: 10,
      medianWidth: 2,
      trailLength: 1,
      lightSize: 1,
      // Dynamic
      curve,
      boosting,
      speed: (0.5 + probState * 1.5) * motion,
      glow: healthy ? (late ? 0.2 : 0.6) * (REDUCED_MOTION ? 0.33 : 1) : 0.05,
      dust: healthy ? (late ? 40 : 100) : 0,
      poles: healthy ? (WEAK_HARDWARE ? 12 : 20) : 0,
      density: WEAK_HARDWARE ? 20 : undefined,
      reflections: 0.5,
      roadOpacity: 0.08,
      fov: 90,
      boostFov: 130,
      steer: 0,
      ...palette,
      background: "transparent",
      interactive: false,
    };
  }, [probState, curve, boosting, latest]);
}
