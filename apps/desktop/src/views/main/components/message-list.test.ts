import { describe, expect, it } from "vitest";

import type { Message } from "../../../shared/rpc.js";
import { buildRenderItems } from "../lib/render-items.js";

function userMsg(id: string, content: string): Message {
  return { id, role: "user", content };
}

function asstMsg(id: string, content: string): Message {
  return { id, role: "assistant", content };
}

function toolMsg(id: string, name: string, status: "running" | "done" = "done"): Message {
  return { id, role: "tool", toolName: name, toolCallId: `tc-${id}`, status };
}

describe("buildRenderItems", () => {
  it("returns an empty array for empty messages", () => {
    expect(buildRenderItems([])).toEqual([]);
  });

  it("returns a single message for a single non-tool message", () => {
    const items = buildRenderItems([userMsg("u1", "Hello")]);
    expect(items).toEqual([
      { type: "message", key: "u1", message: { id: "u1", role: "user", content: "Hello" } },
    ]);
  });

  it("does not group a single context tool", () => {
    const items = buildRenderItems([toolMsg("t1", "read")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      type: "message",
      key: "t1",
      message: expect.objectContaining({ role: "tool", toolName: "read" }),
    });
  });

  it("groups consecutive read tools into a single context group", () => {
    const items = buildRenderItems([
      toolMsg("t1", "read"),
      toolMsg("t2", "read"),
      toolMsg("t3", "read"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("context-group");
    if (items[0]?.type === "context-group") {
      expect(items[0].tools).toHaveLength(3);
      expect(items[0].key).toBe("t1:t3");
    }
  });

  it("groups a mix of context tools (read, glob, grep, list)", () => {
    const items = buildRenderItems([
      toolMsg("t1", "read"),
      toolMsg("t2", "glob"),
      toolMsg("t3", "grep"),
      toolMsg("t4", "list"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("context-group");
  });

  it("breaks the group when a non-context tool appears", () => {
    const items = buildRenderItems([
      toolMsg("t1", "read"),
      toolMsg("t2", "read"),
      toolMsg("t3", "bash"),
      toolMsg("t4", "read"),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]?.type).toBe("context-group");
    expect(items[1]).toEqual({
      type: "message",
      key: "t3",
      message: expect.objectContaining({ toolName: "bash" }),
    });
    expect(items[2]).toEqual({
      type: "message",
      key: "t4",
      message: expect.objectContaining({ toolName: "read" }),
    });
  });

  it("breaks the group when a user or assistant message appears", () => {
    const items = buildRenderItems([
      toolMsg("t1", "read"),
      toolMsg("t2", "read"),
      userMsg("u1", "Continue"),
      toolMsg("t3", "read"),
      toolMsg("t4", "read"),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]?.type).toBe("context-group");
    if (items[0]?.type === "context-group") {
      expect(items[0].tools.map((t) => t.id)).toEqual(["t1", "t2"]);
    }
    expect(items[1]).toEqual({
      type: "message",
      key: "u1",
      message: expect.objectContaining({ role: "user" }),
    });
    expect(items[2]?.type).toBe("context-group");
    if (items[2]?.type === "context-group") {
      expect(items[2].tools.map((t) => t.id)).toEqual(["t3", "t4"]);
    }
  });

  it("keeps streaming assistant content stable across deltas (stable key)", () => {
    // Simulate four streamed deltas of the same assistant message.
    const items1 = buildRenderItems([asstMsg("a1", "H")]);
    const items2 = buildRenderItems([asstMsg("a1", "He")]);
    const items3 = buildRenderItems([asstMsg("a1", "Hel")]);
    const items4 = buildRenderItems([asstMsg("a1", "Hello")]);
    expect(items1[0]?.key).toBe("a1");
    expect(items2[0]?.key).toBe("a1");
    expect(items3[0]?.key).toBe("a1");
    expect(items4[0]?.key).toBe("a1");
  });

  it("produces keys from message.id, not from content or index", () => {
    const items = buildRenderItems([
      userMsg("u-uuid-1", "First"),
      asstMsg("a-uuid-1", "Reply one"),
      toolMsg("t-uuid-1", "read"),
    ]);
    expect(items.map((i) => i.key)).toEqual(["u-uuid-1", "a-uuid-1", "t-uuid-1"]);
  });

  it("handles a non-context tool followed by context tools (no group for the first)", () => {
    const items = buildRenderItems([
      toolMsg("t1", "bash"),
      toolMsg("t2", "read"),
      toolMsg("t3", "read"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      type: "message",
      key: "t1",
      message: expect.objectContaining({ toolName: "bash" }),
    });
    expect(items[1]?.type).toBe("context-group");
  });
});
