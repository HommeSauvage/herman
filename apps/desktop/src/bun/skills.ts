import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { getLogger } from "@logtape/logtape";

import { skillsDir } from "./app-paths.js";

const logger = getLogger(["herman-desktop", "skills"]);

function sd() {
  return skillsDir();
}

export type SkillInfo = {
  /** Skill name (from frontmatter `name` or parent directory name). */
  name: string;
  /** Short description from frontmatter. */
  description: string;
  /** Full path to the SKILL.md file. */
  filePath: string;
  /** Parent directory of the skill (baseDir in agent terms). */
  baseDir: string;
  /** Where the skill came from. */
  source: "herman" | "user" | "project";
};

type Frontmatter = {
  name?: string;
  description?: string;
  [key: string]: unknown;
};

function parseFrontmatter(rawContent: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  // Simple YAML parser for name and description only
  const frontmatter: Frontmatter = {};
  for (const line of yamlString.split("\n")) {
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      // Remove surrounding quotes
      const cleanValue = value.replace(/^['"](.*)['"]$/, "$1");
      frontmatter[key] = cleanValue;
    }
  }
  return { frontmatter, body };
}

function loadSkillFromFile(filePath: string, source: SkillInfo["source"]): SkillInfo | null {
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);
    const name = (frontmatter.name as string) || parentDirName;
    const description = (frontmatter.description as string) || "";
    if (!description.trim()) {
      return null;
    }
    return {
      name,
      description,
      filePath,
      baseDir: skillDir,
      source,
    };
  } catch (error) {
    logger.warning("Failed to load skill file", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Recursively scan a directory for SKILL.md files (Agent Skills standard).
 * - If a directory contains SKILL.md, treat it as a skill root and don't recurse further.
 * - Otherwise, check direct .md children and recurse into subdirectories.
 */
function scanSkillsDir(
  dir: string,
  source: SkillInfo["source"],
  includeRootFiles: boolean,
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!existsSync(dir)) return skills;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  // First pass: look for SKILL.md
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const fullPath = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;
    const skill = loadSkillFromFile(fullPath, source);
    if (skill) skills.push(skill);
    // Found SKILL.md — this is a skill root, don't recurse further
    return skills;
  }

  // Second pass: recurse into subdirectories, collect root .md files
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(fullPath);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      skills.push(...scanSkillsDir(fullPath, source, false));
    } else if (isFile && includeRootFiles && entry.name.endsWith(".md")) {
      const skill = loadSkillFromFile(fullPath, source);
      if (skill) skills.push(skill);
    }
  }

  return skills;
}

function getUserSkillsDir(): string {
  return resolve(
    process.platform === "win32"
      ? join(process.env.USERPROFILE ?? "", ".agents", "skills")
      : join(process.env.HOME ?? "/", ".agents", "skills"),
  );
}

/**
 * List all available skills from all configured directories.
 * Deduplicates by name (first found wins): herman > user > project.
 */
export function listAllSkills(projectDir?: string): SkillInfo[] {
  const skillMap = new Map<string, SkillInfo>();

  // Desktop-managed skills take highest priority.
  for (const skill of scanSkillsDir(sd(), "herman", true)) {
    if (!skillMap.has(skill.name)) {
      skillMap.set(skill.name, skill);
    }
  }

  // Global user skills (~/.agents/skills).
  const userDir = getUserSkillsDir();
  for (const skill of scanSkillsDir(userDir, "user", false)) {
    if (!skillMap.has(skill.name)) {
      skillMap.set(skill.name, skill);
    }
  }

  // Project skills (.agents/skills).
  if (projectDir) {
    const projectSkillsDir = join(projectDir, ".agents", "skills");
    for (const skill of scanSkillsDir(projectSkillsDir, "project", false)) {
      if (!skillMap.has(skill.name)) {
        skillMap.set(skill.name, skill);
      }
    }
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Install a skill by writing SKILL.md content to ~/.herman/skills/<name>/SKILL.md.
 */
export function installSkill(name: string, markdownContent: string): { path: string } {
  const skillDir = join(sd(), name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, markdownContent, "utf-8");
  logger.info("Installed skill", { name, path: skillPath });
  return { path: skillPath };
}

/**
 * Remove a skill from ~/.herman/skills/<name>/.
 */
export function removeSkill(name: string): boolean {
  const skillDir = join(sd(), name);
  if (!existsSync(skillDir)) return false;
  rmSync(skillDir, { recursive: true, force: true });
  logger.info("Removed skill", { name, path: skillDir });
  return true;
}

/**
 * Read the raw content of a SKILL.md file.
 */
export function readSkillContent(name: string): string | null {
  const skillPath = join(sd(), name, "SKILL.md");
  try {
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
}
