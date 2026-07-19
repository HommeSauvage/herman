import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { agentSessionsDir } from "./app-paths.js";

/** Shared directory where pi writes all session JSONL files (flat). */
export function piSessionDir(): string {
  return agentSessionsDir();
}

function listSessionJsonlFiles(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  try {
    return readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function resolvePiSessionFileById(sessionsDir: string, piSessionId: string): string | undefined {
  const match = listSessionJsonlFiles(sessionsDir).find((name) =>
    name.endsWith(`_${piSessionId}.jsonl`),
  );
  return match ? join(sessionsDir, match) : undefined;
}

/**
 * Resolve the pi session JSONL file for a tab.
 * Only returns a file when the exact piSessionId matches one on disk.
 */
export function resolvePiSessionFile(piSessionId?: string): string | undefined {
  const sessionsDir = piSessionDir();
  if (piSessionId) {
    const byId = resolvePiSessionFileById(sessionsDir, piSessionId);
    if (byId) return byId;
  }
  return undefined;
}

/**
 * Path to the pi session JSONL file for a tab, if any.
 * Session files are named `{timestamp}_{uuid}.jsonl`.
 */
export function readPiSessionFilePath(piSessionId?: string): string | undefined {
  return resolvePiSessionFile(piSessionId);
}

export function hasPiSessionFile(piSessionId?: string): boolean {
  return readPiSessionFilePath(piSessionId) !== undefined;
}

/** Delete the session JSONL file for a pi session id (tab close with no conversation). */
export function deletePiSessionFile(piSessionId?: string): void {
  if (!piSessionId) return;
  const file = resolvePiSessionFile(piSessionId);
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    // File may already be gone or locked; ignore.
  }
}

/** Extract the session UUID from a `{timestamp}_{uuid}.jsonl` file path. */
export function extractPiSessionIdFromFilePath(filePath: string): string | undefined {
  const name = filePath.split("/").pop() ?? "";
  if (!name.endsWith(".jsonl")) return undefined;

  const stem = name.slice(0, -".jsonl".length);
  const idx = stem.lastIndexOf("_");
  if (idx < 0) return undefined;

  const uuid = stem.slice(idx + 1);
  if (uuid.length < 20) return undefined;
  return uuid;
}

/**
 * Read the pi session id for a tab from the resolved session file.
 * Uses persisted id for file selection when provided.
 */
export function readPiSessionId(piSessionId?: string): string | undefined {
  const file = resolvePiSessionFile(piSessionId);
  return file ? extractPiSessionIdFromFilePath(file) : undefined;
}

/**
 * Resolve the `--session` CLI argument for pi.
 * Returns the session file path when an explicit piSessionId matches
 * a file on disk. Returns undefined otherwise (fresh session).
 */
export function resolvePiSessionResumeArg(
  agentDir: string,
  piSessionId?: string,
): string | undefined {
  if (!piSessionId) return undefined;

  const sessionsDir = join(agentDir, "sessions");
  const byId = resolvePiSessionFileById(sessionsDir, piSessionId);
  return byId;
}
