import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import {
  getProjectFoldersFromPiSessions,
  listPiSessionsForProject,
} from "../../src/bun/pi-sessions.js";
import { WorktreeIndex } from "../../src/bun/worktree.js";

let appDir: string;

function writeSession(id: string, cwd: string, firstMessage = "hello"): void {
  const sessionsDir = join(appDir, "agent", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-07-09T00:00:00.000Z",
      cwd,
    }),
    JSON.stringify({
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-07-09T00:00:01.000Z",
      message: { role: "user", content: firstMessage },
    }),
  ];
  writeFileSync(
    join(sessionsDir, `2026-07-09T00-00-00-000Z_${id}.jsonl`),
    lines.join("\n") + "\n",
  );
}

beforeEach(() => {
  appDir = createTestTempDir("herman-pi-sessions-");
  setHermantAppDir(appDir);
});

afterEach(() => {
  clearHermantAppDir(appDir);
});

describe("pi session listing normalization (D5)", () => {
  it("maps worktree-cwd sessions back to their owning project", async () => {
    const projectRoot = "/Users/test/cooking";
    const worktreeCwd = "/Users/test/Herman/.worktrees/tab-abc-123";
    writeSession("sess-main-0000-0000-0000-000000000001", projectRoot, "main session");
    writeSession("sess-wtree-000-0000-0000-000000000002", worktreeCwd, "worktree session");

    const index = new WorktreeIndex([
      {
        id: "tab-abc-123",
        worktree: {
          branch: "herman/session/tab-abc-123",
          baseBranch: "main",
          mainFolderPath: projectRoot,
        },
      },
    ]);

    const sessions = await listPiSessionsForProject(projectRoot, index);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("sess-main-0000-0000-0000-000000000001");
    expect(ids).toContain("sess-wtree-000-0000-0000-000000000002");

    // Without the index, worktree sessions are invisible (old behavior).
    const directOnly = await listPiSessionsForProject(projectRoot);
    expect(directOnly.map((s) => s.id)).not.toContain("sess-wtree-000-0000-0000-000000000002");
  });

  it("never surfaces worktree directories as projects", async () => {
    writeSession("sess-a-0000-0000-0000-0000-00000000001", "/Users/test/alpha");
    writeSession(
      "sess-b-0000-0000-0000-0000-00000000002",
      "/Users/test/Herman/.worktrees/tab-xyz",
    );

    const folders = await getProjectFoldersFromPiSessions();
    expect(folders).toContain("/Users/test/alpha");
    expect(folders.some((f) => f.includes("/.worktrees/"))).toBe(false);
  });
});

describe("WorktreeIndex", () => {
  it("resolves tab ids from worktree paths", () => {
    expect(WorktreeIndex.worktreeTabId("/Users/x/Herman/.worktrees/tab-1")).toBe("tab-1");
    expect(WorktreeIndex.worktreeTabId("/Users/x/Herman/.worktrees/tab-1/")).toBe("tab-1");
    expect(WorktreeIndex.worktreeTabId("/Users/x/project")).toBeUndefined();
    expect(WorktreeIndex.isWorktreePath("/Users/x/Herman/.worktrees/tab-1")).toBe(true);
    expect(WorktreeIndex.isWorktreePath("/Users/x/project")).toBe(false);
  });
});
