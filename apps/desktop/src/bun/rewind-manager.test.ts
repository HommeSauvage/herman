import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCheckpoint } from "./rewind-core.js";
import { rewindManager } from "./rewind-manager.js";

describe("rewindManager", () => {
  let appDir: string;
  let repoRoot: string;
  let tabId: string;
  const originalEnv = process.env.HERMAN_APP_DIR;

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "herman-test-"));
    repoRoot = mkdtempSync(join(tmpdir(), "herman-repo-"));
    tabId = `tab-${Date.now()}`;
    process.env.HERMAN_APP_DIR = appDir;

    execSync("git init", { cwd: repoRoot });
    execSync("git config user.email test@example.com", { cwd: repoRoot });
    execSync("git config user.name Test", { cwd: repoRoot });

    writeFileSync(join(repoRoot, "a.txt"), "a");
    execSync("git add a.txt && git commit -m init", { cwd: repoRoot });
  });

  afterEach(() => {
    rewindManager.dispose(tabId);
    if (originalEnv === undefined) {
      delete process.env.HERMAN_APP_DIR;
    } else {
      process.env.HERMAN_APP_DIR = originalEnv;
    }
    rmSync(appDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("scopes checkpoints to the tab's pi session", async () => {
    // Write a session file so RewindManager can discover the tab's UUID.
    const sessionDir = join(appDir, "agent-configs", tabId, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "2026-07-08T00-00-00-000Z_019f3f64-46f5-7f30-82f1-c78e8d4a2e2e.jsonl"), "");

    // Create a checkpoint belonging to the tab's session.
    await createCheckpoint({
      root: repoRoot,
      id: "cp-a",
      sessionId: "019f3f64-46f5-7f30-82f1-c78e8d4a2e2e",
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

    await rewindManager.init(tabId, repoRoot);

    const state = (rewindManager as unknown as { states: Map<string, { sessionId?: string; checkpoints: unknown[] }> }).states.get(tabId);
    expect(state).toBeDefined();
    expect(state!.sessionId).toBe("019f3f64-46f5-7f30-82f1-c78e8d4a2e2e");
    expect(state!.checkpoints).toHaveLength(1);
  });

  it("does not load checkpoints when the session file is missing", async () => {
    await createCheckpoint({
      root: repoRoot,
      id: "cp-other",
      sessionId: "a9f5824d-9bc9-4f15-813f-b0867d4ac21c",
      trigger: "turn",
      turnIndex: 0,
    });

    await rewindManager.init(tabId, repoRoot);

    const state = (rewindManager as unknown as { states: Map<string, { sessionId?: string; checkpoints: unknown[] }> }).states.get(tabId);
    expect(state).toBeDefined();
    expect(state!.sessionId).toBeUndefined();
    expect(state!.checkpoints).toHaveLength(0);
  });
});
