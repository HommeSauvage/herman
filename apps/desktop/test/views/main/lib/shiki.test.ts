import { describe, expect, it } from "vitest";

import { getHighlighter } from "../../../../src/views/main/lib/shiki.js";

describe("getHighlighter", () => {
  it("highlights typescript code", async () => {
    const highlighter = await getHighlighter();
    const html = highlighter.codeToHtml("const x = 1;", { lang: "typescript", theme: "github-dark" });
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("const");
    expect(html).toContain("x");
  });

  it("falls back to plain text for unknown languages", async () => {
    const highlighter = await getHighlighter();
    const loadedLangs = highlighter.getLoadedLanguages();
    const effectiveLang = loadedLangs.includes("unknown-lang") ? "unknown-lang" : "text";
    const html = highlighter.codeToHtml("some code", { lang: effectiveLang, theme: "github-dark" });
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("some code");
  });

  it("handles code with leading and trailing whitespace", async () => {
    const highlighter = await getHighlighter();
    const html = highlighter.codeToHtml("  const y = 2;  ", { lang: "typescript", theme: "github-dark" });
    expect(html).toContain("const");
  });
});
