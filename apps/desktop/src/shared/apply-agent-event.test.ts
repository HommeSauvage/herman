import { beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "./agent-protocol.js";
import {
  applyAgentEventToMessages,
  isAgentEndCurrent,
  resetMessageIdCounter,
} from "./apply-agent-event.js";
import type { Message } from "./rpc.js";

function applyAll(messages: Message[], events: AgentEvent[]): Message[] {
  return events.reduce(applyAgentEventToMessages, messages);
}

describe("applyAgentEventToMessages", () => {
  beforeEach(() => {
    resetMessageIdCounter();
  });

  it("appends a streaming assistant message on message_start", () => {
    const next = applyAgentEventToMessages([], {
      type: "message_start",
      message: { role: "assistant" },
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "msg-1",
      role: "assistant",
      content: "",
      isStreaming: true,
    });
  });

  it("ignores message_start for non-assistant roles", () => {
    const messages: Message[] = [{ id: "msg-1", role: "user", content: "hi" }];
    const next = applyAgentEventToMessages(messages, {
      type: "message_start",
      message: { role: "user" },
    });

    expect(next).toBe(messages);
  });

  it("updates the last assistant message even after tool messages", () => {
    const next = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "Hello" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
        },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: " world" },
        },
      ],
    );

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ role: "assistant", content: "Hello world" });
    expect(next[1]).toMatchObject({
      role: "tool",
      toolCallId: "tool-1",
      args: { command: "ls" },
    });
  });

  it("agent_end finalizes every streaming assistant message", () => {
    const next = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "first" },
        },
        { type: "message_end", message: {} },
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
        },
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "second" },
        },
        { type: "agent_end" },
      ],
    );

    expect(next).toHaveLength(3);
    expect(next[0]).toMatchObject({ role: "assistant", isStreaming: false });
    expect(next[2]).toMatchObject({
      role: "assistant",
      content: "second",
      isStreaming: false,
    });
  });

  it("agent_end finalizes the current turn even when the tab has prior history", () => {
    // Seed a tab with a prior user/assistant exchange.
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "old" },
        },
        { type: "message_end", message: {} },
      ],
    );

    // Start a new turn with a streaming assistant response.
    const withHistory = applyAll(messages, [
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "new" },
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant" }],
      },
    ]);

    expect(withHistory).toHaveLength(2);
    expect(withHistory[0]).toMatchObject({
      role: "assistant",
      content: "old",
      isStreaming: false,
    });
    expect(withHistory[1]).toMatchObject({
      role: "assistant",
      content: "new",
      isStreaming: false,
    });
  });

  it("agent_end ignores a stale event whose messages no longer match the tab suffix", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "old" },
        },
        { type: "message_end", message: {} },
      ],
    );

    const withHistory = applyAll(messages, [
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "new" },
      },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "ls" },
      },
      // Stale event from a previous turn: it claims the turn ended with an
      // assistant, but the tab has since moved on to a tool call.
      {
        type: "agent_end",
        messages: [{ role: "assistant" }],
      },
    ]);

    // The current assistant should stay streaming because the stale event did
    // not describe the current state of the tab.
    expect(withHistory).toHaveLength(3);
    expect(withHistory[1]).toMatchObject({
      role: "assistant",
      content: "new",
      isStreaming: true,
    });
    expect(withHistory[2]).toMatchObject({ role: "tool", status: "running" });
  });

  it("stores args on tool_execution_start", () => {
    const next = applyAgentEventToMessages([], {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
    });

    expect(next[0]).toMatchObject({
      role: "tool",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
      status: "running",
    });
  });

  it("skips intermediate updates for context tools", () => {
    const messages = applyAgentEventToMessages([], {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
    });

    const next = applyAgentEventToMessages(messages, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });

    expect(next).toBe(messages);
    expect(next[0]).not.toHaveProperty("output");
  });

  it("applies intermediate updates for non-context tools", () => {
    const messages = applyAgentEventToMessages([], {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const next = applyAgentEventToMessages(messages, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "ls" },
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    });

    expect(next[0]).toMatchObject({ output: "partial output" });
  });

  it("finalizes tool output on tool_execution_end", () => {
    const messages = applyAll(
      [],
      [
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
          partialResult: { content: [{ type: "text", text: "partial" }] },
        },
      ],
    );

    const next = applyAgentEventToMessages(messages, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "final output" }] },
      isError: false,
    });

    expect(next[0]).toMatchObject({
      status: "done",
      output: "final output",
    });
  });

  it("marks tool errors on tool_execution_end", () => {
    const messages = applyAgentEventToMessages([], {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const next = applyAgentEventToMessages(messages, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    });

    expect(next[0]).toMatchObject({ status: "error", output: "boom" });
  });

  it("returns the same messages reference for no-op events", () => {
    const messages: Message[] = [{ id: "msg-1", role: "user", content: "hi" }];
    const next = applyAgentEventToMessages(messages, { type: "agent_start" });
    expect(next).toBe(messages);
  });

  it("preserves the messages reference when agent_end finds nothing to finalize", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        },
        { type: "message_end", message: {} },
      ],
    );

    const next = applyAgentEventToMessages(messages, { type: "agent_end" });
    expect(next).toBe(messages);
  });

  it("preserves the messages reference when agent_complete finds nothing to finalize", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        },
        { type: "message_end", message: {} },
      ],
    );

    const next = applyAgentEventToMessages(messages, { type: "agent_complete" });
    expect(next).toBe(messages);
  });

  it("preserves the messages reference when message_end is already finalized", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        },
        { type: "message_end", message: {} },
      ],
    );

    const next = applyAgentEventToMessages(messages, { type: "message_end", message: {} });
    expect(next).toBe(messages);
  });

  it("captures stopReason and errorMessage on message_end", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        },
      ],
    );

    const next = applyAgentEventToMessages(messages, {
      type: "message_end",
      message: { stopReason: "error", errorMessage: "socket closed" },
    });

    expect(next[0]).toMatchObject({
      role: "assistant",
      isStreaming: false,
      stopReason: "error",
      errorMessage: "socket closed",
    });
  });

  it("preserves the messages reference when tool_execution_end makes no change", () => {
    const messages = applyAll(
      [],
      [
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "final output" }] },
          isError: false,
        },
      ],
    );

    const next = applyAgentEventToMessages(messages, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "final output" }] },
      isError: false,
    });
    expect(next).toBe(messages);
  });

  it("preserves the messages reference when tool_execution_update makes no change", () => {
    const messages = applyAll(
      [],
      [
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls" },
          partialResult: { content: [{ type: "text", text: "partial output" }] },
        },
      ],
    );

    const next = applyAgentEventToMessages(messages, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "ls" },
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    });
    expect(next).toBe(messages);
  });

  it("treats toolResult in agent_end messages as tool in the tab suffix", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "plan" },
        },
        { type: "message_end", message: {} },
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "read",
          args: { filePath: "/tmp/foo.ts" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "read",
          result: { content: [{ type: "text", text: "file content" }] },
          isError: false,
        },
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "answer" },
        },
      ],
    );

    const next = applyAgentEventToMessages(messages, {
      type: "agent_end",
      messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
    });

    expect(next).toHaveLength(3);
    expect(next[0]).toMatchObject({ role: "assistant", isStreaming: false });
    expect(next[1]).toMatchObject({ role: "tool", status: "done" });
    expect(next[2]).toMatchObject({
      role: "assistant",
      content: "answer",
      isStreaming: false,
    });
  });

  it("isAgentEndCurrent treats agent toolResult as tab tool", () => {
    const messages: Message[] = [
      { id: "msg-1", role: "assistant", content: "old", isStreaming: false },
      {
        id: "msg-2",
        role: "tool",
        toolName: "read",
        toolCallId: "t1",
        status: "done",
      },
      { id: "msg-3", role: "assistant", content: "new", isStreaming: true },
    ];

    const event = {
      type: "agent_end" as const,
      messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
    };

    expect(isAgentEndCurrent(event, messages)).toBe(true);
  });

  it("preserves the messages reference for an empty text_delta", () => {
    const messages = applyAll(
      [],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        },
      ],
    );

    const next = applyAgentEventToMessages(messages, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "" },
    });
    expect(next).toBe(messages);
  });
});
