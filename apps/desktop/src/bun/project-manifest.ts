import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ProjectManifest = {
  devCommand: string;
  devPort: number;
  buildCommand: string;
  outputDir: string;
  deployTarget: string;
};

/**
 * Reads the herman.json manifest from a project directory.
 * Returns undefined if the file doesn't exist or is invalid.
 */
export async function readProjectManifest(
  folderPath: string,
): Promise<ProjectManifest | undefined> {
  try {
    const raw = await readFile(join(folderPath, "herman.json"), "utf-8");
    const parsed = JSON.parse(raw);

    // Validate required fields
    if (
      typeof parsed.devCommand !== "string" ||
      typeof parsed.devPort !== "number" ||
      typeof parsed.buildCommand !== "string" ||
      typeof parsed.outputDir !== "string"
    ) {
      return undefined;
    }

    return {
      devCommand: parsed.devCommand,
      devPort: parsed.devPort,
      buildCommand: parsed.buildCommand,
      outputDir: parsed.outputDir,
      deployTarget: parsed.deployTarget ?? "cloudflare-pages",
    };
  } catch {
    return undefined;
  }
}
