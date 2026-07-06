import { useEffect, useRef, useState } from "react";

import { useIsActiveTabWorking } from "../lib/agent-store.js";

type ProgressState = "hidden" | "showing" | "hiding";

const HIDE_DELAY_MS = 260;
const DEFAULT_PACE_MS = 2200;
const MIN_PACE_MS = 1200;
const MAX_PACE_MS = 3200;
const PACE_DIVISOR = 900;
const PACE_BASE = 2000;
const REFERENCE_WIDTH = 360;

function paceFor(width: number): number {
  return Math.round(
    Math.max(
      MIN_PACE_MS,
      Math.min(MAX_PACE_MS, (Math.max(width, REFERENCE_WIDTH) * PACE_BASE) / PACE_DIVISOR),
    ),
  );
}

export const __test__ = { paceFor, HIDE_DELAY_MS, MIN_PACE_MS, MAX_PACE_MS };

export function ProgressBar() {
  const isWorking = useIsActiveTabWorking();
  const [state, setState] = useState<ProgressState>("hidden");
  const [pace, setPace] = useState(DEFAULT_PACE_MS);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isWorking) {
      setState("showing");
      return;
    }
    if (state === "showing") {
      setState("hiding");
      const t = setTimeout(() => setState("hidden"), HIDE_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [isWorking, state]);

  useEffect(() => {
    if (state === "hidden") return;
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setPace(paceFor(w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);

  if (state === "hidden") return null;

  return (
    <div
      ref={ref}
      data-component="session-progress"
      data-state={state}
      aria-hidden
      className="bg-signal sticky top-0 z-10 h-0.5 w-full overflow-hidden"
    >
      <div
        data-component="session-progress-bar"
        className="h-full w-full rounded-full"
        style={{
          animation: `session-progress-whip ${pace}ms infinite`,
        }}
      />
    </div>
  );
}
