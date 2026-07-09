import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Lives outside the repo so git-based helpers (e.g. project-files) behave correctly. */
const testTmpRoot = join(tmpdir(), "herman-desktop-tests");
const activeDirs = new Set<string>();

function ensureTestTmpRoot(): string {
  if (!existsSync(testTmpRoot)) {
    mkdirSync(testTmpRoot, { recursive: true });
  }
  return testTmpRoot;
}

/** Create a unique temp directory for a test run. Always cleaned up by the caller. */
export function createTestTempDir(prefix: string): string {
  const dir = mkdtempSync(join(ensureTestTmpRoot(), prefix));
  activeDirs.add(dir);
  return dir;
}

/** Remove a temp directory created by {@link createTestTempDir}. */
export function removeTestTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  activeDirs.delete(dir);
}

/** Remove any leftover temp dirs from failed or interrupted test runs. */
export function cleanupAllTestTempDirs(): void {
  for (const dir of activeDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  activeDirs.clear();
  if (existsSync(testTmpRoot)) {
    rmSync(testTmpRoot, { recursive: true, force: true });
  }
}

export function setHermantAppDir(tempDir: string): void {
  process.env.HERMAN_APP_DIR = tempDir;
}

export function clearHermantAppDir(tempDir: string, previousValue?: string): void {
  removeTestTempDir(tempDir);
  if (previousValue === undefined) {
    delete process.env.HERMAN_APP_DIR;
  } else {
    process.env.HERMAN_APP_DIR = previousValue;
  }
}
