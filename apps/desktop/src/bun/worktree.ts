import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { SessionWorktree, Tab, TabId } from "../shared/rpc.js";
import { git, getRepoRoot, isGitRepo } from "./rewind-core.js";

const logger = getLogger(["herman-desktop", "worktree"]);

const DEFAULT_GITIGNORE = `node_modules
dist
build
.env
.env.*
.DS_Store
`;

function escapeRefPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function parsePorcelainPaths(output: string): string[] {
  if (!output.trim()) return [];
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const arrow = line.indexOf(" -> ");
    const path = arrow >= 0 ? line.slice(arrow + 4) : line.slice(3);
    paths.add(path.trim());
  }
  return [...paths];
}

function unionFileCount(...groups: string[][]): number {
  const paths = new Set<string>();
  for (const group of groups) {
    for (const path of group) {
      if (path) paths.add(path);
    }
  }
  return paths.size;
}

export async function initProjectRepo(projectPath: string): Promise<void> {
  if (await isGitRepo(projectPath)) {
    return;
  }

  const gitignorePath = join(projectPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, DEFAULT_GITIGNORE, "utf-8");
  }

  await git("init -b main", projectPath);
  await git("add -A", projectPath);
  await git(
    "-c user.email=herman@local -c user.name=Herman commit -m \"Initial project\"",
    projectPath,
  );
}

/** Detect the default install command for a project based on lockfiles. */
export function detectInstallCommand(folderPath: string): string {
  const hasBunLock =
    existsSync(join(folderPath, "bun.lock")) || existsSync(join(folderPath, "bun.lockb"));
  return hasBunLock ? "bun install" : "npm install";
}

/**
 * Run an install command in folderPath with a timeout, draining stdout.
 * Throws on non-zero exit.
 */
export async function runInstallCommand(folderPath: string, installCommand: string, timeoutMs = 300_000): Promise<void> {
  logger.info("Running install command", { folderPath, installCommand });
  const proc = Bun.spawn(["sh", "-c", installCommand], {
    cwd: folderPath,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  // Drain stdout asynchronously so the child never blocks on a full pipe.
  void (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Ignore read errors.
    }
  })();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number;
  try {
    exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Install timed out after ${timeoutMs / 1000}s: ${installCommand}`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    proc.kill();
    throw err;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Install command failed (exit ${exitCode}): ${installCommand}\n${stderr.slice(0, 500)}`);
  }

  logger.info("Install command completed", { folderPath });
}

export async function ensureNodeModulesInstalled(folderPath: string): Promise<void> {
  if (existsSync(join(folderPath, "node_modules"))) {
    return;
  }
  const command = detectInstallCommand(folderPath);
  await runInstallCommand(folderPath, command);
}

async function copyEnvFiles(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(".env")) continue;
    await copyFile(join(sourceDir, entry.name), join(targetDir, entry.name));
  }
}

/**
 * Resolve the true project root from a folder path, even when the folder
 * is a git worktree. In a regular repo this returns the repo root. In a
 * worktree it traces back to the main repo root via git-common-dir.
 */
export async function resolveProjectRoot(folderPath: string): Promise<string> {
  try {
    const commonDir = await git("rev-parse --git-common-dir", folderPath);
    // In a regular repo git-common-dir is ".git"; use show-toplevel.
    // In a worktree it's an absolute path to the main repo's .git dir.
    if (commonDir === ".git") {
      return await getRepoRoot(folderPath);
    }
    // Worktree: strip the trailing /.git to get the main repo root.
    const resolved = commonDir.replace(/\/\.git$/, "");
    if (resolved && resolved !== commonDir) {
      return resolved;
    }
    return await getRepoRoot(folderPath);
  } catch {
    return folderPath;
  }
}

export async function createSessionWorktree(mainFolderPath: string, tabId: TabId): Promise<{
  folderPath: string;
  worktree: SessionWorktree;
}> {
  const repoRoot = await getRepoRoot(mainFolderPath);
  const baseBranch = (await git("rev-parse --abbrev-ref HEAD", repoRoot)) || "main";
  const branch = `herman/session/${escapeRefPart(tabId).slice(0, 24)}`;
  const folderPath = join(homedir(), "Herman", ".worktrees", tabId);
  await mkdir(join(homedir(), "Herman", ".worktrees"), { recursive: true });
  await git(`worktree add "${folderPath}" -b "${branch}" "${baseBranch}"`, repoRoot);
  await copyEnvFiles(repoRoot, folderPath);
  await ensureNodeModulesInstalled(folderPath);
  return {
    folderPath,
    worktree: {
      branch,
      baseBranch,
      mainFolderPath: repoRoot,
    },
  };
}

