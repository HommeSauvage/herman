import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDir, removeTestTempDir } from "../helpers/temp-dir.js";
import { git } from "../../src/bun/rewind-core.js";
import {
  createSessionWorktree,
  getSessionChanges,
  initProjectRepo,
  removeSessionWorktree,
} from "../../src/bun/worktree.js";

const createdDirs: string[] = [];
const createdWorktrees: Array<{ folderPath: string; worktree: { branch: string; baseBranch: string; mainFolderPath: string } }> = [];

function makeProject(name: string): string {
  const dir = createTestTempDir(`herman-${name}-`);
  createdDirs.push(dir);
  // Ignore install artifacts so createSessionWorktree's npm install does not
  // count as session changes.
  writeFileSync(
    join(dir, ".gitignore"),
    "node_modules\npackage-lock.json\nbun.lock\nbun.lockb\n.env\n.env.*\n.DS_Store\n",
  );
  return dir;
}

function uniqueTabId(label: string): string {
  return `tab-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

afterEach(async () => {
  for (const entry of createdWorktrees.splice(0, createdWorktrees.length)) {
    await removeSessionWorktree(entry);
  }
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    removeTestTempDir(dir);
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

    const created = await createSessionWorktree(project, uniqueTabId("test-1"));
    createdWorktrees.push(created);
    expect(existsSync(created.folderPath)).toBe(true);
    // createSessionWorktree is git-only — env provisioning is the setup
    // runner's job (session-bootstrap), so no .env copy happens here.
    expect(existsSync(join(created.folderPath, ".env"))).toBe(false);

    await removeSessionWorktree({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
    createdWorktrees.pop();
  });

  it("counts uncommitted changes in the draft copy", async () => {
    const project = makeProject("uncommitted");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(join(project, "index.txt"), "hello\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);

    const created = await createSessionWorktree(project, uniqueTabId("uncommitted"));
    createdWorktrees.push(created);
    writeFileSync(join(created.folderPath, "index.txt"), "updated\n");

    const changes = await getSessionChanges({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
    expect(changes.canApply).toBe(true);
    expect(changes.changedFiles).toBe(1);
  });

  it("uses triple-dot so unrelated main-only commits are not counted", async () => {
    const project = makeProject("triple-dot");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(join(project, "index.txt"), "hello\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);

    const created = await createSessionWorktree(project, uniqueTabId("triple-dot"));
    createdWorktrees.push(created);

    writeFileSync(join(project, "other.txt"), "main-only\n");
    await git("add other.txt", project);
    await git('-c user.email=herman@local -c user.name=Herman commit -m "Main only"', project);

    const changes = await getSessionChanges({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
    expect(changes.canApply).toBe(false);
    expect(changes.changedFiles).toBe(0);
  });

  it("reports zero unsaved changes after draft work is merged into main", async () => {
    const project = makeProject("merged");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(join(project, "index.txt"), "hello\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);

    const created = await createSessionWorktree(project, uniqueTabId("merged"));
    createdWorktrees.push(created);
    writeFileSync(join(created.folderPath, "index.txt"), "updated\n");
    await git("add index.txt", created.folderPath);
    await git('-c user.email=herman@local -c user.name=Herman commit -m "Session changes"', created.folderPath);

    await git(`merge --no-ff "${created.worktree.branch}"`, project);
    await git(`merge "${created.worktree.baseBranch}"`, created.folderPath);

    const changes = await getSessionChanges({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
    expect(changes.canApply).toBe(false);
    expect(changes.changedFiles).toBe(0);

    await removeSessionWorktree({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
    createdWorktrees.pop();
  });
});
