import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTestTempDir, removeTestTempDir } from "../helpers/temp-dir.js";
import {
  HERMAN_DOCS_DIR,
  STATIC_ROOKIE_DOCS,
  listProjectDocs,
  seedStaticRookieDocs,
  validateDocsOutputs,
} from "../../src/bun/rookie-docs.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-rookie-docs-");
});

afterEach(() => {
  removeTestTempDir(tempDir);
});

function docsDir(projectPath: string = tempDir): string {
  return join(projectPath, HERMAN_DOCS_DIR);
}

describe("seedStaticRookieDocs", () => {
  it("copies the 3 seed files into <project>/herman-docs/", async () => {
    await seedStaticRookieDocs(tempDir);

    for (const name of STATIC_ROOKIE_DOCS) {
      const target = join(docsDir(), name);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8").length).toBeGreaterThan(0);
    }
  });

  it("does not overwrite existing files on a second call", async () => {
    await seedStaticRookieDocs(tempDir);

    const custom = join(docsDir(), "database.md");
    writeFileSync(custom, "# Custom database doc\n");

    await seedStaticRookieDocs(tempDir);
    expect(readFileSync(custom, "utf-8")).toBe("# Custom database doc\n");
  });
});

describe("listProjectDocs", () => {
  it("returns [] when the docs folder is missing", async () => {
    expect(await listProjectDocs(tempDir)).toEqual([]);
  });

  it("sorts by numeric prefix (02-x before 10-y), unprefixed last", async () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "10-publishing.md"), "# Publishing\n");
    writeFileSync(join(docsDir(), "02-start-here.md"), "# Start Here\n");
    writeFileSync(join(docsDir(), "appendix.md"), "# Appendix\n");

    const docs = await listProjectDocs(tempDir);
    expect(docs.map((d) => d.fileName)).toEqual([
      "02-start-here.md",
      "10-publishing.md",
      "appendix.md",
    ]);
  });

  it("uses the first '# ' heading as the title", async () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "01-start-here.md"), "intro line\n# Start Here\n\nbody\n");

    const docs = await listProjectDocs(tempDir);
    expect(docs[0]?.title).toBe("Start Here");
    expect(docs[0]?.content).toContain("body");
  });

  it("falls back to a humanized file name when no H1 exists", async () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "03-adding-features.md"), "no heading here\n");

    const docs = await listProjectDocs(tempDir);
    expect(docs[0]?.title).toBe("Adding Features");
  });

  it("ignores non-markdown files and directories named like docs", async () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "01-start-here.md"), "# Start Here\n");
    writeFileSync(join(docsDir(), "notes.txt"), "not a doc\n");
    mkdirSync(join(docsDir(), "02-fake.md"), { recursive: true });

    const docs = await listProjectDocs(tempDir);
    expect(docs.map((d) => d.fileName)).toEqual(["01-start-here.md"]);
  });
});

describe("validateDocsOutputs", () => {
  it("returns an error when the project path is missing", () => {
    expect(validateDocsOutputs("")).toMatch(/projectPath is missing/);
  });

  it("returns an error when the docs folder is missing", () => {
    expect(validateDocsOutputs(tempDir)).toMatch(/folder is missing/);
  });

  it("returns an error when there are no markdown docs", () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "notes.txt"), "hi\n");
    expect(validateDocsOutputs(tempDir)).toMatch(/no markdown docs/);
  });

  it("returns an error when no Start Here doc exists", () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "02-database.md"), "# Database\n");
    expect(validateDocsOutputs(tempDir)).toMatch(/Start Here/);
  });

  it("rejects a start-here directory (not a file)", () => {
    mkdirSync(join(docsDir(), "01-start-here.md"), { recursive: true });
    expect(validateDocsOutputs(tempDir)).toMatch(/no markdown docs/);
  });

  it("accepts a folder with a prefixed start-here doc", () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "01-start-here.md"), "# Start Here\n");
    expect(validateDocsOutputs(tempDir)).toBeUndefined();
  });

  it("accepts an unprefixed start-here doc", () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "start-here.md"), "# Start Here\n");
    expect(validateDocsOutputs(tempDir)).toBeUndefined();
  });
});
