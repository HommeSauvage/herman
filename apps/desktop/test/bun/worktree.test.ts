import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { git } from "../../src/bun/rewind-core.js";
import {
  applySessionToMainProject,
  createSessionWorktree,
  initProjectRepo,
  removeSessionWorktree,
} from "../../src/bun/worktree.js";

const createdDirs: string[] = [];

function makeProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `herman-${name}-`));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree helpers", () => {
  it("initializes a repo and creates initial commit", async () => {
    const project = makeProject("init");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);
    const branch = await git("rev-parse --abbrev-ref HEAD", project);
    expect(branch).toBe("main");
  });

  it("creates and removes a session worktree", async () => {
    const project = makeProject("worktree");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(join(project, ".env"), "HELLO=1\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);

    const created = await createSessionWorktree(project, "tab-test-1");
    expect(existsSync(created.folderPath)).toBe(true);
    expect(existsSync(join(created.folderPath, ".env"))).toBe(true);

    await removeSessionWorktree({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
  });

  it("applies worktree changes back to main", async () => {
    const project = makeProject("merge");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(join(project, "index.txt"), "hello\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);

    const tabId = `tab-merge-${Date.now()}`;
    const created = await createSessionWorktree(project, tabId);
    writeFileSync(join(created.folderPath, "index.txt"), "updated\n");
    const result = await applySessionToMainProject({
      id: tabId,
      worktree: created.worktree,
    });
    expect(result.status === "applied" || result.status === "resolving").toBe(true);
    await removeSessionWorktree({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
  });
});
