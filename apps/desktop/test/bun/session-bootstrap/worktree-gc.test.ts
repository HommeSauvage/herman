import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../../src/bun/rewind-core.js";
import { collectOrphanWorktrees } from "../../../src/bun/session-bootstrap/worktree-gc.js";
import {
  createSessionWorktree,
  initProjectRepo,
  removeSessionWorktree,
} from "../../../src/bun/worktree.js";
import { createTestTempDir, removeTestTempDir } from "../../helpers/temp-dir.js";

const dirs: string[] = [];
let worktreesDir: string;
let previousWorktreesDir: string | undefined;

function makeDir(prefix: string): string {
  const dir = createTestTempDir(`herman-gc-${prefix}-`);
  dirs.push(dir);
  return dir;
}

async function makeProject(name: string): Promise<string> {
  const dir = makeDir(name);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n.env.*\n");
  writeFileSync(join(dir, "index.txt"), "hello\n");
  await initProjectRepo(dir);
  return dir;
}

/** Back-date a path's mtime so the GC's 24h guard sees it as old. */
async function agePath(path: string, ms: number): Promise<void> {
  const { utimes } = await import("node:fs/promises");
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

beforeEach(() => {
  previousWorktreesDir = process.env.HERMAN_WORKTREES_DIR;
  worktreesDir = makeDir("worktrees-root");
  process.env.HERMAN_WORKTREES_DIR = worktreesDir;
});

afterEach(async () => {
  if (previousWorktreesDir == null) {
    delete process.env.HERMAN_WORKTREES_DIR;
  } else {
    process.env.HERMAN_WORKTREES_DIR = previousWorktreesDir;
  }
  for (const dir of dirs.splice(0, dirs.length)) {
    removeTestTempDir(dir);
  }
});

describe("collectOrphanWorktrees", () => {
  it("removes old orphan worktrees and their branches, keeps known sessions", async () => {
    const project = await makeProject("main");

    // Backdate the initial commit so the branch 24h guard sees it as old.
    const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    await git("-c user.email=herman@local -c user.name=Herman commit --amend --no-edit", project, {
      env: { ...process.env, GIT_COMMITTER_DATE: oldDate, GIT_AUTHOR_DATE: oldDate },
    });

    // One orphan (unknown tab, old) and one known session worktree.
    const orphan = await createSessionWorktree(project, "aaaaaaaa-0000-4000-8000-0000000000aa");
    const known = await createSessionWorktree(project, "bbbbbbbb-0000-4000-8000-0000000000bb");

    await agePath(orphan.folderPath, 48 * 60 * 60 * 1000);
    await agePath(known.folderPath, 48 * 60 * 60 * 1000);

    const report = await collectOrphanWorktrees({
      knownTabIds: new Set(["bbbbbbbb-0000-4000-8000-0000000000bb"]),
      knownProjectRoots: [project],
    });

    expect(report.errors).toEqual([]);
    expect(existsSync(orphan.folderPath)).toBe(false);
    expect(existsSync(known.folderPath)).toBe(true);
    expect(report.removedWorktrees).toContain(orphan.folderPath);

    // The orphan's branch was deleted; the known session's branch remains.
    const branches = await git(
      `branch --list 'herman/session/*' --format='%(refname:short)'`,
      project,
    );
    expect(branches).not.toContain("aaaaaaaa");
    expect(branches).toContain("bbbbbbbb");

    await removeSessionWorktree({ folderPath: known.folderPath, worktree: known.worktree });
  });

  it("never touches worktrees younger than 24h, even unknown ones", async () => {
    const project = await makeProject("young-main");
    const young = await createSessionWorktree(project, "cccccccc-0000-4000-8000-0000000000cc");

    const report = await collectOrphanWorktrees({
      knownTabIds: new Set(),
      knownProjectRoots: [project],
    });

    expect(report.removedWorktrees).toEqual([]);
    expect(existsSync(young.folderPath)).toBe(true);

    await removeSessionWorktree({ folderPath: young.folderPath, worktree: young.worktree });
  });

  it("never deletes branches checked out in a worktree or owned by known sessions", async () => {
    const project = await makeProject("branches-main");
    const kept = await createSessionWorktree(project, "dddddddd-0000-4000-8000-0000000000dd");
    await agePath(kept.folderPath, 48 * 60 * 60 * 1000);

    const report = await collectOrphanWorktrees({
      knownTabIds: new Set(["dddddddd-0000-4000-8000-0000000000dd"]),
      knownProjectRoots: [project],
    });

    expect(report.deletedBranches).toEqual([]);
    const branches = await git(
      `branch --list 'herman/session/*' --format='%(refname:short)'`,
      project,
    );
    expect(branches).toContain("dddddddd");

    await removeSessionWorktree({ folderPath: kept.folderPath, worktree: kept.worktree });
  });

  it("tolerates a missing worktrees dir and non-git folders", async () => {
    const empty = makeDir("empty");
    const report = await collectOrphanWorktrees({
      worktreesDir: join(empty, "does-not-exist"),
      knownTabIds: new Set(),
      knownProjectRoots: [join(empty, "also-missing")],
    });
    expect(report.removedWorktrees).toEqual([]);
  });
});
