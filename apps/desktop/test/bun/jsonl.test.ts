import { describe, expect, it } from "vitest";
import { JsonlParser, serializeJsonl } from "../../src/bun/jsonl.js";

describe("JsonlParser", () => {
  it("splits on LF only", () => {
    const lines: string[] = [];
    const parser = new JsonlParser((line) => lines.push(line));
    parser.feed('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips CR before LF", () => {
    const lines: string[] = [];
    const parser = new JsonlParser((line) => lines.push(line));
    parser.feed('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("ignores empty lines", () => {
    const lines: string[] = [];
    const parser = new JsonlParser((line) => lines.push(line));
    parser.feed('{"a":1}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flushes trailing chunk", () => {
    const lines: string[] = [];
    const parser = new JsonlParser((line) => lines.push(line));
    parser.feed('{"a":1}\n{"b');
    parser.flush();
    expect(lines).toEqual(['{"a":1}', '{"b']);
  });

  it("handles partial JSON split across feeds", () => {
    const lines: string[] = [];
    const parser = new JsonlParser((line) => lines.push(line));
    parser.feed('{"a":');
    parser.feed('1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not split on U+2028 or U+2029", () => {
    const lines: string[] = [];
    const parser = new JsonlParser((line) => lines.push(line));
    parser.feed('{"text":"foo\u2028bar\u2029baz"}\n');
    expect(lines).toEqual(['{"text":"foo\u2028bar\u2029baz"}']);
  });
});

describe("serializeJsonl", () => {
  it("serializes with newline", () => {
    expect(serializeJsonl({ type: "get_state" })).toBe('{"type":"get_state"}\n');
  });
});
