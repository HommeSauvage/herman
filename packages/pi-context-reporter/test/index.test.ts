import { describe, expect, test } from "vitest";

import contextReporterExtension from "../src/index.js";
import { CONTEXT_REPORT_EVENT, REPORT_THROTTLE_MS } from "../src/payload.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

type MockApi = {
  on: (event: string, handler: Handler) => void;
  _handlers: Map<string, Handler[]>;
  _emit: (event: string, payload: unknown, ctx: unknown) => Promise<void>;
};

function createMockApi() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async _emit(event: string, payload: unknown, ctx: unknown) {
      const list = handlers.get(event) ?? [];
      for (const handler of list) {
        await handler(payload, ctx);
      }
    },
    _handlers: handlers,
  };
}

function createMockContext(opts: {
  notify: (message: string) => void;
  model?: { provider: string; id: string; contextWindow?: number };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  branchEntries?: Array<{ type: string; message?: unknown }>;
}) {
  let currentModel = opts.model;
  return {
    ui: {
      notify: opts.notify,
    },
    get model() {
      return currentModel;
    },
    set model(next: typeof currentModel) {
      currentModel = next;
    },
    getContextUsage: () => opts.contextUsage,
    sessionManager: {
      getBranch: () => opts.branchEntries ?? [],
    },
  };
}

function parseReport(notification: string) {
  return JSON.parse(notification) as Record<string, unknown>;
}

/** Wait past the throttle window (REPORT_THROTTLE_MS) so any pending
 *  debounced emit fires. Uses real timers so the test works under both
 *  bun test and vitest. */
async function waitForThrottle() {
  await new Promise((resolve) => setTimeout(resolve, REPORT_THROTTLE_MS + 30));
}

