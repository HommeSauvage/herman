import { describe, expect, test } from "bun:test";

import {
  computeContextStats,
  DEFAULT_CONTEXT_LIMIT,
  estimateSessionTokens,
  estimateTextTokens,
  formatCost,
  formatTokenCount,
} from "./context-stats.js";
import type { Message, Usage } from "./rpc.js";

function usage(partial: Partial<Usage> = {}): Usage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  const reasoning = partial.reasoning ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens:
      partial.totalTokens ?? input + output + cacheRead + cacheWrite + reasoning,
    cost: partial.cost,
  };
}

function assistantMessage(content: string, u?: Usage): Message {
  return {
    id: "a",
    role: "assistant",
    content,
    usage: u,
  };
}

function userMessage(content: string): Message {
  return { id: "u", role: "user", content };
}

function toolMessage(output: string): Message {
  return {
    id: "t",
    role: "tool",
    toolName: "bash",
    toolCallId: "tc-1",
    status: "done",
    output,
  };
}

describe("estimateTextTokens", () => {
  test("rounds up by chars/4", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abc")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });
});

describe("estimateSessionTokens", () => {
  test("estimates user and tool messages when no assistant usage exists", () => {
    const messages: Message[] = [
      userMessage("hello"), // 2
      assistantMessage("hi"), // 1
      toolMessage("output"), // 2
    ];
    expect(estimateSessionTokens(messages)).toBe(5);
  });

  test("uses the latest assistant usage as the base", () => {
    const messages: Message[] = [
      userMessage("hello"), // 2
      assistantMessage("first", usage({ input: 10, output: 5, totalTokens: 15 })), // 15
      userMessage("world"), // 2
      assistantMessage("second", usage({ input: 20, output: 10, totalTokens: 30 })), // 30
      userMessage("again"), // 2
    ];
    expect(estimateSessionTokens(messages)).toBe(32);
  });

  test("falls back to estimating assistant content when usage is empty", () => {
    const messages: Message[] = [
      assistantMessage("first", usage({ totalTokens: 0 })),
      userMessage("hello"),
    ];
    expect(estimateSessionTokens(messages)).toBe(
      estimateTextTokens("first") + estimateTextTokens("hello"),
    );
  });
});

describe("computeContextStats", () => {
  test("returns zero stats for empty messages", () => {
    const stats = computeContextStats([], "gpt-4o", "openai");
    expect(stats.totalTokens).toBe(0);
    expect(stats.contextLimit).toBe(128_000);
    expect(stats.messageCount).toBe(0);
  });

  test("infers context limit from known model", () => {
    expect(computeContextStats([], "claude-3-5-sonnet", "anthropic").contextLimit).toBe(
      200_000,
    );
    expect(computeContextStats([], "gemini-1.5-pro", "google").contextLimit).toBe(
      2_000_000,
    );
  });

  test("aggregates usage from latest assistant message", () => {
    const messages: Message[] = [
      userMessage("hello"),
      assistantMessage("first", usage({ input: 10, output: 5, totalTokens: 15 })),
      userMessage("world"),
      assistantMessage(
        "second",
        usage({
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          reasoning: 20,
          totalTokens: 185,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0033,
          },
        }),
      ),
    ];
    const stats = computeContextStats(messages, "gpt-4o", "openai");
    expect(stats.totalTokens).toBe(185);
    expect(stats.inputTokens).toBe(100);
    expect(stats.outputTokens).toBe(50);
    expect(stats.cacheReadTokens).toBe(10);
    expect(stats.cacheWriteTokens).toBe(5);
    expect(stats.reasoningTokens).toBe(20);
    expect(stats.estimatedCost).toBe(0.0033);
    expect(stats.userMessageCount).toBe(2);
    expect(stats.assistantMessageCount).toBe(2);
  });

  test("estimates messages after the latest authoritative usage", () => {
    const messages: Message[] = [
      assistantMessage("done", usage({ input: 10, output: 5, totalTokens: 15 })),
      userMessage("hello"),
      assistantMessage("streaming", usage({ input: 0, output: 0, totalTokens: 0 })),
      toolMessage("result"),
    ];
    const stats = computeContextStats(messages);
    expect(stats.totalTokens).toBe(
      15 + estimateTextTokens("hello") + estimateTextTokens("streaming") + estimateTextTokens("result"),
    );
  });
});

describe("formatTokenCount", () => {
  test("formats compactly", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatCost", () => {
  test("formats cost compactly", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.001)).toBe("$0.0010");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("explicit context limit", () => {
  test("uses provided limit over inference", () => {
    const stats = computeContextStats([], "unknown", "unknown", 256_000);
    expect(stats.contextLimit).toBe(256_000);
  });

  test("falls back to known Herman model limits", () => {
    expect(computeContextStats([], "kimi-k2.7-code").contextLimit).toBe(256_000);
    expect(computeContextStats([], "deepseek-v4-flash").contextLimit).toBe(1_000_000);
    expect(computeContextStats([], "glm-5.2").contextLimit).toBe(1_000_000);
    expect(computeContextStats([], "minimax-m3").contextLimit).toBe(1_000_000);
    expect(computeContextStats([], "mimo-v2.5-pro").contextLimit).toBe(1_000_000);
    expect(computeContextStats([], "qwen3.7-max").contextLimit).toBe(1_000_000);
  });

  test("prefers the most specific model match", () => {
    expect(computeContextStats([], "gpt-5.4-mini").contextLimit).toBe(400_000);
    expect(computeContextStats([], "gpt-5.4-nano").contextLimit).toBe(128_000);
    expect(computeContextStats([], "gpt-5.4").contextLimit).toBe(1_050_000);
  });

  test("falls back to known frontier model limits", () => {
    expect(computeContextStats([], "gpt-5.5").contextLimit).toBe(1_050_000);
    expect(computeContextStats([], "claude-opus-4.8").contextLimit).toBe(1_000_000);
    expect(computeContextStats([], "claude-sonnet-4.5").contextLimit).toBe(200_000);
    expect(computeContextStats([], "claude-haiku-4.5").contextLimit).toBe(200_000);
    expect(computeContextStats([], "gemini-3.1-pro").contextLimit).toBe(1_000_000);
  });
});
