import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { hasPiSessionFile, readPiSessionFilePath, resolvePiSessionFile, resolvePiSessionResumeArg } from "../../src/bun/pi-session.js";
import { mergeAgentSettings } from "../../src/bun/agent-bridge.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-pi-session-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

describe("resolvePiSessionResumeArg", () => {
  it("returns the newest session file when no piSessionId is provided", () => {
    const agentDir = join(tempDir, "agent-configs", "tab-1");
    const sessionsDir = join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "2026-07-08T00-00-00-000Z_old.jsonl"), "{}");
    writeFileSync(join(sessionsDir, "2026-07-09T00-00-00-000Z_new.jsonl"), "{}");

    expect(resolvePiSessionResumeArg(agentDir)).toBe(
      join(sessionsDir, "2026-07-09T00-00-00-000Z_new.jsonl"),
    );
  });

  it("prefers a file matching the persisted piSessionId", () => {
    const agentDir = join(tempDir, "agent-configs", "tab-2");
    const sessionsDir = join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const target = join(sessionsDir, "2026-07-09T00-00-00-000Z_abc-123.jsonl");
    writeFileSync(target, "{}");

    expect(resolvePiSessionResumeArg(agentDir, "abc-123")).toBe(target);
  });
});

describe("resolvePiSessionFile", () => {
  it("prefers persisted piSessionId over a newer empty session file", () => {
    const tabId = "tab-persisted";
    const sessionsDir = join(tempDir, "agent-configs", tabId, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const older = join(sessionsDir, "2026-07-08T00-00-00-000Z_abc-123.jsonl");
    const newer = join(sessionsDir, "2026-07-09T00-00-00-000Z_empty-new.jsonl");
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");

    expect(resolvePiSessionFile(tabId, "abc-123")).toBe(older);
    expect(readPiSessionFilePath(tabId, "abc-123")).toBe(older);
  });
});

describe("readPiSessionFilePath", () => {
  it("returns undefined when no session files exist", () => {
    expect(readPiSessionFilePath("missing-tab")).toBeUndefined();
    expect(hasPiSessionFile("missing-tab")).toBe(false);
  });

  it("returns the newest session file for a tab", () => {
    const tabId = "tab-3";
    const sessionsDir = join(tempDir, "agent-configs", tabId, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "2026-07-08T00-00-00-000Z_old.jsonl"), "{}");
    const newest = join(sessionsDir, "2026-07-09T00-00-00-000Z_new.jsonl");
    writeFileSync(newest, "{}");

    expect(readPiSessionFilePath(tabId)).toBe(newest);
    expect(hasPiSessionFile(tabId)).toBe(true);
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

  it("extracts messages from get_messages payloads", () => {
    const messages = extractMessagesFromAgentPayload({
      messages: [{ id: "u1", role: "user", content: "hello" }],
    });

    expect(messages).toEqual([{ id: "u1", role: "user", content: "hello" }]);
  });
});

describe("normalizeContentText", () => {
  it("skips thinking blocks and keeps text blocks", () => {
    expect(
      normalizeContentText([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "shown" },
      ]),
    ).toBe("shown");
  });
});

describe("mergeAgentSettings", () => {
  it("preserves existing packages while updating skills", () => {
    expect(
      mergeAgentSettings({ packages: ["@bacnh85/pi-fff"], theme: "dark" }, ["/skills"]),
    ).toEqual({
      packages: ["@bacnh85/pi-fff"],
      theme: "dark",
      skills: ["/skills"],
    });
  });
});
