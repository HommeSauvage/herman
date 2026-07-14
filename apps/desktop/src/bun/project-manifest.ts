import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DevServer,
  ProjectManifestView,
} from "../shared/herman-manifest.js";
import { parseHermanMd } from "./herman-md.js";

/**
 * Reads the project's root HERMAN.md (preferred) or legacy herman.json.
 * Returns undefined if neither exists / is valid.
 */
export async function readProjectManifest(
  folderPath: string,
): Promise<ProjectManifestView | undefined> {
  const hermanMdPath = join(folderPath, "HERMAN.md");
  if (existsSync(hermanMdPath)) {
    try {
      const raw = await readFile(hermanMdPath, "utf-8");
      const parsed = parseHermanMd(raw, "project");
      const servers = parsed.frontmatter.dev?.servers ?? [];
      const primary =
        servers.find((s) => s.primary) ?? (servers.length > 0 ? servers[0] : undefined);
      return {
        servers,
        primary,
        ...(parsed.frontmatter.dev?.install
          ? { install: parsed.frontmatter.dev.install }
          : {}),
        ...(parsed.sections.guidance ? { guidance: parsed.sections.guidance } : {}),
        ...(parsed.frontmatter.env ? { env: parsed.frontmatter.env } : {}),
        ...(parsed.frontmatter.requirements
          ? { requirements: parsed.frontmatter.requirements }
          : {}),
        ...(primary
          ? {
              devCommand: primary.command,
              ...(primary.port != null ? { devPort: primary.port } : {}),
            }
          : {}),
      };
    } catch {
      // Fall through to legacy herman.json
    }
  }

  return readLegacyHermanJson(folderPath);
}

async function readLegacyHermanJson(
  folderPath: string,
): Promise<ProjectManifestView | undefined> {
  try {
    const raw = await readFile(join(folderPath, "herman.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.devCommand === "string" && typeof parsed.devPort === "number") {
      const server: DevServer = {
        id: "web",
        label: "Website",
        command: parsed.devCommand,
        port: parsed.devPort,
        primary: true,
      };
      return {
        servers: [server],
        primary: server,
        devCommand: parsed.devCommand,
        devPort: parsed.devPort,
        ...(typeof parsed.buildCommand === "string"
          ? { buildCommand: parsed.buildCommand }
          : {}),
        ...(typeof parsed.outputDir === "string" ? { outputDir: parsed.outputDir } : {}),
        ...(typeof parsed.deployTarget === "string"
          ? { deployTarget: parsed.deployTarget }
          : {}),
        ...(typeof parsed.systemPromptHint === "string"
          ? { guidance: parsed.systemPromptHint }
          : {}),
      };
    }

    // Newer-shaped herman.json with servers array (if any old code wrote it).
    if (parsed.dev && typeof parsed.dev === "object") {
      const dev = parsed.dev as Record<string, unknown>;
      if (Array.isArray(dev.servers)) {
        const servers = dev.servers as DevServer[];
        const primary = servers.find((s) => s.primary) ?? servers[0];
        return {
          servers,
          primary,
          ...(typeof dev.install === "string" ? { install: dev.install } : {}),
          ...(primary
            ? {
                devCommand: primary.command,
                ...(primary.port != null ? { devPort: primary.port } : {}),
              }
            : {}),
        };
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}
