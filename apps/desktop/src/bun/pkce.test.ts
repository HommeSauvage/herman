import { describe, expect, it } from "vitest";

import { generatePKCE } from "./pkce.js";

describe("generatePKCE", () => {
  it("generates a verifier and challenge", async () => {
    const { verifier, challenge } = await generatePKCE();

    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThan(0);
    expect(challenge.length).toBeGreaterThan(0);
  });

  it("produces different values for each call", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();

    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
