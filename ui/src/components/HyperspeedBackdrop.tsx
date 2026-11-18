/**
 * Full-viewport, fixed backdrop for the Hyperspeed road.
 *
 * Layering contract (seed §2): z-0, pointer-events: none. It must never
 * intercept clicks meant for the bento cards, and `interactive={false}` keeps
 * the component's own pointer handlers (hold-to-boost, contextmenu prevent)
 * out of the way. In focus mode the wrapper is switched to pointer-events:
 * auto by App, which re-enables the interactive drivers.
 */
import Hyperspeed from "./Hyperspeed";
import "./Hyperspeed.css";

export interface HyperspeedProps {
  curve: "straight" | "gentle" | "winding" | "hills" | "racing" | "deep";
  speed: number;
  boosting: boolean;
  glow: number;
  dust: number;
  poles: number;
  density?: number;
  roadOpacity: number;
  tailColors?: string[];
  headColors?: string[];
  poleColors?: string[];
  background?: string;
  interactive: boolean;
}

export function HyperspeedBackdrop(props: HyperspeedProps) {
  const { interactive, ...rest } = props;
  return (
    <div className="fixed inset-0 z-0" style={{ pointerEvents: interactive ? "auto" : "none" }}>
      <Hyperspeed {...rest} interactive={interactive} />
    </div>
  );
}
