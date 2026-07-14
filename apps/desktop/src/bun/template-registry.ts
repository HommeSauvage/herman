import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import type {
  GalleryTemplate,
  ParsedHermanManifest,
  ResolvedManifest,
} from "../shared/herman-manifest.js";
import {
  mergeFrontmatter,
  mergeSections,
  parseHermanMd,
  serializeHermanMd,
} from "./herman-md.js";

const logger = getLogger(["herman-desktop", "template-registry"]);

const MAX_EXTENDS_DEPTH = 5;

/**
 * Resolves the curated templates directory.
 * Production: app/bun/index.js → ../templates
 * Local dev: apps/desktop/src/bun → ../../templates
 */
export function getTemplatesDir(): string {
  const bundledPath = resolve(import.meta.dir, "..", "templates");
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(import.meta.dir, "..", "..", "templates");
}

let cache: Map<string, ParsedHermanManifest> | null = null;

function manifestIdFromFilename(filename: string): string | null {
  const match = filename.match(/^(.+)\.HERMAN\.md$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

async function loadAllManifests(): Promise<Map<string, ParsedHermanManifest>> {
  if (cache) return cache;

  const dir = getTemplatesDir();
  const map = new Map<string, ParsedHermanManifest>();

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch (error) {
    logger.error("Failed to read templates directory", {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    cache = map;
    return map;
  }

  for (const entry of entries) {
    const id = manifestIdFromFilename(entry);
    if (!id) continue;
    try {
      const raw = await readFile(join(dir, entry), "utf-8");
      const parsed = parseHermanMd(raw, id);
      map.set(id, parsed);
    } catch (error) {
      logger.error("Failed to parse template manifest", {
        entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  cache = map;
  return map;
}

/** Clear the in-memory registry cache (useful in tests). */
export function clearTemplateRegistryCache(): void {
  cache = null;
}

export async function getParsedManifest(id: string): Promise<ParsedHermanManifest | undefined> {
  const all = await loadAllManifests();
  return all.get(id.toLowerCase());
}

/**
 * Resolve a template by id, flattening the `extends` chain.
 * The result is self-contained (no `extends`) and ready to write into a project.
 */
export async function resolveTemplateManifest(id: string): Promise<ResolvedManifest> {
  const all = await loadAllManifests();
  const visited = new Set<string>();
  const chain: ParsedHermanManifest[] = [];

  let currentId: string | undefined = id.toLowerCase();
  let depth = 0;

  while (currentId) {
    if (depth > MAX_EXTENDS_DEPTH) {
      throw new Error(`Template "${id}" exceeds max extends depth of ${MAX_EXTENDS_DEPTH}`);
    }
    if (visited.has(currentId)) {
      throw new Error(`Template "${id}" has a cyclic extends chain at "${currentId}"`);
    }
    visited.add(currentId);

    const manifest = all.get(currentId);
    if (!manifest) {
      throw new Error(`Template "${currentId}" not found`);
    }
    chain.unshift(manifest);
    currentId = manifest.frontmatter.extends?.toLowerCase();
    depth += 1;
  }

  let frontmatter = chain[0]!.frontmatter;
  let sections = chain[0]!.sections;

  for (let i = 1; i < chain.length; i++) {
    const next = chain[i]!;
    frontmatter = mergeFrontmatter(frontmatter, next.frontmatter);
    sections = mergeSections(sections, next.sections);
  }

  // Ensure resolved output has no extends and keeps the leaf id's identity fields.
  const { extends: _e, ...rest } = frontmatter;
  const resolvedFm = { ...rest, version: frontmatter.version };
  const serialized = serializeHermanMd(resolvedFm, sections);

  return {
    id: id.toLowerCase(),
    frontmatter: resolvedFm,
    sections,
    serialized,
  };
}

/**
 * Gallery cards for templates that have a name and are intended for users.
 * Base-only manifests (category: base, or no name) are excluded from the gallery
 * unless they also define a user-facing name and are not only used as extends targets.
 * We show any manifest with a `name` that is not category "base".
 */
export async function getGalleryTemplates(): Promise<GalleryTemplate[]> {
  const all = await loadAllManifests();
  const cards: GalleryTemplate[] = [];

  for (const [id, manifest] of all) {
    const fm = manifest.frontmatter;
    if (!fm.name) continue;
    if (fm.category === "base") continue;

    let sourceRepo = fm.source?.repo;
    if (!sourceRepo && fm.extends) {
      try {
        const resolved = await resolveTemplateManifest(id);
        sourceRepo = resolved.frontmatter.source?.repo;
      } catch {
        // Skip cards that fail to resolve.
        continue;
      }
    }

    cards.push({
      id,
      name: fm.name,
      description: fm.description ?? "",
      suitableFor: fm.suitable_for,
      ...(fm.icon ? { icon: fm.icon } : {}),
      ...(fm.snapshot ? { snapshot: fm.snapshot } : {}),
      ...(fm.category ? { category: fm.category } : {}),
      ...(sourceRepo ? { sourceRepo } : {}),
    });
  }

  return cards.sort((a, b) => a.name.localeCompare(b.name));
}