export async function ensureSessionWorktree(tab: Pick<Tab, "id" | "worktree" | "folderPath">): Promise<string> {
  if (!tab.worktree) return tab.folderPath;
  if (existsSync(tab.folderPath)) return tab.folderPath;
  const created = await createSessionWorktree(tab.worktree.mainFolderPath, tab.id);
  return created.folderPath;
}

export async function removeSessionWorktree(tab: Pick<Tab, "folderPath" | "worktree">): Promise<void> {
  if (!tab.worktree) return;
  const repoRoot = await getRepoRoot(tab.worktree.mainFolderPath);
  try {
    await git(`worktree remove --force "${tab.folderPath}"`, repoRoot);
  } catch (error) {
    logger.warning("Failed to remove worktree folder", { error: String(error), path: tab.folderPath });
  }
  try {
    await git(`branch -D "${tab.worktree.branch}"`, repoRoot);
  } catch (error) {
    logger.warning("Failed to remove worktree branch", {
      error: String(error),
      branch: tab.worktree.branch,
    });
  }
}

export async function getSessionChanges(
  tab: Pick<Tab, "worktree" | "folderPath">,
): Promise<{ isWorktree: boolean; changedFiles: number; canApply: boolean }> {
  if (!tab.worktree) {
    return { isWorktree: false, changedFiles: 0, canApply: false };
  }

  const repoRoot = await getRepoRoot(tab.worktree.mainFolderPath);
  const worktreePath = tab.folderPath;
  if (!worktreePath) {
    return { isWorktree: true, changedFiles: 0, canApply: false };
  }

  const [porcelainOutput, committedOutput] = await Promise.all([
    git("status --porcelain", worktreePath).catch(() => ""),
    git(
      `diff --name-only "${tab.worktree.baseBranch}...${tab.worktree.branch}"`,
      repoRoot,
    ).catch(() => ""),
  ]);

  const uncommittedPaths = parsePorcelainPaths(porcelainOutput);
  const committedPaths = committedOutput ? committedOutput.split("\n").filter(Boolean) : [];
  const changedFiles = unionFileCount(uncommittedPaths, committedPaths);

  return { isWorktree: true, changedFiles, canApply: changedFiles > 0 };
}

export function buildSessionSyncPrompt(opts: {
  worktreePath: string;
  mainFolderPath: string;
  baseBranch: string;
  sessionBranch: string;
}): string {
  return [
    "Please save my work to the real project folder. This is an automated save request from the Save button.",
    "",
    "Paths:",
    `- Draft copy (where you are working): ${opts.worktreePath}`,
    `- Real project folder: ${opts.mainFolderPath}`,
    `- Real project branch: ${opts.baseBranch}`,
    `- Draft branch: ${opts.sessionBranch}`,
    "",
    "Do all of the following without asking me questions:",
    "1. Commit any uncommitted changes in the draft copy with message \"Session changes\".",
    "2. In the draft copy, merge the latest changes from the real project branch into the draft. Resolve any conflicts carefully using your knowledge of this session.",
    "3. Commit conflict resolutions in the draft if needed.",
    "4. In the real project folder, merge the draft branch into the real project branch (use git -C with the real project path). Resolve any conflicts.",
    "5. Commit the merge in the real project folder.",
    "6. Back in the draft copy, merge the real project branch so the draft and real project stay aligned.",
    "7. Leave both folders with clean working trees (no uncommitted files, no conflict markers).",
    "",
    "Do not remove the draft copy or delete branches. Do not explain what you did unless something failed.",
  ].join("\n");
}

export async function ensureGitAndDependencies(projectPath: string): Promise<void> {
  await initProjectRepo(projectPath);
  await ensureNodeModulesInstalled(projectPath);
}

export async function ensureWorktreeDependencies(folderPath: string): Promise<void> {
  const nodeModules = join(folderPath, "node_modules");
  if (!existsSync(nodeModules)) {
    await ensureNodeModulesInstalled(folderPath);
    return;
  }
  const info = await stat(nodeModules);
  if (info.isDirectory()) return;
  await ensureNodeModulesInstalled(folderPath);
}
