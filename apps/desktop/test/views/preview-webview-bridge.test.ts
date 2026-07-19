import { describe, expect, it } from "bun:test";

import {
  PREVIEW_CONSOLE_PRELOAD,
  parsePreviewHostMessage,
  serializeConsoleArg,
} from "../../src/views/main/lib/preview-webview-bridge.js";

describe("parsePreviewHostMessage", () => {
  it("accepts a well-formed preview-console error message", () => {
    const result = parsePreviewHostMessage({
      type: "preview-console",
      level: "error",
      message: "Something broke",
      stack: "Error: Something broke\n  at foo.js:1:1",
    });
    expect(result).toEqual({
      type: "preview-console",
      level: "error",
      message: "Something broke",
      stack: "Error: Something broke\n  at foo.js:1:1",
    });
  });

  it("accepts a message with no stack", () => {
    const result = parsePreviewHostMessage({
      type: "preview-console",
      level: "error",
      message: "Something broke",
    });
    expect(result).toEqual({
      type: "preview-console",
      level: "error",
      message: "Something broke",
    });
    expect(result?.stack).toBeUndefined();
  });

  it("rejects non-object input", () => {
    expect(parsePreviewHostMessage(null)).toBeNull();
    expect(parsePreviewHostMessage(undefined)).toBeNull();
    expect(parsePreviewHostMessage("preview-console")).toBeNull();
    expect(parsePreviewHostMessage(42)).toBeNull();
  });

  it("rejects a wrong type discriminator", () => {
    expect(
      parsePreviewHostMessage({ type: "something-else", level: "error", message: "x" }),
    ).toBeNull();
  });

  it("accepts all five console levels", () => {
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "warn", message: "x" }),
    ).not.toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "info", message: "x" }),
    ).not.toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "log", message: "x" }),
    ).not.toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "debug", message: "x" }),
    ).not.toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: undefined, message: "x" }),
    ).toBeNull();
  });

  it("rejects a non-string message", () => {
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "error", message: 123 }),
    ).toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "error", message: null }),
    ).toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "error" }),
    ).toBeNull();
  });

  it("rejects an empty or whitespace-only message", () => {
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "error", message: "" }),
    ).toBeNull();
    expect(
      parsePreviewHostMessage({ type: "preview-console", level: "error", message: "   " }),
    ).toBeNull();
  });

  it("truncates an overlong message to 2000 chars", () => {
    const result = parsePreviewHostMessage({
      type: "preview-console",
      level: "error",
      message: "x".repeat(3000),
    });
    expect(result?.message.length).toBe(2000);
  });

  it("truncates an overlong stack to 2000 chars", () => {
    const result = parsePreviewHostMessage({
      type: "preview-console",
      level: "error",
      message: "boom",
      stack: "y".repeat(3000),
    });
    expect(result?.stack?.length).toBe(2000);
  });

  it("ignores a non-string stack", () => {
    const result = parsePreviewHostMessage({
      type: "preview-console",
      level: "error",
      message: "boom",
      stack: 123,
    });
    expect(result?.stack).toBeUndefined();
  });
});

describe("serializeConsoleArg", () => {
  it("passes strings through unchanged", () => {
    expect(serializeConsoleArg("hello")).toBe("hello");
  });

  it("serializes an Error to its stack (or message as fallback)", () => {
    const err = new Error("boom");
    expect(serializeConsoleArg(err)).toBe(err.stack);

    const errNoStack = new Error("boom2");
    // @ts-expect-error simulate an environment without stack traces
    errNoStack.stack = undefined;
    expect(serializeConsoleArg(errNoStack)).toBe("boom2");
  });

  it("serializes plain objects as JSON", () => {
    expect(serializeConsoleArg({ a: 1, b: "two" })).toBe(JSON.stringify({ a: 1, b: "two" }));
  });

  it("serializes functions, symbols, and bigints without throwing", () => {
    expect(serializeConsoleArg(function namedFn() {})).toBe("[Function: namedFn]");
    expect(serializeConsoleArg(Symbol("s"))).toBe("Symbol(s)");
    expect(serializeConsoleArg(10n)).toBe("10n");
  });

  it("serializes null and undefined", () => {
    expect(serializeConsoleArg(null)).toBe("null");
    expect(serializeConsoleArg(undefined)).toBe("undefined");
  });

  it("handles circular references without throwing", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = serializeConsoleArg(obj);
    expect(() => serializeConsoleArg(obj)).not.toThrow();
    expect(result).toContain("[Circular]");
  });

  it("handles deeply nested repeated (non-circular) references", () => {
    const shared = { value: 1 };
    const obj = { first: shared, second: shared };
    // Same object reachable via two different keys is not circular, so it
    // should serialize normally without being flagged as [Circular].
    const result = serializeConsoleArg(obj);
    expect(result).toBe(JSON.stringify(obj));
  });

  it("falls back gracefully when a getter throws", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    expect(() => serializeConsoleArg(hostile)).not.toThrow();
    expect(typeof serializeConsoleArg(hostile)).toBe("string");
  });

  it("falls back gracefully when toJSON throws", () => {
    const hostile = {
      toJSON() {
        throw new Error("toJSON boom");
      },
    };
    expect(() => serializeConsoleArg(hostile)).not.toThrow();
    expect(typeof serializeConsoleArg(hostile)).toBe("string");
  });
});

describe("PREVIEW_CONSOLE_PRELOAD", () => {
  it("embeds a self-contained serializeConsoleArg implementation", () => {
    expect(PREVIEW_CONSOLE_PRELOAD).toContain("var serializeArg");
    expect(PREVIEW_CONSOLE_PRELOAD).toContain("preview-console");
    expect(PREVIEW_CONSOLE_PRELOAD).toContain("__electrobunSendToHost");
  });

  it("is valid, self-executing JavaScript", () => {
    // Smoke-test that the stringified preload actually parses as JS. We
    // can't run it directly here (no `window`), but `new Function` will
    // throw a SyntaxError if the embedded serializeConsoleArg.toString()
    // produced anything malformed.
    expect(() => new Function(PREVIEW_CONSOLE_PRELOAD)).not.toThrow();
  });
});
