import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Lives outside the repo so git-based helpers (e.g. project-files) behave correctly. */
const testTmpRoot = join(tmpdir(), "herman-desktop-tests");
const activeDirs = new Set<string>();

/**
 * Process-wide fallback for HERMAN_APP_DIR. Several app modules persist state
 * fire-and-forget (debounced window-state writes, unawaited saves) that can
 * land AFTER a test's afterEach cleared the env var — writing into the real
 * ~/.herman and corrupting the developer's actual app state. Keeping
 * HERMAN_APP_DIR always set during a test run makes that impossible.
 */
let fallbackAppDir: string | undefined;

function fallbackTestAppDir(): string {
  if (!fallbackAppDir) {
    fallbackAppDir = mkdtempSync(join(ensureTestTmpRoot(), "herman-appdir-fallback-"));
    activeDirs.add(fallbackAppDir);
  }
  return fallbackAppDir;
}

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
  // Never leave HERMAN_APP_DIR unset mid-run (see fallbackTestAppDir).
  process.env.HERMAN_APP_DIR = previousValue ?? fallbackTestAppDir();
}
