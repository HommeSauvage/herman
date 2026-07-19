import { existsSync } from "node:fs";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import type {
  HermanFrontmatter,
  ProjectManifestView,
  ResolvedManifest,
} from "../shared/herman-manifest.js";
import { HermanYamlSchema, isV1Manifest, migrateV1Manifest } from "../shared/herman-manifest.js";
import { dumpFrontmatterYaml, parseHermanMd, yamlString } from "./herman-md.js";
import { initProjectRepo } from "./worktree.js";

const logger = getLogger(["herman-desktop", "project-manifest"]);

/** Map a parsed v2 manifest shape (yaml or frontmatter) to the renderer view. */
function toManifestView(parsed: {
  name?: string;
  description?: string;
  env?: HermanFrontmatter["env"];
  setup?: HermanFrontmatter["setup"];
  servers?: HermanFrontmatter["servers"];
  guidance?: string;
  requirements?: HermanFrontmatter["requirements"];
}): ProjectManifestView {
  const servers = parsed.servers ?? [];
  const primary = servers.find((s) => s.primary) ?? (servers.length > 0 ? servers[0] : undefined);
  return {
    servers,
    ...(primary ? { primary } : {}),
    ...(parsed.setup?.length ? { setup: parsed.setup } : {}),
    ...(parsed.env ? { env: parsed.env } : {}),
    ...(parsed.guidance ? { guidance: parsed.guidance } : {}),
    ...(parsed.requirements?.length ? { requirements: parsed.requirements } : {}),
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(primary
      ? {
          devCommand: primary.command,
          ...(primary.port != null ? { devPort: primary.port } : {}),
        }
      : {}),
  };
}

/**
 * Reads the project's root herman.yaml first, then falls back to
 * HERMAN.md. Returns undefined if neither exists / is valid.
 * v1 manifests are migrated to v2 on read.
 */
export async function readProjectManifest(
  folderPath: string,
  projectRoot?: string,
): Promise<ProjectManifestView | undefined> {
  const candidateRoots = [folderPath];
  if (projectRoot && projectRoot !== folderPath) {
    candidateRoots.push(projectRoot);
  }

  for (const root of candidateRoots) {
    // 1. herman.yaml — pure-YAML format (already resolved, no extends)
    const yamlPath = join(root, "herman.yaml");
    if (existsSync(yamlPath)) {
      try {
        return await readHermanYaml(yamlPath);
      } catch (error) {
        logger.warning("Failed to read herman.yaml, falling back to HERMAN.md", {
          folderPath: root,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 2. HERMAN.md — original format (may have extends; v1 shimmed at parse)
    const hermanMdPath = join(root, "HERMAN.md");
    if (existsSync(hermanMdPath)) {
      try {
        const raw = await readFile(hermanMdPath, "utf-8");
        const parsed = parseHermanMd(raw, "project");
        return toManifestView({
          ...parsed.frontmatter,
          ...(parsed.sections.guidance ? { guidance: parsed.sections.guidance } : {}),
        });
      } catch (error) {
        logger.warning("Failed to read HERMAN.md", {
          folderPath: root,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return undefined;
}

/** Parse a herman.yaml file into a ProjectManifestView with zod validation. */
async function readHermanYaml(yamlPath: string): Promise<ProjectManifestView> {
  const raw = await readFile(yamlPath, "utf-8");
  const parsedRaw: unknown = Bun.YAML.parse(raw);
  const migrated = isV1Manifest(parsedRaw) ? migrateV1Manifest(parsedRaw) : parsedRaw;
  const parsed = HermanYamlSchema.parse(migrated);
  return toManifestView(parsed);
}

/**
 * Serialize a resolved manifest to herman.yaml (pure YAML, v2).
 * Strips wizard-only fields (setup_goal, extends, template metadata) and
 * embeds guidance as a YAML key instead of markdown.
 */
export function serializeHermanYaml(manifest: ResolvedManifest): string {
  const fm = manifest.frontmatter;

  // Build a clean frontmatter with only the runtime fields.
  // dumpFrontmatterYaml shares the same YAML standard.
  const cleaned: Omit<HermanFrontmatter, "extends"> = {
    version: fm.version,
    ...(fm.name != null ? { name: fm.name } : {}),
    ...(fm.description != null ? { description: fm.description } : {}),
    ...(fm.env ? { env: fm.env } : {}),
    ...(fm.setup?.length ? { setup: fm.setup } : {}),
    ...(fm.servers?.length ? { servers: fm.servers } : {}),
    ...(fm.requirements?.length ? { requirements: fm.requirements } : {}),
  };

  let yaml = `${dumpFrontmatterYaml(cleaned)}\n`;

  // Append guidance as a YAML key (not a markdown section).
  const guidance = manifest.sections.guidance?.trim();
  if (guidance) {
    if (!guidance.includes("\n")) {
      yaml += `guidance: ${yamlString(guidance)}\n`;
    } else {
      yaml += "guidance: |\n";
      for (const line of guidance.split("\n")) {
        yaml += `  ${line}\n`;
      }
    }
  }

  return yaml;
}

/**
 * Set up a fresh git repository for a wizard-created project.
 *
 * 1. Writes the resolved herman.yaml.
 * 2. Removes old HERMAN.md if present.
 * 3. Removes any existing .git (from cloned template repo).
 * 4. Initializes a new git repo and commits all files.
 */
export async function setupProjectRepo(
  projectPath: string,
  manifest: ResolvedManifest,
): Promise<void> {
  // 1. Write herman.yaml first (safest step — no destructive action yet).
  const yaml = serializeHermanYaml(manifest);
  await writeFile(join(projectPath, "herman.yaml"), yaml, "utf-8");

  // 2. Remove old HERMAN.md if present (replaced by herman.yaml).
  const oldHermanMd = join(projectPath, "HERMAN.md");
  if (existsSync(oldHermanMd)) {
    await unlink(oldHermanMd);
  }

  // 3. Remove old .git from the cloned template.
  const gitDir = join(projectPath, ".git");
  if (existsSync(gitDir)) {
    await rm(gitDir, { recursive: true, force: true });
  }

  // 4. Initialize new git repo and commit everything (includes herman.yaml).
  try {
    await initProjectRepo(projectPath);
  } catch (error) {
    // herman.yaml is already written — the project is still usable even
    // without a git repo.  Log and continue so the wizard handoff succeeds.
    logger.warning("Failed to initialize project git repository", {
      projectPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
