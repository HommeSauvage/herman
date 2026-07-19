import { describe, expect, it } from "vitest";

import { computePacingStep } from "../../../../src/views/main/hooks/use-streaming-throttle.js";

describe("computePacingStep", () => {
  it("returns the target when current >= target (already caught up)", () => {
    expect(computePacingStep(10, 10)).toBe(10);
    expect(computePacingStep(15, 10)).toBe(10);
  });

  it("returns full target when remaining <= immediate threshold (512)", () => {
    // 600 total, already at 100 → 500 remaining → should jump to end
    expect(computePacingStep(100, 600)).toBe(600);

    // Already at 500, 12 remaining → jump to end
    expect(computePacingStep(500, 512)).toBe(512);
  });

  it("uses step size 2 when remaining <= 12", () => {
    // 800 total, at 792 (8 remaining) → but that's below 512 threshold so it jumps
    // Let's use a custom threshold to test step size isolation
    expect(computePacingStep(0, 10, 0)).toBe(2);
    expect(computePacingStep(2, 10, 0)).toBe(4);
    expect(computePacingStep(4, 10, 0)).toBe(6);
  });

  it("uses step size 4 when remaining <= 48", () => {
    expect(computePacingStep(0, 30, 0)).toBe(4);
    expect(computePacingStep(4, 30, 0)).toBe(8);
    expect(computePacingStep(8, 30, 0)).toBe(12);
  });

  it("uses step size 8 when remaining <= 96", () => {
    expect(computePacingStep(0, 80, 0)).toBe(8);
    expect(computePacingStep(8, 80, 0)).toBe(16);
  });

  it("uses ceil(remaining/4) capped at 256 for larger distances", () => {
    // 2000 chars, starting from 0, remaining 2000, step = min(ceil(2000/4), 256) = min(500, 256) = 256
    expect(computePacingStep(0, 2000, 0)).toBe(256);

    // 1000 chars, remaining 500, step = ceil(500/4) = 125
    expect(computePacingStep(500, 1000, 0)).toBe(625); // 500 + 125

    // Small: 200 chars, remaining 200, step = ceil(200/4) = 50
    expect(computePacingStep(0, 200, 0)).toBe(50);
    // From 50, remaining=150, step=ceil(150/4)=38 → 50+38=88
    expect(computePacingStep(50, 200, 0)).toBe(88);
  });

  it("snaps to word boundaries within 8 chars past the step point", () => {
    const text = "Hello world this is a test sentence for pacing.";
    // Step from 0: remaining=48, step=4, snaps to first boundary past position 4.
    // The displayed text should end at a word/sentence boundary.
    const next = computePacingStep(0, text.length, 0, /[\s.,!?;:)\]>]/, text);
    // Should end on a boundary character
    expect(/[\s.,!?;:)\]>]/.test(text[next - 1] ?? "")).toBe(true);
    // Should be past the step point (at least step=4 characters)
    expect(next).toBeGreaterThanOrEqual(4);
  });

  it("snaps to sentence-ending punctuation", () => {
    const text = "First sentence. Second sentence is here now.";
    // Start at 0, step should snap to a boundary
    const next = computePacingStep(0, text.length, 0, /[\s.,!?;:)\]>]/, text);
    expect(/[\s.,!?;:)\]>]/.test(text[next - 1] ?? "")).toBe(true);

    // Continue from halfway through, still snaps to boundaries
    const mid = Math.floor(text.length / 2);
    const next2 = computePacingStep(mid, text.length, 0, /[\s.,!?;:)\]>]/, text);
    expect(next2).toBeGreaterThan(mid);
    expect(/[\s.,!?;:)\]>]/.test(text[next2 - 1] ?? "")).toBe(true);
  });

  it("does not snap when no boundary exists within 8 chars", () => {
    const text = "abcdefghijklmnopqrstuvwxyz"; // no word boundaries
    // Use immediateThreshold=0 so we actually test step sizing for a small string
    const next = computePacingStep(0, text.length, 0, /[\s.,!?;:)\]>]/, text);
    // remaining=26, 26≤12?no, 26≤48?yes → step=4, no boundaries → next=4
    expect(next).toBe(4);
  });

  it("is monotonic: next >= current", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    let current = 0;
    const immediateThreshold = 400; // won't trigger for most steps
    for (let i = 0; i < 30; i++) {
      const next = computePacingStep(
        current,
        text.length,
        immediateThreshold,
        /[\s.,!?;:)\]>]/,
        text,
      );
      expect(next).toBeGreaterThanOrEqual(current);
      if (next >= text.length) break;
      current = next;
    }
  });

  it("eventually reaches the target when stepped repeatedly", () => {
    const text = "X".repeat(5000);
    let current = 0;
    // Simulate pacing to the end
    for (let i = 0; i < 100; i++) {
      current = computePacingStep(current, text.length);
      if (current >= text.length) break;
    }
    expect(current).toBe(text.length);
  });

  it("jumps to end at the immediate threshold boundary", () => {
    // At 4988 of 5000 → remaining 12, which is < 512 → jumps to end
    expect(computePacingStep(4988, 5000)).toBe(5000);

    // At 4488 of 5000 → remaining 512, which is <= 512 → jumps to end
    expect(computePacingStep(4488, 5000)).toBe(5000);

    // At 4487 of 5000 → remaining 513, which is > 512 → takes a step
    expect(computePacingStep(4487, 5000)).toBeLessThan(5000);
  });

  it("handles empty target", () => {
    expect(computePacingStep(0, 0)).toBe(0);
  });

  it("handles custom threshold", () => {
    // With threshold 10, at 40 of 50 chars → remaining 10 → jumps
    expect(computePacingStep(40, 50, 10)).toBe(50);

    // With threshold 10, at 39 of 50 → remaining 11 → takes a step
    expect(computePacingStep(39, 50, 10)).toBe(41); // step size 2 for 11 remaining
  });

  it("uses default snap pattern when targetText is not provided", () => {
    // Without targetText, no snapping — just step progression
    // remaining=50, 50≤12?no, 50≤48?no, 50≤96?yes → step=8
    expect(computePacingStep(0, 50, 0)).toBe(8);
    // remaining=42, 42≤12?no, 42≤48?yes → step=4 → 8+4=12
    expect(computePacingStep(8, 50, 0)).toBe(12);
    // remaining=34, 34≤12?no, 34≤48?yes → step=4 → 12+4=16
    expect(computePacingStep(12, 50, 0)).toBe(16);
  });
});
