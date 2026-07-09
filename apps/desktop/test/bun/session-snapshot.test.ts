import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import { readSessionSnapshot } from "../../src/bun/session-snapshot.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-session-snapshot-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

describe("readSessionSnapshot", () => {
  it("returns empty snapshot when no pi session exists", () => {
    expect(readSessionSnapshot("missing-tab")).toEqual({
      messages: [],
      piSessionId: undefined,
    });
  });

  it("reads messages and context totals from pi session JSONL", () => {
    const tabId = "tab-1";
    const sessionsDir = join(tempDir, "agent-configs", tabId, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const file = join(sessionsDir, "2026-07-09T00-00-00-000Z_sess-1.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-1",
          timestamp: "2026-07-09T00:00:00.000Z",
          cwd: "/project",
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-07-09T00:00:01.000Z",
          message: { id: "u1", role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "entry-2",
          parentId: "entry-1",
          timestamp: "2026-07-09T00:00:02.000Z",
          message: {
            id: "a1",
            role: "assistant",
            content: "hi",
            provider: "anthropic",
            model: "claude-sonnet-4.6",
            usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total_prompt: 0.001, cost_completion: 0.002, cost_total: 0.003, total: 0.003 } },
          },
        }),
      ].join("\n") + "\n",
    );

    const snapshot = readSessionSnapshot(tabId);
    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
      {
        id: "a1",
        role: "assistant",
        content: "hi",
        model: "claude-sonnet-4.6",
        provider: "anthropic",
      },
    ]);
    expect(snapshot.contextStats?.inputTokens).toBe(100);
    expect(snapshot.contextStats?.outputTokens).toBe(20);
    expect(snapshot.contextStats?.totalTokens).toBe(125);
    expect(snapshot.sessionFile).toBe(file);
  });

  it("uses persisted piSessionId instead of the newest session file", () => {
    const tabId = "tab-2";
    const sessionsDir = join(tempDir, "agent-configs", tabId, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const older = join(sessionsDir, "2026-07-08T00-00-00-000Z_sess-1.jsonl");
    const newer = join(sessionsDir, "2026-07-09T00-00-00-000Z_empty-new.jsonl");
    writeFileSync(
      older,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-1",
          timestamp: "2026-07-08T00:00:00.000Z",
          cwd: "/project",
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-07-08T00:00:01.000Z",
          message: { id: "u1", role: "user", content: "from persisted session" },
        }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      newer,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "empty-new",
        timestamp: "2026-07-09T00:00:00.000Z",
        cwd: "/project",
      }) + "\n",
    );

    const snapshot = readSessionSnapshot(tabId, "sess-1");
    expect(snapshot.sessionFile).toBe(older);
    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", content: "from persisted session" },
    ]);
  });
});
