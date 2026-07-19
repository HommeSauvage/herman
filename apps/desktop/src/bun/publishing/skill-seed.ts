import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import { bundledAssetDir, skillsDir } from "../app-paths.js";

const logger = getLogger(["herman-desktop", "publishing", "skill-seed"]);

const SKILL_NAME = "coolify-ops";
const STAMP_FILE = ".herman-seed-hash";

/** Files at the skill root that are repo metadata, not skill content. */
const EXCLUDED_ROOT_FILES = new Set(["hero.svg", "README.md", "README.zh-CN.md", "LICENSE"]);

function getBundledSkillDir(): string {
  return join(bundledAssetDir("bundled-skills"), SKILL_NAME);
}

/**
 * Content hash of the bundled skill's entry point. Used to detect upstream
 * skill updates shipped with a new app version so the seed is refreshed
 * (a plain "exists → skip" check would pin stale copies forever).
 */
function bundledSkillHash(source: string): string {
  return createHash("sha256")
    .update(readFileSync(join(source, "SKILL.md"), "utf-8"))
    .digest("hex");
}

async function copySkill(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(source, entry.name);
    const dest = join(target, entry.name);
    if (entry.isDirectory()) {
      await cp(src, dest, { recursive: true });
    } else if (entry.isFile() && !EXCLUDED_ROOT_FILES.has(entry.name)) {
      await cp(src, dest);
    }
  }
}

async function doSeed(): Promise<void> {
  const source = getBundledSkillDir();
  if (!existsSync(join(source, "SKILL.md"))) {
    logger.warning("Bundled coolify-ops skill not found", { source });
    return;
  }

  const target = join(skillsDir(), SKILL_NAME);
  const hash = bundledSkillHash(source);

  // Up to date → nothing to do.
  if (existsSync(join(target, "SKILL.md")) && existsSync(join(target, STAMP_FILE))) {
    try {
      if (readFileSync(join(target, STAMP_FILE), "utf-8").trim() === hash) {
        return;
      }
    } catch {
      // fall through to re-seed
    }
  }

  try {
    // Clean re-seed: the target is app-managed, so replace it wholesale to
    // drop files removed upstream.
    rmSync(target, { recursive: true, force: true });
    await copySkill(source, target);
    await Bun.write(join(target, STAMP_FILE), `${hash}\n`);
    logger.info("Seeded coolify-ops skill", { target });
  } catch (error) {
    logger.warning("Failed to seed coolify-ops skill", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Seed the bundled coolify-ops skill into the agent skills directory.
 * Idempotent and cheap: when the hash stamp matches, this is two filesystem
 * reads. Re-seeds automatically when the bundled skill changes. Callers
 * (agent config sync) are single-flight, so no concurrency guard is needed.
 */
export function seedCoolifyOpsSkill(): Promise<void> {
  return doSeed();
}
