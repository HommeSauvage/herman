import { describe, expect, it } from "bun:test";

import type { PendingAttachment } from "../../../shared/rpc.js";
import { formatAttachmentsForPrompt } from "./attachment-format.js";

function attachment(
  path: string,
  overrides: Partial<PendingAttachment> = {},
): PendingAttachment {
  return {
    path,
    name: path.split("/").pop() ?? path,
    size: 1024,
    mime: "text/plain",
    id: crypto.randomUUID(),
    addedAt: 0,
    ...overrides,
  };
}

describe("formatAttachmentsForPrompt", () => {
  it("returns the original text when no attachments are provided", () => {
    expect(formatAttachmentsForPrompt("hello", [])).toBe("hello");
  });

  it("returns only the attachment block when the user typed nothing", () => {
    const result = formatAttachmentsForPrompt("", [
      attachment("/a/b/foo.txt"),
    ]);
    expect(result).toBe("attachment 1: /a/b/foo.txt");
  });

  it("appends the attachment block below the user's text, separated by a blank line", () => {
    const result = formatAttachmentsForPrompt("explain these", [
      attachment("/a/b/foo.txt"),
    ]);
    expect(result).toBe("explain these\n\nattachment 1: /a/b/foo.txt");
  });

  it("numbers attachments starting at 1, in the order they were attached", () => {
    const result = formatAttachmentsForPrompt("see attached", [
      attachment("/first.txt"),
      attachment("/second.ts"),
      attachment("/third.png", { mime: "image/png" }),
    ]);
    expect(result).toBe(
      "see attached\n\n" +
        "attachment 1: /first.txt\n" +
        "attachment 2: /second.ts\n" +
        "attachment 3: /third.png",
    );
  });

  it("trims trailing whitespace from the user text before appending", () => {
    const result = formatAttachmentsForPrompt("  hi there   \n\n", [
      attachment("/a.txt"),
    ]);
    // Trim only the trailing edge so the blank-line separator we add
    // doesn't become three newlines.
    expect(result).toBe("  hi there\n\nattachment 1: /a.txt");
  });
});
