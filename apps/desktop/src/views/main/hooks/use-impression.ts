import { useEffect, useRef } from "react";

const IMPRESSION_GATE_MS = 1000;

export type ImpressionState = {
  elapsedMs: number;
  visibleMs: number;
};

/**
 * Per-appearance impression tracking with a continuous 1s visibility gate.
 *
 * An impression counts when:
 * 1. The element is rendered in the DOM (tracked by the caller mounting the ref)
 * 2. At least 50% of pixels are in the viewport (IntersectionObserver, threshold: 0.5)
 * 3. Visibility is continuous for at least 1 second — the IntersectionObserver
 *    resets the counter on every exit and starts fresh on every enter.
 * 4. The caller is responsible for ensuring the app window is focused/visible
 *    (pass `enabled` based on those conditions)
 * 5. The impression hasn't already been reported (handled by `reportedRef` internally)
 */
export function useImpression({
  enabled,
  onImpression,
}: {
  enabled: boolean;
  onImpression: (state: ImpressionState) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reportedRef = useRef(false);
  const startTimeRef = useRef<number | null>(null);
  const visibleStartRef = useRef<number | null>(null);
  const isIntersectingRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      reportedRef.current = false;
      startTimeRef.current = null;
      visibleStartRef.current = null;
      return;
    }

    startTimeRef.current = Date.now();

    if (isIntersectingRef.current && visibleStartRef.current === null) {
      visibleStartRef.current = startTimeRef.current;
    }

    const interval = setInterval(() => {
      if (reportedRef.current || !startTimeRef.current) return;
      if (visibleStartRef.current === null) return;

      const now = Date.now();
      const visibleMs = now - visibleStartRef.current;
      const elapsedMs = now - startTimeRef.current;

      if (visibleMs >= IMPRESSION_GATE_MS) {
        reportedRef.current = true;
        onImpression({ elapsedMs, visibleMs });
      }
    }, 100);

    return () => clearInterval(interval);
  }, [enabled, onImpression]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const now = Date.now();
        isIntersectingRef.current = entry.isIntersecting;

        if (
          entry.isIntersecting &&
          visibleStartRef.current === null &&
          startTimeRef.current !== null
        ) {
          visibleStartRef.current = now;
        } else if (!entry.isIntersecting && visibleStartRef.current !== null) {
          visibleStartRef.current = null;
        }
      },
      { threshold: 0.5 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref };
}
