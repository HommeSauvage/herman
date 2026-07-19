import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveTabHistory } from "../../src/bun/tab-history.js";
import { loadInstantHydration } from "../../src/bun/tab-message-hydration.js";
import { clearHermantAppDir, createTestTempDir, setHermantAppDir } from "../helpers/temp-dir.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-tab-hydration-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

describe("loadInstantHydration", () => {
  it("prefers cache for instant paint when pi snapshot is empty", async () => {
    const tabId = "tab-cache";
    await saveTabHistory(tabId, [{ id: "m1", role: "user", content: "cached hello" }]);

    const instant = await loadInstantHydration(tabId, {
      id: tabId,
      title: "Test",
      folderPath: "/project",
      projectColor: "#fff",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(instant.messages).toEqual([{ id: "m1", role: "user", content: "cached hello" }]);
    expect(instant.hydrationStatus).toBe("success");
  });

  it("prefers pi snapshot when it has more messages than cache", async () => {
    const tabId = "tab-pi";
    await saveTabHistory(tabId, [{ id: "m1", role: "user", content: "cached" }]);

    const sessionsDir = join(tempDir, "agent", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "2026-07-09T00-00-00-000Z_sess-1.jsonl"),
      `${[
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
          message: { id: "u1", role: "user", content: "pi hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "entry-2",
          parentId: "entry-1",
          timestamp: "2026-07-09T00:00:02.000Z",
          message: { id: "a1", role: "assistant", content: "pi reply" },
        }),
      ].join("\n")}\n`,
    );

    const instant = await loadInstantHydration(tabId, {
      id: tabId,
      title: "Test",
      folderPath: "/project",
      projectColor: "#fff",
      piSessionId: "sess-1",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(instant.messages).toEqual([
      { id: "u1", role: "user", content: "pi hello" },
      { id: "a1", role: "assistant", content: "pi reply" },
    ]);
  });
});
