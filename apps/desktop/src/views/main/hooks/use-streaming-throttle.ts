import { useEffect, useRef, useState } from "react";

/** Render a new chunk every ~24ms (~41 fps). */
const TEXT_RENDER_PACE_MS = 24;

/** Jump straight to the current target when fewer than this many characters
 *  remain, so the tail of a response never lingers in pacing. */
const TEXT_RENDER_IMMEDIATE = 512;

/** Characters that are natural word/sentence boundaries.  The pacer snaps to
 *  the closest boundary past the desired step position to avoid mid-word cuts. */
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]>]/;

/**
 * Compute the next display length for one pacing step.
 * Returns the number of characters to show from the target text.
 *
 * - Adaptive step sizing (2–256 chars depending on remaining distance).
 * - Snaps to the nearest word boundary to avoid mid-word visual glitches.
 * - Jumps to the full target immediately when fewer than 512 chars remain.
 * - Guarantees monotonic: nextLength >= currentLength.
 *
 * Exported for testing.
 */
export function computePacingStep(
  currentLength: number,
  targetLength: number,
  immediateThreshold = TEXT_RENDER_IMMEDIATE,
  snapPattern = TEXT_RENDER_SNAP,
  targetText?: string,
): number {
  if (currentLength >= targetLength) return targetLength;
  const remaining = targetLength - currentLength;

  // Jump to end when we're close.
  if (remaining <= immediateThreshold) return targetLength;

  // Adaptive step size.
  const step =
    remaining <= 12
      ? 2
      : remaining <= 48
        ? 4
        : remaining <= 96
          ? 8
          : Math.min(Math.ceil(remaining / 4), 256);

  let nextLength = currentLength + step;

  // Snap to the nearest word boundary past the step point.
  if (targetText) {
    const snapSearch = targetText.slice(nextLength);
    const snapIndex = snapSearch.search(snapPattern);
    if (snapIndex !== -1 && snapIndex < 8) {
      nextLength += snapIndex + 1;
    }
  }

  return Math.min(nextLength, targetLength);
}

/**
 * Pace streaming text so the UI never re-renders on every high-frequency delta.
 *
 * - Renders at ~24ms intervals with adaptive step sizing (2–256 chars/step).
 * - Snaps to word boundaries to avoid mid-word visual glitches.
 * - Jumps to the current target immediately when fewer than 512 chars remain.
 * - Guarantees monotonic text length — displayed text never shrinks.
 * - Flushes the final text synchronously when streaming ends.
 *
 * Pattern inspired by OpenCode's `PacedMarkdown` (word-boundary pacing +
 * adaptive step sizing) combined with our existing monotonic-ref approach.
 */
export function useStreamingTextThrottle(text: string, isStreaming: boolean): string {
  const [display, setDisplay] = useState(text);
  const targetRef = useRef(text);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generationRef = useRef(0);

  // When streaming ends, flush the final text immediately.
  useEffect(() => {
    if (!isStreaming) {
      setDisplay(text);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    }
  }, [isStreaming, text]);

  // Pace incoming text during streaming.
  useEffect(() => {
    if (!isStreaming) return;

    targetRef.current = text;

    const gen = ++generationRef.current;
    let running = true;

    const doStep = () => {
      if (!running || gen !== generationRef.current) return;

      setDisplay((current) => {
        const target = targetRef.current;
        if (current.length >= target.length) return current;

        const nextLength = computePacingStep(
          current.length,
          target.length,
          TEXT_RENDER_IMMEDIATE,
          TEXT_RENDER_SNAP,
          target,
        );

        // Schedule next step if we're still behind and haven't been superseded.
        if (nextLength < target.length && gen === generationRef.current) {
          timerRef.current = setTimeout(doStep, TEXT_RENDER_PACE_MS);
        }

        return target.slice(0, nextLength);
      });
    };

    // Start the pacing loop.
    timerRef.current = setTimeout(doStep, TEXT_RENDER_PACE_MS);

    return () => {
      running = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [text, isStreaming]);

  return isStreaming ? display : text;
}
