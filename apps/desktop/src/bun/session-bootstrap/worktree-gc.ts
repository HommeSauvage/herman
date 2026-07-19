import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import { git } from "../rewind-core.js";
import { sessionWorktreesDir } from "../worktree.js";

const logger = getLogger(["herman-desktop", "session-bootstrap", "gc"]);

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;
const SESSION_BRANCH_PREFIX = "herman/session/";

export function defaultWorktreesDir(): string {
  return sessionWorktreesDir();
}

export type WorktreeGcOptions = {
  /** Directory holding per-tab worktrees (default ~/Herman/.worktrees). */
  worktreesDir?: string;
  /** Tab ids with a live persisted session — never collected. */
  knownTabIds: Set<string>;
  /** Known project roots to prune + branch-GC. */
  knownProjectRoots: string[];
  /** Minimum orphan age before collection (default 24h). */
  olderThanMs?: number;
  now?: number;
};

export type WorktreeGcReport = {
  removedWorktrees: string[];
  deletedBranches: string[];
  errors: string[];
};

/**
 * Startup garbage collection for orphaned session worktrees and branches.
 * Anything owned by a known session — or younger than 24h — is never
 * touched. Designed to run in the background; errors are warnings.
 */
export async function collectOrphanWorktrees(opts: WorktreeGcOptions): Promise<WorktreeGcReport> {
  const report: WorktreeGcReport = { removedWorktrees: [], deletedBranches: [], errors: [] };
  const dir = opts.worktreesDir ?? defaultWorktreesDir();
  const now = opts.now ?? Date.now();
  const maxAge = opts.olderThanMs ?? ORPHAN_AGE_MS;

  // ── 1. Orphaned worktree directories ──
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (opts.knownTabIds.has(entry)) continue;
    const fullPath = join(dir, entry);
    try {
      const info = await stat(fullPath);
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs < maxAge) continue;

      // Resolve the main repo via the worktree's git-common-dir so we can
      // remove it the git way first.
      let removed = false;
      try {
        const commonDir = await git("rev-parse --git-common-dir", fullPath);
        const mainRepo = commonDir.replace(/\/\.git$/, "");
        if (mainRepo && mainRepo !== commonDir && existsSync(mainRepo)) {
          await git(`worktree remove --force "${fullPath}"`, mainRepo);
          removed = true;
        }
      } catch (error) {
        logger.debug("git worktree remove failed for orphan; falling back to rm", {
          path: fullPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!removed && existsSync(fullPath)) {
        await rm(fullPath, { recursive: true, force: true });
      }
      report.removedWorktrees.push(fullPath);
      logger.info("Collected orphaned session worktree", { path: fullPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${fullPath}: ${message}`);
      logger.warning("Failed to collect orphaned worktree", { path: fullPath, error: message });
    }
  }

  // ── 2. Prune + stale session branches per known project ──
  for (const projectRoot of opts.knownProjectRoots) {
    try {
      if (!existsSync(join(projectRoot, ".git"))) continue;
      await git("worktree prune", projectRoot).catch(() => "");

      const checkedOut = await checkedOutBranches(projectRoot);
      const branchOutput = await git(
        `for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/${SESSION_BRANCH_PREFIX}`,
        projectRoot,
      ).catch(() => "");
      if (!branchOutput.trim()) continue;

      for (const line of branchOutput.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.lastIndexOf(" ");
        const branch = trimmed.slice(0, spaceIdx);
        const committerUnix = Number(trimmed.slice(spaceIdx + 1)) || 0;
        if (!branch.startsWith(SESSION_BRANCH_PREFIX)) continue;
        // Never delete a branch checked out in any worktree.
        if (checkedOut.has(branch)) continue;
        // Keep branches that still belong to a known session.
        if (branchOwnedByKnownSession(branch, opts.knownTabIds)) continue;
        // 24h guard.
        if (now - committerUnix * 1000 < maxAge) continue;

        try {
          await git(`branch -D "${branch}"`, projectRoot);
          report.deletedBranches.push(`${projectRoot}:${branch}`);
          logger.info("Deleted stale session branch", { projectRoot, branch });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.errors.push(`${projectRoot}:${branch}: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${projectRoot}: ${message}`);
    }
  }

  logger.info("Worktree GC complete", {
    removedWorktrees: report.removedWorktrees.length,
    deletedBranches: report.deletedBranches.length,
    errors: report.errors.length,
  });
  return report;
}

/** Branches currently checked out in any worktree of the repo. */
async function checkedOutBranches(projectRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const porcelain = await git("worktree list --porcelain", projectRoot);
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("branch ")) {
        out.add(
          line
            .slice("branch ".length)
            .replace(/^refs\/heads\//, "")
            .trim(),
        );
      }
    }
  } catch {
    // Best effort.
  }
  return out;
}

/**
 * Session branches are named `herman/session/<escaped-tabId.slice(0,24)>`;
 * a branch belongs to a known session when its suffix matches the known
 * tab id's escaped prefix.
 */
function branchOwnedByKnownSession(branch: string, knownTabIds: Set<string>): boolean {
  const suffix = branch.slice(SESSION_BRANCH_PREFIX.length);
  for (const tabId of knownTabIds) {
    if (escapeRefPart(tabId).slice(0, 24) === suffix) return true;
  }
  return false;
}

function escapeRefPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
