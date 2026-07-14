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

function newestSessionFile(sessionsDir: string): string | undefined {
  const files = listSessionJsonlFiles(sessionsDir);
  return files[0] ? join(sessionsDir, files[0]) : undefined;
}

/**
 * Resolve the pi session JSONL file for a tab.
 * Prefers a persisted session id, then falls back to the newest JSONL on disk.
 */
export function resolvePiSessionFile(piSessionId?: string): string | undefined {
  const sessionsDir = piSessionDir();
  if (piSessionId) {
    const byId = resolvePiSessionFileById(sessionsDir, piSessionId);
    if (byId) return byId;
  }
  return newestSessionFile(sessionsDir);
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
 * Prefers a persisted session id, then falls back to the newest JSONL on disk.
 */
export function resolvePiSessionResumeArg(agentDir: string, piSessionId?: string): string | undefined {
  const sessionsDir = join(agentDir, "sessions");

  if (piSessionId) {
    const byId = resolvePiSessionFileById(sessionsDir, piSessionId);
    if (byId) return byId;
  }

  const newest = newestSessionFile(sessionsDir);
  if (newest) return newest;

  return piSessionId;
}
