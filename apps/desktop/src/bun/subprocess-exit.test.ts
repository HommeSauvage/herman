import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForSubprocessExit } from "./subprocess-exit.js";

describe("waitForSubprocessExit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when the process exits before the timeout", async () => {
    await expect(waitForSubprocessExit(Promise.resolve(0), 3_000)).resolves.toBe(true);
  });

  it("returns false when the timeout fires first", async () => {
    const neverExits = new Promise<number>(() => {});
    const waiting = waitForSubprocessExit(neverExits, 2_000);

    vi.advanceTimersByTime(2_000);
    await expect(waiting).resolves.toBe(false);
  });

  it("does not wait longer than the timeout when exit never resolves", async () => {
    const neverExits = new Promise<number>(() => {});
    const waiting = waitForSubprocessExit(neverExits, 500);

    vi.advanceTimersByTime(500);
    await expect(waiting).resolves.toBe(false);

    vi.advanceTimersByTime(10_000);
    await expect(waiting).resolves.toBe(false);
  });
});
