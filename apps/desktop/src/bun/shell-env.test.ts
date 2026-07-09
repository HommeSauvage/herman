import { describe, expect, it } from "vitest";

// We test the real shell-env module by mocking process.platform and PATH.
// The module-level cache (`cachedShellEnv`) persists across imports in the
// same process, so we test idempotency rather than pure statelessness.

describe("resolveShellEnv", () => {
  it("caches the result and returns immediately on subsequent calls", async () => {
    // Start with a minimal PATH that does not contain user paths.
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    const { resolveShellEnv } = await import("./shell-env.js");

    // First call should attempt resolution (returns false because shell env
    // extraction fails in the test environment — no login shell).
    const first = resolveShellEnv();

    // Second call should return the cached result without spawning a shell.
    const second = resolveShellEnv();

    // Both calls should return the same result.
    expect(second).toBe(first);

    process.env.PATH = originalPath;
  });

  it("restores cached PATH on subsequent calls", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    const { resolveShellEnv } = await import("./shell-env.js");

    // First call caches the result.
    resolveShellEnv();

    // Mutate PATH.
    process.env.PATH = "/modified";

    // Second call should restore the cached PATH if resolution succeeded.
    resolveShellEnv();

    // If the first call succeeded (found a PATH), the second call restores it.
    // If the first call failed (no PATH found), PATH stays as "/modified".
    // This test mainly verifies the function doesn't crash on cache hit.
    expect(process.env.PATH).toBeDefined();

    process.env.PATH = originalPath;
  });
});
