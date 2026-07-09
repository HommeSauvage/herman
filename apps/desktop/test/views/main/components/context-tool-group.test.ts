import { describe, expect, it } from "vitest";

import type { Message } from "../../../../src/shared/rpc.js";
import { summarizeContextTools } from "../../../../src/views/main/components/context-tool-group.js";

function tool(name: string): Extract<Message, { role: "tool" }> {
  return {
    id: `tc-${name}-${Math.random()}`,
    role: "tool",
    toolName: name,
    toolCallId: `tc-${name}`,
    status: "done",
  };
}

describe("summarizeContextTools", () => {
  it("returns an empty string for no tools", () => {
    expect(summarizeContextTools([])).toBe("");
  });

  it("uses singular form for a single read", () => {
    expect(summarizeContextTools([tool("read")])).toBe("1 read");
  });

  it("uses plural form for multiple reads", () => {
    expect(summarizeContextTools([tool("read"), tool("read"), tool("read")])).toBe("3 reads");
  });

  it("uses singular form for a single search", () => {
    expect(summarizeContextTools([tool("grep")])).toBe("1 search");
  });

  it("uses singular form for a single list", () => {
    expect(summarizeContextTools([tool("list")])).toBe("1 list");
  });

  it("combines glob and grep into a single search count", () => {
    const result = summarizeContextTools([tool("grep"), tool("glob"), tool("glob")]);
    expect(result).toBe("3 searches");
  });

  it("produces a mixed summary in read · search · list order", () => {
    const result = summarizeContextTools([
      tool("read"),
      tool("read"),
      tool("read"),
      tool("read"),
      tool("read"),
      tool("grep"),
      tool("grep"),
      tool("list"),
    ]);
    expect(result).toBe("5 reads · 2 searches · 1 list");
  });

  it("omits zero-count categories", () => {
    const result = summarizeContextTools([tool("read"), tool("read"), tool("grep")]);
    expect(result).toBe("2 reads · 1 search");
  });

  it("ignores non-context tools (bash, edit, write)", () => {
    const result = summarizeContextTools([tool("read"), tool("bash"), tool("edit"), tool("write")]);
    expect(result).toBe("1 read");
  });
});
