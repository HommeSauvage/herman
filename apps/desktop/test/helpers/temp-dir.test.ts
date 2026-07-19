import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupAllTestTempDirs, createTestTempDir, removeTestTempDir } from "./temp-dir.js";

describe("temp-dir helpers", () => {
  afterAll(() => {
    cleanupAllTestTempDirs();
  });

  it("creates directories under the OS temp folder and removes them", () => {
    const dir = createTestTempDir("herman-temp-dir-test-");
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(join(tmpdir(), "herman-desktop-tests"))).toBe(true);
    removeTestTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
