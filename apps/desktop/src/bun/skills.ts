import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { SkillSearchResult } from "../shared/rpc.js";
import { skillsDir } from "./app-paths.js";
import { parseFrontmatter, type Frontmatter } from "./frontmatter.js";

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
  /** Whether the skill is currently disabled (excluded from agent prompts). */
  disabled?: boolean;
};

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
 * Merges with disabledSkills to set the disabled flag.
 */
export function listAllSkills(projectDir?: string, disabledSkills?: string[]): SkillInfo[] {
  const skillMap = new Map<string, SkillInfo>();
  const disabled = new Set(disabledSkills ?? []);

  // Desktop-managed skills take highest priority.
  for (const skill of scanSkillsDir(sd(), "herman", true)) {
    if (!skillMap.has(skill.name)) {
      skillMap.set(skill.name, { ...skill, disabled: disabled.has(skill.name) });
    }
  }

  // Global user skills (~/.agents/skills).
  const userDir = getUserSkillsDir();
  for (const skill of scanSkillsDir(userDir, "user", false)) {
    if (!skillMap.has(skill.name)) {
      skillMap.set(skill.name, { ...skill, disabled: disabled.has(skill.name) });
    }
  }

  // Project skills (.agents/skills).
  if (projectDir) {
    const projectSkillsDir = join(projectDir, ".agents", "skills");
    for (const skill of scanSkillsDir(projectSkillsDir, "project", false)) {
      if (!skillMap.has(skill.name)) {
        skillMap.set(skill.name, { ...skill, disabled: disabled.has(skill.name) });
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
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:[@-Z\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/**
 * Search for skills using the public `skills` registry CLI.
 * Converts terminal output into structured results.
 */
export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
  const proc = Bun.spawn(
    ["bun", "x", "skills", "find", query],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Failed to search skills");
  }

  const clean = stripAnsi(stdout);
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const results: SkillSearchResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match lines like: owner/repo@skill  1.9K installs
    const match = line.match(/^(\S+)\s+(.+\s+installs)$/);
    if (match && i + 1 < lines.length && lines[i + 1].startsWith("└ ")) {
      results.push({
        package: match[1],
        installs: match[2],
        url: lines[i + 1].replace(/^└\s+/, "").trim(),
      });
      i++;
    }
  }

  return results;
}

/**
 * Install a skill from a CLI command such as `npx skills add owner/repo@skill`.
 * Only `npx skills add <package>` or `bunx skills add <package>` commands are
 * supported. `npx` is converted to `bun x` on the fly and the skill is
 * installed globally so Herman can discover it in ~/.agents/skills.
 */
export async function installSkillFromCommand(command: string): Promise<{ path: string; name: string }> {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 4) {
    throw new Error("Invalid command. Expected: npx skills add <package>");
  }

  const [runner, tool, subcommand, ...rest] = tokens;
  if (tool !== "skills" || subcommand !== "add") {
    throw new Error("Only 'skills add' commands are supported");
  }
  if (runner !== "npx" && runner !== "bunx") {
    throw new Error("Only npx or bunx commands are supported");
  }

  const packageArg = rest[0];
  if (!packageArg) {
    throw new Error("Missing package argument");
  }

  const proc = Bun.spawn(
    ["bun", "x", "skills", "add", packageArg, "-g", "-y"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || "Failed to install skill");
  }

  const name = packageArg.split("/").pop()?.split("@").shift() || packageArg;
  return { path: join(getUserSkillsDir(), name), name };
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

/**
 * Enable or disable a skill by name. Returns the updated disabled skills list.
 * The caller should persist this and restart the agent.
 */
export function setSkillEnabled(
  name: string,
  enabled: boolean,
  currentDisabled: string[],
): string[] {
  if (enabled) {
    return currentDisabled.filter((n) => n !== name);
  }
  if (!currentDisabled.includes(name)) {
    return [...currentDisabled, name];
  }
  return currentDisabled;
}
