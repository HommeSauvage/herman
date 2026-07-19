import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCheckpoint } from "../../src/bun/rewind-core.js";
import { rewindManager } from "../../src/bun/rewind-manager.js";
import {
  clearHermantAppDir,
  createTestTempDir,
  removeTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";

const SESSION_UUID = "019f3f64-46f5-7f30-82f1-c78e8d4a2e2e";

describe("rewindManager", () => {
  let appDir: string;
  let repoRoot: string;
  let tabId: string;
  const originalEnv = process.env.HERMAN_APP_DIR;

  beforeEach(() => {
    appDir = createTestTempDir("herman-test-");
    repoRoot = createTestTempDir("herman-repo-");
    tabId = `tab-${Date.now()}`;
    setHermantAppDir(appDir);

    execSync("git init", { cwd: repoRoot });
    execSync("git config user.email test@example.com", { cwd: repoRoot });
    execSync("git config user.name Test", { cwd: repoRoot });

    writeFileSync(join(repoRoot, "a.txt"), "a");
    execSync("git add a.txt && git commit -m init", { cwd: repoRoot });
  });

  afterEach(() => {
    rewindManager.dispose(tabId);
    clearHermantAppDir(appDir, originalEnv);
    removeTestTempDir(repoRoot);
  });

  it("scopes checkpoints to the tab's pi session", async () => {
    const sessionDir = join(appDir, "agent", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `2026-07-08T00-00-00-000Z_${SESSION_UUID}.jsonl`), "");

    // Create a checkpoint belonging to the tab's session.
    await createCheckpoint({
      root: repoRoot,
      id: "cp-a",
      sessionId: SESSION_UUID,
      trigger: "turn",
      turnIndex: 0,
    });

    // Create a checkpoint from a different session/tab.
    writeFileSync(join(repoRoot, "a.txt"), "b");
    await createCheckpoint({
      root: repoRoot,
      id: "cp-b",
      sessionId: "3833bf71-7fc1-4fcd-a517-a42551f35c0f",
      trigger: "turn",
      turnIndex: 0,
    });

    await rewindManager.init(tabId, repoRoot, SESSION_UUID);

    const state = (
      rewindManager as unknown as {
        states: Map<string, { sessionId?: string; checkpoints: unknown[] }>;
      }
    ).states.get(tabId);
    expect(state).toBeDefined();
    expect(state?.sessionId).toBe(SESSION_UUID);
    expect(state?.checkpoints).toHaveLength(1);
  });

  it("does not load checkpoints when no piSessionId is provided", async () => {
    await createCheckpoint({
      root: repoRoot,
      id: "cp-other",
      sessionId: "a9f5824d-9bc9-4f15-813f-b0867d4ac21c",
      trigger: "turn",
      turnIndex: 0,
    });

    await rewindManager.init(tabId, repoRoot);

    const state = (
      rewindManager as unknown as {
        states: Map<string, { sessionId?: string; checkpoints: unknown[] }>;
      }
    ).states.get(tabId);
    expect(state).toBeDefined();
    expect(state?.sessionId).toBeUndefined();
    expect(state?.checkpoints).toHaveLength(0);
  });

  it("returns a safety checkpoint id from restoreToCheckpoint", async () => {
    const sessionDir = join(appDir, "agent", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `2026-07-08T00-00-00-000Z_${SESSION_UUID}.jsonl`), "");

    await createCheckpoint({
      root: repoRoot,
      id: "cp-target",
      sessionId: SESSION_UUID,
      trigger: "turn",
      turnIndex: 0,
    });

    await rewindManager.init(tabId, repoRoot, SESSION_UUID);
    await rewindManager.reload(tabId, SESSION_UUID);

    const target = (
      rewindManager as unknown as {
        states: Map<
          string,
          { checkpoints: import("../../src/bun/rewind-core.js").CheckpointData[] }
        >;
      }
    ).states.get(tabId)?.checkpoints[0];
    expect(target).toBeDefined();
    if (!target) throw new Error("test precondition: expected checkpoint target");

    writeFileSync(join(repoRoot, "a.txt"), "before-restore");
    const safetyId = await rewindManager.restoreToCheckpoint(tabId, target);
    expect(safetyId).toMatch(/^before-restore-/);
  });

  it("restores files from a safety checkpoint", async () => {
    const { readFileSync } = await import("node:fs");
    const sessionDir = join(appDir, "agent", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `2026-07-08T00-00-00-000Z_${SESSION_UUID}.jsonl`), "");

    await createCheckpoint({
      root: repoRoot,
      id: "cp-v1",
      sessionId: SESSION_UUID,
      trigger: "turn",
      turnIndex: 0,
    });

    await rewindManager.init(tabId, repoRoot, SESSION_UUID);
    await rewindManager.reload(tabId, SESSION_UUID);
    const target = (
      rewindManager as unknown as {
        states: Map<
          string,
          { checkpoints: import("../../src/bun/rewind-core.js").CheckpointData[] }
        >;
      }
    ).states.get(tabId)?.checkpoints[0];
    expect(target).toBeDefined();
    if (!target) throw new Error("test precondition: expected checkpoint target");

    writeFileSync(join(repoRoot, "a.txt"), "v2");
    const safetyId = await rewindManager.restoreToCheckpoint(tabId, target);
    expect(readFileSync(join(repoRoot, "a.txt"), "utf-8")).toBe("a");

    writeFileSync(join(repoRoot, "a.txt"), "v3");
    if (!safetyId) throw new Error("test precondition: expected safety checkpoint id");
    await rewindManager.restoreSafetyCheckpoint(tabId, safetyId);
    expect(readFileSync(join(repoRoot, "a.txt"), "utf-8")).toBe("v2");
  });
});
