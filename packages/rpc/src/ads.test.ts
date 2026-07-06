import { describe, expect, it } from "vitest";

import { isAdPlacement } from "./ads.js";

describe("isAdPlacement", () => {
  it("accepts all known placements", () => {
    expect(isAdPlacement("thinking_banner")).toBe(true);
    expect(isAdPlacement("sidebar")).toBe(true);
    expect(isAdPlacement("native")).toBe(true);
  });

  it("rejects unknown placements", () => {
    expect(isAdPlacement("header")).toBe(false);
    expect(isAdPlacement("interstitial")).toBe(false);
    expect(isAdPlacement(123)).toBe(false);
    expect(isAdPlacement(null)).toBe(false);
    expect(isAdPlacement(undefined)).toBe(false);
  });
});
