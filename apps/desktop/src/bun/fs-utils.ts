import { getLogger } from "@logtape/logtape";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { logStorageError } from "../logging-shared.js";

const logger = getLogger(["herman-desktop", "storage"]);

export function ensureDir(path: string) {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // directory may already exist
  }
}

export function writeFileAtomically(path: string, data: string, mode = 0o600) {
  const dir = dirname(path);
  ensureDir(dir);
  const tmpPath = join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    writeFileSync(tmpPath, data, { mode });
    try {
      chmodSync(tmpPath, mode);
    } catch {
      // ignore chmod failures (e.g., Windows)
    }
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp file may not exist
    }
    logStorageError(logger, "atomicWrite", path, error);
    throw error;
  }
}
