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

function makeProject(name: string): string {
  const dir = createTestTempDir(`herman-${name}-`);
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
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

    const created = await createSessionWorktree(project, "tab-test-1");
    expect(existsSync(created.folderPath)).toBe(true);
    expect(existsSync(join(created.folderPath, ".env"))).toBe(true);

    await removeSessionWorktree({
      folderPath: created.folderPath,
      worktree: created.worktree,
    });
  });

  it("counts uncommitted changes in the draft copy", async () => {
    const project = makeProject("uncommitted");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(join(project, "index.txt"), "hello\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    await initProjectRepo(project);

    const tabId = "tab-uncommitted";
    const created = await createSessionWorktree(project, tabId);
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

    const tabId = "tab-triple-dot";
    const created = await createSessionWorktree(project, tabId);

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

    const tabId = "tab-merged";
    const created = await createSessionWorktree(project, tabId);
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
  });
});
