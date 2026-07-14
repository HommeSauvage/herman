import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import type { PiSessionSummary } from "../shared/rpc.js";
import { agentSessionsDir } from "./app-paths.js";

/**
 * Native-pi project → sessions mapping.
 *
 * Every pi session JSONL header records the cwd it was started in, so we can
 * list sessions per project directly via `SessionManager.list(cwd)` /
 * `listAll()` — no Herman-side state file required. This is the data layer
 * behind the `getProjectSessions` / `getAllPiSessions` RPCs.
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
 * List all pi sessions for a project folder (matches by cwd). Uses pi's native
 * `SessionManager.list(cwd, sessionDir)`, which reads session headers and
 * filters by cwd. Sessions without a cwd (legacy) are excluded.
 */
export async function listPiSessionsForProject(folderPath: string): Promise<PiSessionSummary[]> {
  const sessionsDir = agentSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  const resolvedCwd = resolve(folderPath);
  const sessions = await SessionManager.list(resolvedCwd, sessionsDir);
  return sessions.map(toSummary);
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
 * session headers (newest-project first).
 */
export async function getProjectFoldersFromPiSessions(): Promise<string[]> {
  const all = await listAllPiSessions();
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const s of all) {
    if (!s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    folders.push(s.cwd);
  }
  return folders;
}
