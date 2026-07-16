/**
 * Herman system prompt builder.
 *
 * Follows OpenCode's pattern: per-mode .md prompt files are loaded as strings
 * at build time (inlined by Bun) and composed with dynamic context at runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import normalPrompt from "./normal.md" with { type: "text" };
import rookiePrompt from "./rookie.md" with { type: "text" };

export type HermanMode = "normal" | "rookie";

export interface BuildPromptOptions {
  mode: HermanMode;
  /** Project working directory (for template guidance lookup). */
  cwd: string;
  /** Pi's auto-generated system prompt (to extract context files & skills). */
  originalPrompt: string;
}

/** Extract the `guidance` key from a herman.yaml file. */
function extractYamlGuidance(raw: string): string | undefined {
  try {
    const parsed = Bun.YAML.parse(raw) as Record<string, unknown> | undefined;
    if (parsed && typeof parsed.guidance === "string" && parsed.guidance.trim()) {
      return parsed.guidance.trim();
    }
  } catch {
    // Invalid YAML — skip
  }
  return undefined;
}

/** Extract the ## Guidance section from a HERMAN.md body. */
function extractGuidanceSection(raw: string): string | undefined {
  const bodyMatch = raw.match(/^---[\s\S]*?---\r?\n?([\s\S]*)$/);
  const body = bodyMatch?.[1] ?? raw;
  const lines = body.split(/\r?\n/);
  let capturing = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (/^##\s+/i.test(line)) {
      if (/^##\s+Guidance\s*$/i.test(line)) {
        capturing = true;
        continue;
      }
      if (capturing) break;
    }
    if (capturing) collected.push(line);
  }
  const content = collected.join("\n").trim();
  return content || undefined;
}

/** Load template-specific guidance from the project root. */
function loadTemplateGuidance(cwd: string): string | undefined {
  try {
    const yamlPath = join(cwd, "herman.yaml");
    if (existsSync(yamlPath)) {
      const raw = readFileSync(yamlPath, "utf-8");
      return extractYamlGuidance(raw);
    }

    const hermanMdPath = join(cwd, "HERMAN.md");
    if (existsSync(hermanMdPath)) {
      const raw = readFileSync(hermanMdPath, "utf-8");
      return extractGuidanceSection(raw);
    }
  } catch {
    // Manifest may not exist or be invalid — skip template hint
  }
  return undefined;
}

/**
 * Extract the `<project_context>` and `<available_skills>` blocks from pi's
 * auto-generated system prompt so we can re-append them after replacing the
 * base behavioral prompt.
 */
function extractPiSections(systemPrompt: string): string {
  const sections: string[] = [];

  // Extract <project_context>...</project_context>
  const ctxMatch = systemPrompt.match(/<project_context>[\s\S]*?<\/project_context>/);
  if (ctxMatch) sections.push(ctxMatch[0]);

  // Extract <available_skills>...</available_skills>
  const skillsMatch = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (skillsMatch) sections.push(skillsMatch[0]);

  // Extract the cwd line
  const cwdMatch = systemPrompt.match(/^Current working directory:.+$/m);
  if (cwdMatch) sections.push(cwdMatch[0]);

  return sections.join("\n\n");
}

/** Build the full system prompt for the given mode. */
export function buildPrompt(options: BuildPromptOptions): string {
  const { mode, cwd, originalPrompt } = options;

  const basePrompt = mode === "rookie" ? rookiePrompt : normalPrompt;
  const guidance = loadTemplateGuidance(cwd);
  const piSections = extractPiSections(originalPrompt);

  const parts = [basePrompt];

  if (guidance) {
    parts.push(`<template_instructions>\n${guidance}\n</template_instructions>`);
  }

  if (piSections) {
    parts.push(piSections);
  }

  return parts.join("\n\n");
}
