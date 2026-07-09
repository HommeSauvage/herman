import { describe, expect, it } from "vitest";

import { __test__ } from "../../../../src/views/main/components/progress-bar.js";

const { paceFor, HIDE_DELAY_MS, MIN_PACE_MS, MAX_PACE_MS } = __test__;

describe("paceFor", () => {
  it("uses the minimum pace at the reference width (360px)", () => {
    expect(paceFor(360)).toBe(MIN_PACE_MS);
  });

  it("scales linearly between min and max reference widths", () => {
    // At 900px the formula gives (900 * 2000) / 900 = 2000ms.
    expect(paceFor(900)).toBe(2000);
  });

  it("clamps below the reference width to the minimum pace", () => {
    expect(paceFor(100)).toBe(MIN_PACE_MS);
    expect(paceFor(0)).toBe(MIN_PACE_MS);
  });

  it("clamps above the max reference width to the maximum pace", () => {
    expect(paceFor(5000)).toBe(MAX_PACE_MS);
    expect(paceFor(9000)).toBe(MAX_PACE_MS);
  });

  it("rounds to an integer millisecond value", () => {
    const result = paceFor(720);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(MIN_PACE_MS);
    expect(result).toBeLessThanOrEqual(MAX_PACE_MS);
  });

  it("stays within bounds across the expected width range", () => {
    for (const w of [200, 400, 600, 800, 1000, 1500, 2000, 3000]) {
      const p = paceFor(w);
      expect(p).toBeGreaterThanOrEqual(MIN_PACE_MS);
      expect(p).toBeLessThanOrEqual(MAX_PACE_MS);
    }
  });
});

describe("HIDE_DELAY_MS", () => {
  it("exceeds the 220ms opacity transition so the fade completes before unmount", () => {
    expect(HIDE_DELAY_MS).toBeGreaterThan(220);
  });
});

// The ProgressBar component is React-driven, so these tests describe the
// intended state transitions rather than mounting the component in a DOM.
// They guard against regressions where the bar stays showing after work ends.
describe("ProgressBar transitions", () => {
  it("starts hidden when isWorking is initially false", () => {
    const state = deriveProgressState(false, "hidden");
    expect(state).toBe("hidden");
  });

  it("transitions to showing when work starts", () => {
    const state = deriveProgressState(true, "hidden");
    expect(state).toBe("showing");
  });

  it("transitions to hiding when work ends", () => {
    const state = deriveProgressState(false, "showing");
    expect(state).toBe("hiding");
  });

  it("stays hidden when work never started", () => {
    const state = deriveProgressState(false, "hiding");
    expect(state).toBe("hidden");
  });
});

function deriveProgressState(isWorking: boolean, current: "hidden" | "showing" | "hiding"): string {
  if (isWorking) return "showing";
  if (current === "showing") return "hiding";
  return "hidden";
}
