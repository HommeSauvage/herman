import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  cleanupAllTestTempDirs,
  createTestTempDir,
  removeTestTempDir,
} from "./temp-dir.js";

describe("temp-dir helpers", () => {
  afterAll(() => {
    cleanupAllTestTempDirs();
  });

  it("creates directories under test/.tmp and removes them", () => {
    const dir = createTestTempDir("herman-temp-dir-test-");
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(join(import.meta.dir, "..", ".tmp"))).toBe(true);
    removeTestTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
