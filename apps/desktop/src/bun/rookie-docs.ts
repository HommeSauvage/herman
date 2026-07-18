import { existsSync, readdirSync, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { ProjectDoc } from "../shared/rpc.js";

const logger = getLogger(["herman-desktop", "rookie-docs"]);

/** Docs folder name inside every wizard-created project. */
export const HERMAN_DOCS_DIR = "herman-docs";

/** Static docs seeded verbatim into every project (order matches the docs-goal prompt). */
export const STATIC_ROOKIE_DOCS = [
  "notions-and-terminology.md",
  "herman-agent-quickstart.md",
  "database.md",
] as const;

const MAX_DOCS = 40;
const MAX_DOC_CHARS = 100_000;

/**
 * Resolves the bundled rookie-docs seed directory.
 * Production: app/bun/index.js → ../rookie-docs
 * Local dev: apps/desktop/src/bun → ../../rookie-docs
 */
export function getRookieDocsDir(): string {
  const bundledPath = resolve(import.meta.dir, "..", "rookie-docs");
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(import.meta.dir, "..", "..", "rookie-docs");
}

/**
 * Copy the static seed docs into <projectPath>/herman-docs/. Idempotent:
 * existing files are never overwritten (a retried docs phase may have
 * already renamed/extended them).
 */
export async function seedStaticRookieDocs(projectPath: string): Promise<void> {
  const source = getRookieDocsDir();
  const target = join(projectPath, HERMAN_DOCS_DIR);
  await mkdir(target, { recursive: true });
  for (const name of STATIC_ROOKIE_DOCS) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from)) {
      logger.warning("Rookie docs seed missing", { from });
      continue;
    }
    if (existsSync(to)) continue;
    await copyFile(from, to);
  }
}

/** Numeric-prefix sort: "02-x.md" < "10-y.md"; unprefixed files last, alphabetical. */
function docSortKey(fileName: string): { rank: number; name: string } {
  const match = fileName.match(/^(\d+)-/);
  return match
    ? { rank: Number.parseInt(match[1]!, 10), name: fileName }
    : { rank: Number.MAX_SAFE_INTEGER, name: fileName };
}

function humanizeFileName(fileName: string): string {
  return fileName
    .replace(/^\d+-/, "")
    .replace(/\.md$/i, "")
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** First "# " heading becomes the sidebar title; falls back to a humanized file name. */
export function extractDocTitle(fileName: string, content: string): string {
  for (const line of content.split("\n")) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match?.[1]) return match[1];
  }
  return humanizeFileName(fileName);
}

/**
 * Read every markdown doc in <projectPath>/herman-docs/ for the renderer
 * docs browser. Missing folder / unreadable files resolve to an empty list.
 */
export async function listProjectDocs(projectPath: string): Promise<ProjectDoc[]> {
  const dir = join(projectPath, HERMAN_DOCS_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => ({ file: e.name, key: docSortKey(e.name) }))
    .sort((a, b) => a.key.rank - b.key.rank || a.key.name.localeCompare(b.key.name))
    .slice(0, MAX_DOCS);

  const docs: ProjectDoc[] = [];
  for (const { file } of files) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const content = raw.length > MAX_DOC_CHARS ? raw.slice(0, MAX_DOC_CHARS) : raw;
      docs.push({ fileName: file, title: extractDocTitle(file, content), content });
    } catch (error) {
      logger.warning("Failed to read project doc", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return docs;
}

/**
 * Gate for docs-phase completion. Returns an agent-facing error message when
 * the docs are not ready (the wizard then waits for a corrected
 * herman_complete_wizard call); undefined when all good.
 */
export function validateDocsOutputs(projectPath: string): string | undefined {
  if (!projectPath) {
    return "Docs incomplete: projectPath is missing. Write the docs in <project>/herman-docs/ (including a Start Here doc), then call herman_complete_wizard again with the project path.";
  }
  const dir = join(projectPath, HERMAN_DOCS_DIR);
  if (!existsSync(dir)) {
    return `Docs incomplete: the ${HERMAN_DOCS_DIR}/ folder is missing in the project. Create it, write the docs (including a Start Here doc), then call herman_complete_wizard again.`;
  }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name);
  if (files.length === 0) {
    return `Docs incomplete: no markdown docs found in ${HERMAN_DOCS_DIR}/. Write the docs (including a Start Here doc), then call herman_complete_wizard again.`;
  }
  const hasStartHere = files.some((f) => /^(\d+-)?start-here\.md$/i.test(f));
  if (!hasStartHere) {
    return `Docs incomplete: missing the Start Here doc (e.g. ${HERMAN_DOCS_DIR}/01-start-here.md). Write it, then call herman_complete_wizard again.`;
  }
  return undefined;
}