describe("contextReporterExtension", () => {

  test("emits a baseline context_report on session_start with the model window", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);

    expect(notifications).toHaveLength(1);
    const report = parseReport(notifications[0]!);
    expect(report.type).toBe(CONTEXT_REPORT_EVENT);
    expect(report.schema).toBe(1);
    expect(report.modelKey).toBe("anthropic/claude-sonnet-4.6");
    expect((report.context as Record<string, unknown>).contextWindow).toBe(200_000);
  });

  test("seeds gauge tokens from getContextUsage on session_start", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.17 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);

    const report = parseReport(notifications[0]!);
    expect((report.context as Record<string, unknown>).tokens).toBe(12_345);
  });

  test("uses getContextUsage() from the context event as the anchor", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.17 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);
    notifications.length = 0;

    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);

    await waitForThrottle();
    const report = parseReport(notifications[notifications.length - 1]!);
    expect((report.context as Record<string, unknown>).tokens).toBe(12_345);
  });

  test("emits a context_report on agent_end with cumulative usage", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);
    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);
    await api._emit(
      "message_start",
      { message: { role: "assistant", id: "a1" } },
      ctx,
    );
    await api._emit(
      "message_end",
      {
        message: {
          role: "assistant",
          id: "a1",
          usage: {
            input: 1000,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1050,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
      ctx,
    );
    await api._emit("agent_end", {}, ctx);

    const last = parseReport(notifications[notifications.length - 1]!);
    expect((last.totals as Record<string, unknown>).input).toBe(1000);
    expect((last.totals as Record<string, unknown>).output).toBe(50);
    expect((last.isStreaming as boolean)).toBe(false);
    // The context snapshot must survive the agent_end: the anchor set
    // by the pre-LLM `context` event should still be the source of truth
    // for the gauge. We add the last `usage.input` to it (the gauge
    // shows what the NEXT call would see, and the assistant's output
    // is now part of that input). See: 'stats go to 0 at end of stream'
    // regression.
    expect((last.context as Record<string, unknown>).contextWindow).toBe(200_000);
    expect((last.context as Record<string, unknown>).tokens).toBe(10_050);
  });

  test("resets currentTurn when the next turn's context event fires", async () => {
    // After a turn ends, the next turn's pre-LLM `context` event fires
    // with a fresh anchor from getContextUsage(). The new anchor already
    // includes the previous assistant's output, so we must drop
    // currentTurn to avoid double-counting.
    const notifications: string[] = [];
    const api = createMockApi();
    // First turn: anchor 10_000. Second turn: anchor 15_000 (includes
    // the new assistant message).
    let usageRound = 0;
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
    }) as ReturnType<typeof createMockContext> & { getContextUsage: () => { tokens: number; contextWindow: number; percent: number } };
    ctx.getContextUsage = () => {
      usageRound++;
      if (usageRound === 1) return { tokens: 10_000, contextWindow: 200_000, percent: 5 };
      return { tokens: 15_000, contextWindow: 200_000, percent: 7.5 };
    };

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);

    // First turn.
    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);
    await api._emit("message_start", { message: { role: "assistant", id: "a1" } }, ctx);
    await api._emit("message_update", {
      message: { role: "assistant", id: "a1" },
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    }, ctx);
    await api._emit("message_end", {
      message: {
        role: "assistant",
        id: "a1",
        usage: {
          input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    }, ctx);
    await api._emit("agent_end", {}, ctx);

    // Second turn.
    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);
    // The second-turn context event is throttled (a `context` handler
    // calls `emit(ctx)` which schedules). Wait for the throttle window
    // to elapse so we read the right notification.
    await waitForThrottle();
    const last = parseReport(notifications[notifications.length - 1]!);
    // After the second `context` event, the gauge should be just the
    // new anchor (15_000), not anchor + stale last turn's output.
    expect((last.context as Record<string, unknown>).tokens).toBe(15_000);
  });

  test("throttles streaming updates but flushes on message_end", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 5_000, contextWindow: 200_000, percent: 2.5 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);
    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);
    await api._emit("message_start", { message: { role: "assistant", id: "a1" } }, ctx);

    // The session_start handler flushed a baseline; clear it so the
    // assertions below are about the streaming path only.
    notifications.length = 0;

    // 50 deltas — each should be debounced, not individually emitted.
    for (let i = 0; i < 50; i++) {
      await api._emit(
        "message_update",
        {
          message: { role: "assistant", id: "a1" },
          assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
        },
        ctx,
      );
    }
    expect(notifications).toHaveLength(0);

    // Advance past the throttle window — one emit fires with the
    // accumulated output estimate.
    await waitForThrottle();
    expect(notifications).toHaveLength(1);
    const intermediate = parseReport(notifications[0]!);
    expect((intermediate.context as Record<string, unknown>).tokens).toBeGreaterThan(5000);
    expect((intermediate.currentTurn as Record<string, unknown>).output).toBeGreaterThan(0);
    notifications.length = 0;

    // message_end flushes — final report carries the real usage.
    await api._emit(
      "message_end",
      {
        message: {
          role: "assistant",
          id: "a1",
          usage: {
            input: 500,
            output: 30,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 530,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
      ctx,
    );

    expect(notifications).toHaveLength(1);
    const final = parseReport(notifications[0]!);
    expect((final.totals as Record<string, unknown>).input).toBe(500);
    expect((final.totals as Record<string, unknown>).output).toBe(30);
  });

  test("session_compact makes context unknown and marks isCompacted", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);
    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);
    await api._emit(
      "message_end",
      {
        message: {
          role: "assistant",
          id: "a1",
          usage: {
            input: 1000,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1050,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
      ctx,
    );
    await api._emit("agent_end", {}, ctx);
    notifications.length = 0;

    await api._emit("session_compact", {}, ctx);
    const report = parseReport(notifications[notifications.length - 1]!);
    expect((report.context as Record<string, unknown>).tokens).toBeNull();
    expect((report.context as Record<string, unknown>).percent).toBeNull();
    expect(report.isCompacted).toBe(true);
  });

  test("model_select updates the modelKey and context window", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);
    notifications.length = 0;

    await api._emit(
      "model_select",
      {
        model: { provider: "anthropic", id: "claude-haiku-4.5", contextWindow: 100_000 },
        previousModel: undefined,
        source: "set",
      },
      ctx,
    );

    const report = parseReport(notifications[notifications.length - 1]!);
    expect(report.modelKey).toBe("anthropic/claude-haiku-4.5");
    expect((report.context as Record<string, unknown>).contextWindow).toBe(100_000);
  });

  test("session_shutdown cancels pending emits", async () => {
    const notifications: string[] = [];
    const api = createMockApi();
    const ctx = createMockContext({
      notify: (m) => notifications.push(m),
      model: { provider: "anthropic", id: "claude-sonnet-4.6", contextWindow: 200_000 },
      contextUsage: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
    });

    contextReporterExtension(api as never);
    await api._emit("session_start", {}, ctx);
    await api._emit("agent_start", {}, ctx);
    await api._emit("context", { messages: [] }, ctx);
    notifications.length = 0;

    await api._emit(
      "message_update",
      {
        message: { role: "assistant", id: "a1" },
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      },
      ctx,
    );
    expect(notifications).toHaveLength(0);

    await api._emit("session_shutdown", {}, ctx);
    await waitForThrottle();
    expect(notifications).toHaveLength(0);
  });
});
