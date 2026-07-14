import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import {
  extractMessagesFromAgentPayload,
  normalizeContentText,
  normalizePiMessage,
} from "../../src/bun/pi-messages.js";
import { mergeAgentSettings } from "../../src/bun/agent-config-sync.js";
import { hasPiSessionFile, readPiSessionFilePath, resolvePiSessionFile, resolvePiSessionResumeArg } from "../../src/bun/pi-session.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-pi-session-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

/** Shared flat sessions dir under the test app dir: {tempDir}/agent/sessions */
function sharedSessionsDir(): string {
  return join(tempDir, "agent", "sessions");
}

describe("resolvePiSessionResumeArg", () => {
  it("returns the newest session file when no piSessionId is provided", () => {
    const agentDir = join(tempDir, "agent");
    const sessionsDir = join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "2026-07-08T00-00-00-000Z_old.jsonl"), "{}");
    writeFileSync(join(sessionsDir, "2026-07-09T00-00-00-000Z_new.jsonl"), "{}");

    expect(resolvePiSessionResumeArg(agentDir)).toBe(
      join(sessionsDir, "2026-07-09T00-00-00-000Z_new.jsonl"),
    );
  });

  it("prefers a file matching the persisted piSessionId", () => {
    const agentDir = join(tempDir, "agent");
    const sessionsDir = join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const target = join(sessionsDir, "2026-07-09T00-00-00-000Z_abc-123.jsonl");
    writeFileSync(target, "{}");

    expect(resolvePiSessionResumeArg(agentDir, "abc-123")).toBe(target);
  });
});

describe("resolvePiSessionFile", () => {
  it("prefers persisted piSessionId over a newer empty session file", () => {
    const sessionsDir = sharedSessionsDir();
    mkdirSync(sessionsDir, { recursive: true });
    const older = join(sessionsDir, "2026-07-08T00-00-00-000Z_abc-123.jsonl");
    const newer = join(sessionsDir, "2026-07-09T00-00-00-000Z_empty-new.jsonl");
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");

    expect(resolvePiSessionFile("abc-123")).toBe(older);
    expect(readPiSessionFilePath("abc-123")).toBe(older);
  });
});

describe("readPiSessionFilePath", () => {
  it("returns undefined when no session files exist", () => {
    expect(readPiSessionFilePath()).toBeUndefined();
    expect(hasPiSessionFile()).toBe(false);
  });

  it("returns the newest session file", () => {
    const sessionsDir = sharedSessionsDir();
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "2026-07-08T00-00-00-000Z_old.jsonl"), "{}");
    const newest = join(sessionsDir, "2026-07-09T00-00-00-000Z_new.jsonl");
    writeFileSync(newest, "{}");

    expect(readPiSessionFilePath()).toBe(newest);
    expect(hasPiSessionFile()).toBe(true);
  });
});

describe("normalizePiMessage", () => {
  it("extracts visible text from assistant content blocks", () => {
    const message = normalizePiMessage({
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "Visible answer" },
      ],
      stopReason: "stop",
    });

    expect(message).toMatchObject({
      id: "a1",
      role: "assistant",
      content: "Visible answer",
      stopReason: "stop",
    });
  });

  it("combines multiple text blocks into one string", () => {
    const message = normalizePiMessage({
      id: "a2",
      role: "assistant",
      content: [
        { type: "text", text: "First " },
        { type: "text", text: "second" },
      ],
      stopReason: "stop",
    });
    expect(message.content).toBe("First second");
  });

  it("returns empty content for non-text messages", () => {
    const message = normalizePiMessage({
      id: "u1",
      role: "user",
      content: "raw string",
    });
    expect(message.content).toBe("raw string");
  });
});

describe("normalizeContentText", () => {
  it("handles string content", () => {
    expect(normalizeContentText("hello")).toBe("hello");
  });

  it("joins text parts from content arrays", () => {
    expect(
      normalizeContentText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });
});

describe("extractMessagesFromAgentPayload", () => {
  it("returns undefined for payloads without a messages array", () => {
    expect(extractMessagesFromAgentPayload({})).toBeUndefined();
  });
});

describe("mergeAgentSettings", () => {
  it("preserves existing packages and theme while updating skills", () => {
    expect(
      mergeAgentSettings({ packages: ["@bacnh85/pi-fff"], theme: "dark" }, ["/skills"]),
    ).toEqual({
      packages: ["@bacnh85/pi-fff"],
      theme: "dark",
      skills: ["/skills"],
    });
  });

  it("preserves user-managed extension paths", () => {
    expect(
      mergeAgentSettings({ extensions: ["/some/user/ext"], theme: "dark" }, ["/skills"]),
    ).toEqual({
      extensions: ["/some/user/ext"],
      theme: "dark",
      skills: ["/skills"],
    });
  });
});
