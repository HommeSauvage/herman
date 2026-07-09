import { describe, expect, test } from "bun:test";

import { clampPercentage, formatCost, formatTokenCount } from "../../src/shared/context-stats.js";

describe("formatTokenCount", () => {
  test("uses raw numbers below 1k", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1)).toBe("1");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("uses k suffix between 1k and 1M", () => {
    expect(formatTokenCount(1_000)).toBe("1.0k");
    expect(formatTokenCount(1_234)).toBe("1.2k");
    expect(formatTokenCount(123_456)).toBe("123.5k");
    expect(formatTokenCount(999_999)).toBe("1000.0k");
  });

  test("uses M suffix at and above 1M", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});

describe("formatCost", () => {
  test("renders zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  test("uses 4-decimal precision below one cent", () => {
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(0.0042)).toBe("$0.0042");
  });

  test("uses 2-decimal precision at and above one cent", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(1.23)).toBe("$1.23");
    expect(formatCost(123.456)).toBe("$123.46");
  });
});

describe("clampPercentage", () => {
  test("clamps negatives to 0", () => {
    expect(clampPercentage(-0.5)).toBe(0);
  });

  test("clamps values >= 1 to 100", () => {
    expect(clampPercentage(1)).toBe(100);
    expect(clampPercentage(2.5)).toBe(100);
  });

  test("rounds mid-range values to the nearest integer percent", () => {
    expect(clampPercentage(0.123)).toBe(12);
    expect(clampPercentage(0.456)).toBe(46);
    expect(clampPercentage(0.005)).toBe(1);
  });
});
