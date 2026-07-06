import { useEffect, useRef } from "react";

/**
 * Diagnostic hook: logs render frequency and optional stack traces.
 *
 * Adds zero runtime cost when `enabled` is false (the hook body is
 * still called but does nothing beyond ref reads).
 *
 * @param componentName - Label shown in console logs.
 * @param options.logInterval - Log every Nth render (default 1 = every render).
 * @param options.stackInterval - Log a stack trace every Nth render (default 0 = never).
 * @param options.enabled - Master switch (default true).
 */
export function useTrackRenders(
  componentName: string,
  options?: {
    logInterval?: number;
    stackInterval?: number;
    enabled?: boolean;
  },
) {
  const { logInterval = 1, stackInterval = 0, enabled = true } = options ?? {};
  const countRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    countRef.current++;
    const n = countRef.current;

    if (n % logInterval === 0) {
      console.log(`[render-track] ${componentName} #${n}`);
    }
    if (stackInterval > 0 && n % stackInterval === 0) {
      console.trace(`[render-track] ${componentName} #${n} — call stack:`);
    }
  });
}
