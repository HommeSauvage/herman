import { describe, expect, test, vi } from "vitest";

import { createThrottledNotifier } from "./throttle.js";

describe("createThrottledNotifier", () => {
  test("coalesces multiple schedule() calls into a single emit", async () => {
    const notify = vi.fn();
    let payload = "v1";
    const notifier = createThrottledNotifier(notify, () => payload, 50);

    notifier.schedule();
    notifier.schedule();
    notifier.schedule();
    expect(notify).not.toHaveBeenCalled();

    payload = "v2";
    notifier.schedule();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("v2");
  });

  test("flush() emits immediately and cancels any pending debounce", async () => {
    const notify = vi.fn();
    let payload = "v1";
    const notifier = createThrottledNotifier(notify, () => payload, 50);

    notifier.schedule();
    payload = "v2";
    notifier.flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("v2");

    await new Promise((resolve) => setTimeout(resolve, 80));
    // No additional emit because the timer was cancelled.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("flush() always emits, even when nothing is pending", () => {
    const notify = vi.fn();
    const notifier = createThrottledNotifier(notify, () => "x", 50);
    notifier.flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("cancel() prevents a pending emit from firing", async () => {
    const notify = vi.fn();
    const notifier = createThrottledNotifier(notify, () => "x", 30);
    notifier.schedule();
    notifier.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notify).not.toHaveBeenCalled();
  });

  test("notifier can be rescheduled after a previous emit", async () => {
    const notify = vi.fn();
    const notifier = createThrottledNotifier(notify, () => "x", 20);
    notifier.schedule();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.schedule();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test("notifier swallows callback errors so the agent loop is not broken", async () => {
    const notify = vi.fn().mockImplementation(() => {
      throw new Error("ipc failure");
    });
    const onError = vi.fn();
    const notifier = createThrottledNotifier(notify, () => "x", 20, onError);
    notifier.schedule();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
