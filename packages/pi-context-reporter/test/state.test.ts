import { describe, expect, test } from "vitest";

import type { ContextReportUsage } from "../src/payload.js";
import { ContextState } from "../src/state.js";

function usage(partial: Partial<ContextReportUsage> = {}): ContextReportUsage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  const reasoning = partial.reasoning ?? 0;
  const totalTokens = partial.totalTokens ?? input + output + cacheRead + cacheWrite;
  const cost = partial.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens,
    cost,
  };
}

describe("ContextState", () => {
  test("starts with an empty snapshot", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    const snap = state.snapshot();
    expect(snap.context.contextWindow).toBe(200_000);
    expect(snap.context.tokens).toBeNull();
    expect(snap.context.percent).toBeNull();
    expect(snap.totals).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      cost: 0,
    });
    expect(snap.isCompacted).toBe(false);
    expect(snap.isStreaming).toBe(false);
    expect(snap.currentTurn).toBeUndefined();
    expect(snap.lastUsage).toBeUndefined();
  });

  test("setContextAnchor anchors the snapshot", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    const snap = state.snapshot();
    expect(snap.context.tokens).toBe(50_000);
    expect(snap.context.percent).toBe(25);
  });

  test("message_end accumulates totals but does not change the anchor", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.onMessageEnd(
      usage({
        input: 100,
        output: 50,
        cacheRead: 25,
        cost: { total: 0.01, input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0 },
      }),
      "m1",
    );
    state.onMessageEnd(
      usage({
        input: 200,
        output: 100,
        cacheRead: 50,
        cost: { total: 0.02, input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      }),
      "m2",
    );
    const snap = state.snapshot();
    // Anchor (50_000) is unchanged; currentTurn.output is the latest
    // usage.output (100), so the gauge shows 50_100.
    expect(snap.context.tokens).toBe(50_100);
    // Cumulative totals grow.
    expect(snap.totals.input).toBe(300);
    expect(snap.totals.output).toBe(150);
    expect(snap.totals.cacheRead).toBe(75);
    expect(snap.totals.cost).toBeCloseTo(0.03, 5);
    // lastUsage is the most recent one.
    expect(snap.lastUsage?.input).toBe(200);
    expect(snap.lastUsage?.output).toBe(100);
  });

  test("setContextAnchor(null) is a no-op", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.setContextAnchor(null);
    expect(state.snapshot().context.tokens).toBe(50_000);
  });

  test("session_compact makes context unknown until the next anchor", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    expect(state.snapshot().context.tokens).toBe(50_000);

    state.onSessionCompact();
    const snap = state.snapshot();
    expect(snap.isCompacted).toBe(true);
    expect(snap.context.tokens).toBeNull();
    expect(snap.context.percent).toBeNull();

    state.setContextAnchor(20_000);
    const after = state.snapshot();
    expect(after.isCompacted).toBe(false);
    expect(after.context.tokens).toBe(20_000);
  });

  test("streaming deltas accumulate into currentTurn.output and grow the gauge", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.onMessageUpdate(80); // 20 tokens
    state.onMessageUpdate(120); // +30 tokens
    state.onMessageUpdate(40); // +10 tokens
    const snap = state.snapshot();
    expect(snap.currentTurn?.output).toBe(60);
    // Gauge includes the in-flight turn's output.
    expect(snap.context.tokens).toBe(50_060);
  });

  test("message_end overwrites currentTurn.output with the real usage", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.onMessageUpdate(80);
    state.onMessageUpdate(120);
    state.onMessageEnd(usage({ input: 100, output: 42, totalTokens: 100 }), "m1");
    const snap = state.snapshot();
    expect(snap.currentTurn?.output).toBe(42);
    // Gauge now: anchor (50_000) + currentTurn (42) = 50_042
    expect(snap.context.tokens).toBe(50_042);
  });

  test("agent_start / agent_end toggle the streaming flag", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    expect(state.snapshot().isStreaming).toBe(false);
    state.onAgentStart();
    expect(state.snapshot().isStreaming).toBe(true);
    state.onAgentEnd();
    expect(state.snapshot().isStreaming).toBe(false);
    expect(state.snapshot().currentTurn).toBeUndefined();
  });

  test("snapshot is independent of subsequent mutations", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.onMessageEnd(
      usage({
        input: 100,
        output: 50,
        cacheRead: 25,
        cost: { total: 0.01, input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0 },
      }),
      "m1",
    );
    const snap = state.snapshot();
    // After the first message_end, tokens = anchor (50_000) + currentTurn (50) = 50_050.
    expect(snap.context.tokens).toBe(50_050);
    expect(snap.totals.input).toBe(100);
    state.onMessageEnd(usage({ input: 9999, output: 9999 }), "m2");
    // The first snapshot should not change.
    expect(snap.totals.input).toBe(100);
    expect(snap.context.tokens).toBe(50_050);
  });

  test("percent is null when contextWindow is zero", () => {
    const state = new ContextState();
    state.setModel("mystery-model", 0);
    state.setContextAnchor(100);
    const snap = state.snapshot();
    expect(snap.context.tokens).toBe(100);
    expect(snap.context.percent).toBeNull();
  });

  test("percent reflects the live tokens including in-flight turn output", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(100_000);
    state.onMessageUpdate(10_000); // 2500 tokens streamed
    const snap = state.snapshot();
    expect(snap.context.tokens).toBe(102_500);
    expect(snap.context.percent).toBeCloseTo(51.25, 1);
  });

  test("streaming deltas with no anchor leave tokens null", () => {
    // Edge case: streaming begins before any context event has fired
    // (shouldn't happen in practice, but defensive). The gauge should
    // show null rather than just the streaming estimate.
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.onMessageUpdate(80);
    expect(state.snapshot().context.tokens).toBeNull();
  });

  test("agent_end preserves the previous turn's output in the gauge", () => {
    // Regression: agent_end used to clear currentTurn, which made the
    // gauge drop by the just-produced output even though that output
    // is now part of the next call's input.
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.onMessageUpdate(80);
    state.onMessageEnd(usage({ input: 100, output: 30, totalTokens: 130 }), "m1");
    state.onAgentEnd();
    // Gauge should still reflect anchor + last usage.output (50_030).
    expect(state.snapshot().context.tokens).toBe(50_030);
    expect(state.snapshot().isStreaming).toBe(false);
  });

  test("setContextAnchor on the next turn clears the previous currentTurn", () => {
    // The new anchor already includes the previous assistant's output
    // (it's part of the message history). Drop currentTurn to avoid
    // double-counting.
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.setContextAnchor(50_000);
    state.onMessageEnd(usage({ input: 100, output: 30, totalTokens: 130 }), "m1");
    state.onAgentEnd();
    expect(state.snapshot().context.tokens).toBe(50_030);

    // Next turn's pre-LLM anchor (already includes the 30 tokens).
    state.setContextAnchor(60_000);
    expect(state.snapshot().context.tokens).toBe(60_000);
    expect(state.snapshot().currentTurn).toBeUndefined();
  });

  test("initFromBranch seeds totals from session entries", () => {
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.initFromBranch([
      { type: "message", message: { role: "user", content: "hello" } },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 500,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 600,
            cost: { input: 0.003, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.004 },
          },
        },
      },
      { type: "message", message: { role: "user", content: "more" } },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 300,
            output: 80,
            cacheRead: 100,
            cacheWrite: 50,
            reasoning: 20,
            totalTokens: 530,
            cost: {
              input: 0.002,
              output: 0.001,
              cacheRead: 0.001,
              cacheWrite: 0.001,
              total: 0.005,
            },
          },
        },
      },
      { type: "thinking_level_change", thinkingLevel: "medium" },
    ]);

    const snap = state.snapshot();
    expect(snap.totals.input).toBe(800); // 500 + 300
    expect(snap.totals.output).toBe(180); // 100 + 80
    expect(snap.totals.cacheRead).toBe(100);
    expect(snap.totals.cacheWrite).toBe(50);
    expect(snap.totals.reasoning).toBe(20);
    expect(snap.totals.cost).toBeCloseTo(0.009, 5); // 0.004 + 0.005
  });

  test("initFromBranch ignores entries without usage", () => {
    const state = new ContextState();
    state.initFromBranch([
      { type: "message", message: { role: "assistant", usage: undefined } },
      {
        type: "message",
        message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ]);
    const snap = state.snapshot();
    expect(snap.totals.input).toBe(100);
    expect(snap.totals.output).toBe(50);
  });

  test("initFromBranch is idempotent", () => {
    const state = new ContextState();
    state.initFromBranch([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        },
      },
    ]);
    // Second call is a no-op.
    state.initFromBranch([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0, cost: { total: 9999 } },
        },
      },
    ]);
    const snap = state.snapshot();
    expect(snap.totals.input).toBe(100);
    expect(snap.totals.cost).toBe(0.001);
  });

  test("initFromBranch + message_end combine correctly", () => {
    // Simulates a session resume followed by a live turn.
    const state = new ContextState();
    state.setModel("anthropic/claude-sonnet-4.6", 200_000);
    state.initFromBranch([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 500, output: 80, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
        },
      },
    ]);
    // Live turn adds more.
    state.onMessageEnd(
      usage({
        input: 300,
        output: 50,
        cacheRead: 10,
        cost: { total: 0.003, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      "live1",
    );
    const snap = state.snapshot();
    expect(snap.totals.input).toBe(800); // 500 + 300
    expect(snap.totals.output).toBe(130); // 80 + 50
    expect(snap.totals.cacheRead).toBe(10);
    expect(snap.totals.cost).toBeCloseTo(0.008, 5);
  });
});
