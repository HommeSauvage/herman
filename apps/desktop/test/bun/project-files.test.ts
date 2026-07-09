import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { clearProjectFilesCache, findProjectFiles } from "../../src/bun/project-files.js";

describe("findProjectFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    clearProjectFilesCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "herman-project-files-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFiles(files: string[]) {
    for (const file of files) {
      const full = path.join(tmpDir, file);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, "");
    }
  }

  it("returns an empty list when no folder path is provided", async () => {
    const result = await findProjectFiles("", "foo");
    expect(result).toEqual([]);
  });

  it("returns a sample of files when the query is empty", async () => {
    await createFiles(["a.ts", "b.ts", "c.ts"]);
    const result = await findProjectFiles(tmpDir, "");
    expect(result).toHaveLength(3);
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result).toContain("c.ts");
  });

  it("fuzzy-matches project files", async () => {
    await createFiles(["src/components/button.tsx", "src/utils/button.test.ts", "README.md"]);
    const result = await findProjectFiles(tmpDir, "btn");
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toMatch(/button/);
  });

  it("includes directories when requested", async () => {
    await createFiles(["src/components/button.tsx"]);
    const result = await findProjectFiles(tmpDir, "components", true);
    expect(result).toContain("src/components/");
  });

  it("does not include directories by default", async () => {
    await createFiles(["src/components/button.tsx"]);
    const result = await findProjectFiles(tmpDir, "components");
    expect(result).not.toContain("src/components/");
  });
});
