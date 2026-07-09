import { getLogger } from "@logtape/logtape";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

import type { TemplateManifest } from "../shared/templates.js";

const logger = getLogger(["herman-desktop", "templates"]);

/**
 * Resolves the templates directory path.
 * In the production bundle: app/bun/index.js → ../templates
 * In local dev from apps/desktop/src/bun: go up to apps/desktop/templates
 */
export function getTemplatesDir(): string {
  // Production bundle: app/bun/index.js → app/templates
  const bundledPath = resolve(import.meta.dir, "..", "templates");
  if (existsSync(bundledPath)) return bundledPath;

  // Local dev from apps/desktop/src/bun → apps/desktop/templates
  const devPath = resolve(import.meta.dir, "..", "..", "templates");
  return devPath;
}

/**
 * Loads all template manifests from the templates directory.
 * Each template lives in its own subdirectory with a template.json manifest.
 */
export async function loadTemplates(): Promise<TemplateManifest[]> {
  const templatesDir = getTemplatesDir();
  logger.debug("Loading templates", { templatesDir });
  let entries: string[] = [];

  try {
    entries = await readdir(templatesDir, { withFileTypes: true }).then((dirents) =>
      dirents.filter((d) => d.isDirectory()).map((d) => d.name),
    );
    logger.debug("Found template directories", { entries });
  } catch (err) {
    logger.error("Failed to read templates directory", {
      templatesDir,
      error: err instanceof Error ? err.message : String(err),
    });
    // Templates directory doesn't exist or isn't readable
    return [];
  }

  const manifests: TemplateManifest[] = [];

  for (const entry of entries) {
    try {
      const manifestPath = join(templatesDir, entry, "template.json");
      const raw = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as TemplateManifest;
      manifests.push(manifest);
    } catch {
      // Skip templates with missing or invalid manifests
      continue;
    }
  }

  return manifests;
}

/**
 * Returns the full path to a template's source directory, for copying into
 * a new project folder.
 */
export function getTemplateSourceDir(templateId: string): string {
  return join(getTemplatesDir(), templateId);
}
