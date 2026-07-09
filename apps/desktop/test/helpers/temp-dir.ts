import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const testTmpRoot = join(import.meta.dir, "..", ".tmp");
const activeDirs = new Set<string>();

function ensureTestTmpRoot(): string {
  if (!existsSync(testTmpRoot)) {
    mkdirSync(testTmpRoot, { recursive: true });
  }
  return testTmpRoot;
}

/** Create a unique directory under the gitignored `test/.tmp/` folder. */
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

/** Remove any leftover temp dirs and the `test/.tmp/` root. */
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
