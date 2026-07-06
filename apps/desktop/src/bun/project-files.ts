import { readdir } from "node:fs/promises";
import path from "node:path";

import fuzzysort from "fuzzysort";

const CACHE_TTL_MS = 30_000;
const MAX_RESULTS = 50;
const MAX_WALK_FILES = 100_000;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".vercel",
  ".cache",
  "out",
  ".electrobun",
]);

type PreparedPath = ReturnType<typeof fuzzysort.prepare>;

type CacheEntry = {
  files: string[];
  directories: Set<string>;
  prepared: PreparedPath[];
  timestamp: number;
};

const cache = new Map<string, CacheEntry>();

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, "/");
}

function deriveDirectories(files: string[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    let slash = file.indexOf("/");
    while (slash !== -1) {
      directories.add(file.slice(0, slash + 1));
      slash = file.indexOf("/", slash + 1);
    }
  }
  return directories;
}

async function readGitFiles(folderPath: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "-C", folderPath, "ls-files", "--cached", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ls-files failed: ${stderr}`);
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function walkFiles(folderPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string) {
    if (files.length >= MAX_WALK_FILES) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (SKIP_DIRS.has(name)) continue;

      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        await visit(full);
        if (files.length >= MAX_WALK_FILES) return;
      } else if (entry.isFile()) {
        files.push(posixRelative(folderPath, full));
      }
    }
  }

  await visit(folderPath);
  return files;
}

async function listFiles(folderPath: string): Promise<string[]> {
  try {
    return await readGitFiles(folderPath);
  } catch {
    return walkFiles(folderPath);
  }
}

function getCacheKey(folderPath: string, includeDirectories: boolean): string {
  return `${folderPath}|${includeDirectories}`;
}

async function buildCacheEntry(
  folderPath: string,
  includeDirectories: boolean,
): Promise<CacheEntry> {
  const files = await listFiles(folderPath);
  const directories = includeDirectories ? deriveDirectories(files) : new Set<string>();
  const searchable = includeDirectories ? [...files, ...directories] : files;
  const prepared = searchable.map((p) => fuzzysort.prepare(p));

  return {
    files,
    directories,
    prepared,
    timestamp: Date.now(),
  };
}

async function getEntry(folderPath: string, includeDirectories: boolean): Promise<CacheEntry> {
  const key = getCacheKey(folderPath, includeDirectories);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.timestamp < CACHE_TTL_MS) {
    return existing;
  }

  const entry = await buildCacheEntry(folderPath, includeDirectories);
  cache.set(key, entry);
  return entry;
}

export function clearProjectFilesCache(): void {
  cache.clear();
}

export async function findProjectFiles(
  folderPath: string,
  query: string,
  includeDirectories = false,
): Promise<string[]> {
  if (!folderPath) return [];

  const trimmed = query.trim();
  const entry = await getEntry(folderPath, includeDirectories);

  if (!trimmed) {
    // Show a small sample of files when the user has typed "@" but nothing
    // else.
    return entry.files.slice(0, 10);
  }

  const results = fuzzysort.go(trimmed, entry.prepared, {
    threshold: -10000,
    limit: MAX_RESULTS,
  });

  return results.map((result) => result.target);
}
