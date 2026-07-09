import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { SessionWorktree, Tab, TabId } from "../shared/rpc.js";
import { AgentBridge } from "./agent-bridge.js";
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

export async function ensureNodeModulesInstalled(folderPath: string): Promise<void> {
  if (existsSync(join(folderPath, "node_modules"))) {
    return;
  }

  const hasBunLock = existsSync(join(folderPath, "bun.lock")) || existsSync(join(folderPath, "bun.lockb"));
  const command = hasBunLock ? "bun install" : "npm install";
  await git(`rev-parse --show-toplevel`, folderPath).catch(() => undefined);
  const [cmd, ...args] = command.split(" ");
  const proc = Bun.spawn([cmd, ...args], {
    cwd: folderPath,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Failed to install dependencies in ${folderPath} (exit ${code})`);
  }
}

async function copyEnvFiles(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(".env")) continue;
    await copyFile(join(sourceDir, entry.name), join(targetDir, entry.name));
  }
}

async function linkNodeModules(sourceDir: string, targetDir: string): Promise<void> {
  const src = join(sourceDir, "node_modules");
  const dest = join(targetDir, "node_modules");
  if (!existsSync(src) || existsSync(dest)) {
    return;
  }
  await symlink(src, dest, "dir");
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
  await copyEnvFiles(mainFolderPath, folderPath);
  try {
    await linkNodeModules(mainFolderPath, folderPath);
  } catch {
    await ensureNodeModulesInstalled(folderPath);
  }
  return {
    folderPath,
    worktree: {
      branch,
      baseBranch,
      mainFolderPath,
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

export async function getSessionChanges(tab: Pick<Tab, "worktree">): Promise<{ isWorktree: boolean; changedFiles: number; canApply: boolean }> {
  if (!tab.worktree) {
    return { isWorktree: false, changedFiles: 0, canApply: false };
  }
  const repoRoot = await getRepoRoot(tab.worktree.mainFolderPath);
  const output = await git(`diff --name-only "${tab.worktree.baseBranch}".."${tab.worktree.branch}"`, repoRoot);
  const changedFiles = output ? output.split("\n").filter(Boolean).length : 0;
  return { isWorktree: true, changedFiles, canApply: changedFiles > 0 };
}

async function hasChanges(cwd: string): Promise<boolean> {
  const status = await git("status --porcelain", cwd);
  return status.length > 0;
}

async function commitIfDirty(cwd: string, message: string): Promise<void> {
  if (!(await hasChanges(cwd))) return;
  await git("add -A", cwd);
  await git(`-c user.email=herman@local -c user.name=Herman commit -m "${message}"`, cwd);
}

async function listConflicts(cwd: string): Promise<string[]> {
  const files = await git("diff --name-only --diff-filter=U", cwd);
  return files ? files.split("\n").filter(Boolean) : [];
}

async function useSessionVersionForConflicts(cwd: string, files: string[]): Promise<void> {
  for (const file of files) {
    await git(`checkout --theirs -- "${file}"`, cwd);
  }
}

function hasConflictMarkers(content: string): boolean {
  return content.includes("<<<<<<<") || content.includes("=======") || content.includes(">>>>>>>");
}

function clipText(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...<truncated>`;
}

function summarizeSnippet(label: string, content: string): string {
  const trimmed = content.trim();
  const firstLine = trimmed.split("\n").find((line) => line.trim().length > 0) ?? "(empty)";
  return `${label}: ${trimmed.length} chars, first line: ${firstLine.slice(0, 120)}`;
}

async function readStageFile(
  repoRoot: string,
  stage: 1 | 2 | 3,
  filePath: string,
): Promise<string | undefined> {
  try {
    // Stage slots during conflict: 1=base, 2=ours, 3=theirs
    return await git(`show ":${stage}:${filePath}"`, repoRoot);
  } catch {
    return undefined;
  }
}

async function buildConflictContext(repoRoot: string, conflictedFiles: string[]): Promise<string> {
  const sections: string[] = [];
  for (const filePath of conflictedFiles) {
    const [base, ours, theirs] = await Promise.all([
      readStageFile(repoRoot, 1, filePath),
      readStageFile(repoRoot, 2, filePath),
      readStageFile(repoRoot, 3, filePath),
    ]);
    const details = [
      `File: ${filePath}`,
      base ? summarizeSnippet("Base", base) : "Base: unavailable",
      ours ? summarizeSnippet("Ours(main)", ours) : "Ours(main): unavailable",
      theirs ? summarizeSnippet("Theirs(session)", theirs) : "Theirs(session): unavailable",
      "",
      "Ours snippet:",
      "```",
      clipText(ours ?? ""),
      "```",
      "",
      "Theirs snippet:",
      "```",
      clipText(theirs ?? ""),
      "```",
    ].join("\n");
    sections.push(details);
  }
  return sections.join("\n\n");
}

async function assertNoConflictMarkers(repoRoot: string, conflictedFiles: string[]): Promise<boolean> {
  for (const file of conflictedFiles) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    const content = await Bun.file(path).text();
    if (hasConflictMarkers(content)) return false;
  }
  return true;
}

function buildConflictPrompt(
  repoRoot: string,
  conflictedFiles: string[],
  contextByFile: string,
): string {
  const fileList = conflictedFiles.map((file) => `- ${file}`).join("\n");
  return [
    "You are resolving git merge conflicts for a rookie user.",
    `Repository root: ${repoRoot}`,
    "Conflicted files:",
    fileList,
    "",
    "Requirements:",
    "1) Resolve every conflict carefully and keep valid, working code.",
    "2) Remove all conflict markers (<<<<<<<, =======, >>>>>>>).",
    "3) Do not run git commit. Do not explain. Just edit files to resolve.",
    "4) Prefer preserving the user's intent from both sides when possible.",
    "5) Use the Base/Ours/Theirs context below to infer intent before editing.",
    "",
    "Conflict context per file:",
    contextByFile,
  ].join("\n");
}

async function resolveConflictsWithAgent(repoRoot: string, conflictedFiles: string[]): Promise<"resolved"> {
  const tempTabId = `merge-resolver-${Date.now()}`;
  const bridge = new AgentBridge(tempTabId, () => {}, () => {});
  try {
    const contextByFile = await buildConflictContext(repoRoot, conflictedFiles);
    await bridge.start(repoRoot);
    await bridge.sendCommand({
      type: "prompt",
      message: buildConflictPrompt(repoRoot, conflictedFiles, contextByFile),
    });
    const unresolved = await listConflicts(repoRoot);
    const hasMarkers = !(await assertNoConflictMarkers(repoRoot, conflictedFiles));
    if (unresolved.length > 0 || hasMarkers) {
      throw new Error("Agent did not fully resolve conflicts");
    }
    return "resolved";
  } catch (error) {
    logger.warning("Agent conflict resolution failed; using session version fallback", {
      repoRoot,
      error: error instanceof Error ? error.message : String(error),
      conflictedFiles,
    });
    await useSessionVersionForConflicts(repoRoot, conflictedFiles);
    return "resolved";
  } finally {
    await bridge.stop().catch(() => undefined);
  }
}

export async function applySessionToMainProject(tab: Pick<Tab, "id" | "worktree">): Promise<{ status: "applied" | "resolving" | "error"; error?: string }> {
  if (!tab.worktree) {
    return { status: "error", error: "Session is not a worktree" };
  }

  const worktreePath = join(homedir(), "Herman", ".worktrees", tab.id);
  const mainFolder = tab.worktree.mainFolderPath;
  const repoRoot = await getRepoRoot(mainFolder);

  try {
    await commitIfDirty(worktreePath, "Session changes");
    await commitIfDirty(mainFolder, "WIP before merge");
    await git(`merge --no-ff --no-commit "${tab.worktree.branch}"`, mainFolder);
    await git(`-c user.email=herman@local -c user.name=Herman commit -m "Merge ${tab.worktree.branch}"`, mainFolder);
    return { status: "applied" };
  } catch {
    const conflicts = await listConflicts(mainFolder);
    if (conflicts.length === 0) {
      await git("merge --abort", mainFolder).catch(() => undefined);
      return { status: "error", error: "Merge failed without conflict details" };
    }
    await resolveConflictsWithAgent(mainFolder, conflicts);
    await git("add -A", mainFolder);
    await git(
      `-c user.email=herman@local -c user.name=Herman commit -m "Merge ${tab.worktree.branch} (auto-resolved)"`,
      mainFolder,
    );
    logger.info("Conflicts auto-resolved with session version", { repoRoot, conflicts });
    return { status: "resolving" };
  }
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
