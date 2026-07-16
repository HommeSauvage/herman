import { describe, expect, it } from "bun:test";

import {
  buildUrlWithPath,
  formatOriginDisplay,
  getPathSuffix,
  isSameOrigin,
} from "../../src/views/main/lib/preview-url.js";

describe("preview-url", () => {
  const base = "http://localhost:3000/";

  it("formats origin for display", () => {
    expect(formatOriginDisplay(base)).toBe("localhost:3000");
  });

  it("extracts path suffix including search and hash", () => {
    expect(getPathSuffix("http://localhost:3000/about?x=1#top")).toBe("/about?x=1#top");
    expect(getPathSuffix("http://localhost:3000")).toBe("/");
  });

  it("builds full URL from base and path suffix", () => {
    expect(buildUrlWithPath(base, "/dashboard")).toBe("http://localhost:3000/dashboard");
    expect(buildUrlWithPath(base, "settings")).toBe("http://localhost:3000/settings");
  });

  it("checks same origin", () => {
    expect(isSameOrigin(base, "http://localhost:3000/other")).toBe(true);
    expect(isSameOrigin(base, "http://localhost:4000/other")).toBe(false);
  });
});
