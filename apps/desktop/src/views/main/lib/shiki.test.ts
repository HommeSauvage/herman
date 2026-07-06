import { describe, expect, it } from "vitest";

import { highlightCode } from "./shiki.js";

describe("highlightCode", () => {
  it("highlights typescript code", async () => {
    const html = await highlightCode("const x = 1;", "ts");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("const");
    expect(html).toContain("x");
  });

  it("falls back to plain text for unknown languages", async () => {
    const html = await highlightCode("some code", "unknown-lang");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("some code");
  });

  it("handles code with leading and trailing whitespace", async () => {
    const html = await highlightCode("  const y = 2;  ", "ts");
    expect(html).toContain("const");
  });
});
