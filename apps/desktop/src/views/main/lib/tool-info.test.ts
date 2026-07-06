import { describe, expect, it } from "vitest";

import { CONTEXT_TOOLS, getToolInfo, isContextTool } from "./tool-info.js";

describe("getToolInfo", () => {
  it("returns Read with the filename as subtitle", () => {
    const info = getToolInfo("read", { filePath: "/tmp/foo.ts" });
    expect(info.title).toBe("Read");
    expect(info.subtitle).toBe("foo.ts");
  });

  it("includes offset and limit chips for read", () => {
    const info = getToolInfo("read", { filePath: "/tmp/foo.ts", offset: 12, limit: 50 });
    expect(info.subtitle).toContain("foo.ts");
    expect(info.subtitle).toContain("offset=12");
    expect(info.subtitle).toContain("limit=50");
  });

  it("returns Edit with the filename", () => {
    const info = getToolInfo("edit", { filePath: "/x/bar.tsx" });
    expect(info.title).toBe("Edit");
    expect(info.subtitle).toBe("bar.tsx");
  });

  it("returns Write with the filename", () => {
    const info = getToolInfo("write", { filePath: "/x/baz.ts" });
    expect(info.title).toBe("Write");
    expect(info.subtitle).toBe("baz.ts");
  });

  it("returns Bash with the description as subtitle", () => {
    const info = getToolInfo("bash", { description: "List files", command: "ls" });
    expect(info.title).toBe("Bash");
    expect(info.subtitle).toBe("List files");
  });

  it("falls back to the command for Bash when no description is given", () => {
    const info = getToolInfo("bash", { command: "ls -la" });
    expect(info.subtitle).toBe("ls -la");
  });

  it("truncates very long bash commands to 80 characters", () => {
    const longCommand = "x".repeat(200);
    const info = getToolInfo("bash", { command: longCommand });
    expect(info.subtitle?.length).toBe(80);
  });

  it("returns Glob with the pattern", () => {
    const info = getToolInfo("glob", { pattern: "**/*.ts" });
    expect(info.title).toBe("Glob");
    expect(info.subtitle).toBe("**/*.ts");
  });

  it("returns Grep with the pattern", () => {
    const info = getToolInfo("grep", { pattern: "TODO" });
    expect(info.title).toBe("Grep");
    expect(info.subtitle).toBe("TODO");
  });

  it("returns List with the path", () => {
    const info = getToolInfo("list", { path: "/repo" });
    expect(info.title).toBe("List");
    expect(info.subtitle).toBe("/repo");
  });

  it("returns Web fetch with the URL", () => {
    const info = getToolInfo("webfetch", { url: "https://example.com" });
    expect(info.title).toBe("Web fetch");
    expect(info.subtitle).toBe("https://example.com");
  });

  it("returns Web search with the query", () => {
    const info = getToolInfo("websearch", { query: "react server components" });
    expect(info.title).toBe("Web search");
    expect(info.subtitle).toBe("react server components");
  });

  it("returns Task with the subagent type capitalized", () => {
    const info = getToolInfo("task", { subagent_type: "build", description: "Add login" });
    expect(info.title).toBe("Build");
    expect(info.subtitle).toBe("Add login");
  });

  it("returns Apply patch with the file count", () => {
    const info = getToolInfo("apply_patch", { files: ["a.ts", "b.ts", "c.ts"] });
    expect(info.title).toBe("Apply patch");
    expect(info.subtitle).toBe("3 files");
  });

  it("returns Apply patch singular for one file", () => {
    const info = getToolInfo("apply_patch", { files: ["only.ts"] });
    expect(info.subtitle).toBe("1 file");
  });

  it("returns a fallback for unknown tools using the tool name as title", () => {
    const info = getToolInfo("mystery_tool", { description: "What" });
    expect(info.title).toBe("mystery_tool");
    expect(info.subtitle).toBe("What");
  });

  it("tolerates undefined args", () => {
    const info = getToolInfo("read", undefined);
    expect(info.title).toBe("Read");
    expect(info.subtitle).toBeUndefined();
  });

  it("tolerates non-string string-coerced args", () => {
    const info = getToolInfo("read", { filePath: 42 });
    expect(info.subtitle).toBeUndefined();
  });
});

describe("isContextTool / CONTEXT_TOOLS", () => {
  it("includes the four context tools", () => {
    expect(CONTEXT_TOOLS.has("read")).toBe(true);
    expect(CONTEXT_TOOLS.has("glob")).toBe(true);
    expect(CONTEXT_TOOLS.has("grep")).toBe(true);
    expect(CONTEXT_TOOLS.has("list")).toBe(true);
  });

  it("excludes non-context tools", () => {
    expect(isContextTool("bash")).toBe(false);
    expect(isContextTool("edit")).toBe(false);
    expect(isContextTool("write")).toBe(false);
    expect(isContextTool("task")).toBe(false);
  });
});
