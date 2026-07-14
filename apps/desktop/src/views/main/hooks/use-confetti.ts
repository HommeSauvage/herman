import confetti from "canvas-confetti";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAgentStore } from "../lib/agent-store.js";

const DEFAULT_COLORS = [
  "#22c55e", // signal (green)
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#a855f7", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
];

const DEFAULT_DURATION_MS = 5_000;

/**
 * Fires a double-cannon confetti animation using canvas-confetti.
 *
 * The animation only plays while the app window is focused AND visible.
 * If the window is in the background when `start` is called, the animation
 * waits until the window becomes visible before firing.
 */
export function useConfetti(options?: {
  colors?: string[];
  /** Duration in ms. Default 5000. */
  durationMs?: number;
}) {
  const colors = options?.colors ?? DEFAULT_COLORS;
  const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;

  const { focused, visible } = useAgentStore(
    useShallow((s) => ({ focused: s.ads.focused, visible: s.ads.visible })),
  );

  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  // Track latest visibility so the animation loop can check it.
  const visibilityRef = useRef({ focused, visible });
  visibilityRef.current = { focused, visible };

  const start = () => {
    if (firedRef.current) return;
    firedRef.current = true;

    const end = Date.now() + durationMs;

    const frame = () => {
      // Hold off if the window is not visible or not focused.
      const { focused: f, visible: v } = visibilityRef.current;
      if (!f || !v) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      if (Date.now() > end) {
        rafRef.current = null;
        return;
      }

      confetti({
        particleCount: 2,
        angle: 60,
        spread: 55,
        startVelocity: 60,
        origin: { x: 0, y: 0.5 },
        colors,
        disableForReducedMotion: true,
      });
      confetti({
        particleCount: 2,
        angle: 120,
        spread: 55,
        startVelocity: 60,
        origin: { x: 1, y: 0.5 },
        colors,
        disableForReducedMotion: true,
      });

      rafRef.current = requestAnimationFrame(frame);
    };

    frame();
  };

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return { start };
}
