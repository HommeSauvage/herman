import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearHermantAppDir, createTestTempDir, setHermantAppDir } from "../helpers/temp-dir.js";

/**
 * Seeding copies the bundled coolify-ops skill into the agent skills dir
 * (~/.herman/agent/skills under the temp HERMAN_APP_DIR) and re-seeds when
 * the bundled source changes (hash stamp mismatch).
 */

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-skill-seed-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

async function importSeed() {
  return import("../../src/bun/publishing/skill-seed.js");
}

function targetDir(): string {
  return join(tempDir, "agent", "skills", "coolify-ops");
}

describe("seedCoolifyOpsSkill", () => {
  it("copies the skill into the agent skills dir with a hash stamp", async () => {
    const { seedCoolifyOpsSkill } = await importSeed();
    await seedCoolifyOpsSkill();

    const target = targetDir();
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".herman-seed-hash"))).toBe(true);

    // Directories come along…
    expect(existsSync(join(target, "scripts"))).toBe(true);
    expect(existsSync(join(target, "references"))).toBe(true);

    // …but repo metadata files are excluded.
    expect(existsSync(join(target, "README.md"))).toBe(false);
    expect(existsSync(join(target, "LICENSE"))).toBe(false);
    expect(existsSync(join(target, "hero.svg"))).toBe(false);

    // The Herman integration section is part of the seeded skill.
    const skill = readFileSync(join(target, "SKILL.md"), "utf-8");
    expect(skill).toContain("Herman integration");
    expect(skill).toContain("herman_get_publishing_config");
  });

  it("is a no-op when the stamp matches (does not overwrite local edits)", async () => {
    const { seedCoolifyOpsSkill } = await importSeed();
    await seedCoolifyOpsSkill();

    const marker = join(targetDir(), "SKILL.md");
    writeFileSync(marker, "local edit");

    await seedCoolifyOpsSkill();
    expect(readFileSync(marker, "utf-8")).toBe("local edit");
  });

  it("re-seeds when the stamp is missing or stale", async () => {
    const { seedCoolifyOpsSkill } = await importSeed();
    await seedCoolifyOpsSkill();

    const target = targetDir();
    writeFileSync(join(target, ".herman-seed-hash"), "stale-hash");
    writeFileSync(join(target, "SKILL.md"), "corrupted");
    writeFileSync(join(target, "stray-file.txt"), "should be removed");

    await seedCoolifyOpsSkill();

    const skill = readFileSync(join(target, "SKILL.md"), "utf-8");
    expect(skill).toContain("Herman integration"); // restored from source
    expect(existsSync(join(target, "stray-file.txt"))).toBe(false); // cleaned
  });
});
