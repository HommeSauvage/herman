import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { join } from "node:path";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import { loadWindowState, saveWindowState } from "../../src/bun/window-state.js";
import { windowStatePath } from "../../src/bun/app-paths.js";

let appDir: string;

beforeEach(() => {
  appDir = createTestTempDir("herman-window-state-");
  setHermantAppDir(appDir);
});

afterEach(() => {
  clearHermantAppDir(appDir);
});

describe("window-state legacy migration", () => {
  it("derives isolation for sessions that predate the field", async () => {
    const now = Date.now();
    await saveWindowState({
      sessions: [
        {
          id: "tab-worktree",
          title: "Isolated",
          folderPath: "/Users/x/Herman/.worktrees/tab-worktree",
          projectRoot: "/Users/x/project",
          projectColor: "#fff",
          worktree: {
            branch: "herman/session/tab-worktree",
            baseBranch: "main",
            mainFolderPath: "/Users/x/project",
          },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "tab-direct",
          title: "Direct",
          folderPath: "/Users/x/other",
          projectRoot: "/Users/x/other",
          projectColor: "#fff",
          createdAt: now,
          updatedAt: now,
        },
      ],
      openTabIds: ["tab-worktree", "tab-direct"],
    });

    // The persisted shape on disk has no isolation yet (legacy write).
    const state = await loadWindowState();
    expect(state.sessions?.find((s) => s.id === "tab-worktree")?.isolation).toBe("worktree");
    expect(state.sessions?.find((s) => s.id === "tab-direct")?.isolation).toBe("direct");
  });

  it("keeps an explicit isolation untouched", async () => {
    const now = Date.now();
    await saveWindowState({
      sessions: [
        {
          id: "tab-x",
          title: "X",
          folderPath: "/Users/x/other",
          projectRoot: "/Users/x/other",
          projectColor: "#fff",
          isolation: "worktree",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const state = await loadWindowState();
    expect(state.sessions?.[0]?.isolation).toBe("worktree");
  });
});
