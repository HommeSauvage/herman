import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import { parseFrontmatter } from "./frontmatter.js";

const logger = getLogger(["herman-desktop", "prompt-templates"]);

export type PromptTemplateInfo = {
  /** Template name (filename without .md). */
  name: string;
  /** Short description from frontmatter or first line. */
  description: string;
  /** Argument hint from frontmatter (e.g. "<file>"). */
  argumentHint?: string;
  /** Absolute path to the .md file. */
  filePath: string;
  /** Where the template came from. */
  source: "global" | "project";
};

function loadTemplateFromFile(
  filePath: string,
  source: PromptTemplateInfo["source"],
): PromptTemplateInfo | null {
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(rawContent);

    const name = basename(filePath).replace(/\.md$/, "");

    let description = frontmatter.description || "";
    if (!description) {
      const firstLine = body.split("\n").find((line) => line.trim());
      if (firstLine) {
        description = firstLine.slice(0, 60);
        if (firstLine.length > 60) description += "...";
      }
    }

    return {
      name,
      description,
      ...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
      filePath,
      source,
    };
  } catch (error) {
    logger.warning("Failed to load prompt template file", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(
  dir: string,
  source: PromptTemplateInfo["source"],
): PromptTemplateInfo[] {
  const templates: PromptTemplateInfo[] = [];
  if (!existsSync(dir)) return templates;

  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return templates;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        continue;
      }
    }

    if (isFile && entry.name.endsWith(".md")) {
      const template = loadTemplateFromFile(fullPath, source);
      if (template) templates.push(template);
    }
  }

  return templates;
}

/**
 * Get the global pi prompts directory.
 */
function getGlobalPromptsDir(): string {
  // pi uses ~/.pi/agent/prompts/ as the global prompts directory
  return resolve(
    process.platform === "win32"
      ? join(process.env.USERPROFILE ?? "", ".pi", "agent", "prompts")
      : join(process.env.HOME ?? "/", ".pi", "agent", "prompts"),
  );
}

/**
 * List all available prompt templates from:
 * 1. Global: ~/.pi/agent/prompts/*.md
 * 2. Project: <projectDir>/.pi/prompts/*.md
 *
 * Deduplicates by name (project templates override global).
 */
export function listAllPromptTemplates(projectDir?: string): PromptTemplateInfo[] {
  const templateMap = new Map<string, PromptTemplateInfo>();

  // Global templates (lower priority)
  for (const template of loadTemplatesFromDir(getGlobalPromptsDir(), "global")) {
    if (!templateMap.has(template.name)) {
      templateMap.set(template.name, template);
    }
  }

  // Project templates (higher priority)
  if (projectDir) {
    const projectPromptsDir = join(projectDir, ".pi", "prompts");
    for (const template of loadTemplatesFromDir(projectPromptsDir, "project")) {
      // Project templates override global ones with the same name
      templateMap.set(template.name, template);
    }
  }

  return Array.from(templateMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
