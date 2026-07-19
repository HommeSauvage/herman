import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import type { PiSessionSummary } from "../shared/rpc.js";
import { agentSessionsDir } from "./app-paths.js";
import { WorktreeIndex } from "./worktree.js";

/**
 * Native-pi project → sessions mapping.
 *
 * Every pi session JSONL header records the cwd it was started in, so we can
 * list sessions per project directly via `SessionManager.list(cwd)` /
 * `listAll()` — no Herman-side state file required. Sessions started inside
 * a session worktree are mapped back to their owning project via
 * {@link WorktreeIndex}.
 */

function toSummary(info: SessionInfo): PiSessionSummary {
  return {
    id: info.id,
    cwd: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    created: info.created.getTime(),
    modified: info.modified.getTime(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
  };
}

/**
 * List all pi sessions for a project folder. Matches sessions recorded
 * directly in the project root AND sessions recorded in any of the project's
 * session worktrees (resolved through the worktree index).
 */
export async function listPiSessionsForProject(
  folderPath: string,
  worktreeIndex?: WorktreeIndex,
): Promise<PiSessionSummary[]> {
  const sessionsDir = agentSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  const resolvedCwd = resolve(folderPath);
  const direct = await SessionManager.list(resolvedCwd, sessionsDir);
  if (!worktreeIndex) {
    return direct.map(toSummary);
  }

  const all = await SessionManager.listAll(sessionsDir);
  const directIds = new Set(direct.map((s) => s.id));
  const worktreeSessions = all.filter(
    (s) => !directIds.has(s.id) && worktreeIndex.projectRootFor(s.cwd) === resolvedCwd,
  );
  return [...direct, ...worktreeSessions]
    .map(toSummary)
    .sort((a, b) => b.modified - a.modified);
}

/**
 * List every pi session across all projects, newest first. Use this to derive
 * the project list (unique cwds) and to power a "all sessions" home view.
 */
export async function listAllPiSessions(): Promise<PiSessionSummary[]> {
  const sessionsDir = agentSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  const sessions = await SessionManager.listAll(sessionsDir);
  return sessions.map(toSummary);
}

/**
 * Unique project folder paths that have at least one pi session, derived from
 * session headers (newest-project first). Worktree directories are never
 * surfaced as projects.
 */
export async function getProjectFoldersFromPiSessions(): Promise<string[]> {
  const all = await listAllPiSessions();
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const s of all) {
    if (!s.cwd || seen.has(s.cwd)) continue;
    if (WorktreeIndex.isWorktreePath(s.cwd)) continue;
    seen.add(s.cwd);
    folders.push(s.cwd);
  }
  return folders;
}
