import { getLogger } from "@logtape/logtape";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { EnvConfig, EnvVar } from "../shared/herman-manifest.js";

const logger = getLogger(["herman-desktop", "project-env"]);

export type EnvWriteInput = {
  /** Values collected from the wizard (key -> value). Skipped keys omitted. */
  collected: Record<string, string>;
  /** Keys the user explicitly skipped. */
  skipped?: string[];
};

/**
 * Run a generate command and return trimmed stdout.
 */
export async function runGenerateCommand(command: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`generate command failed (exit ${code}): ${command}`);
  }
  return stdout.trim();
}

/**
 * Resolve final env values: collected > generate > default.
 * Skipped keys are omitted (and generate is not run for them unless required+generate).
 * Auto-generate still runs for vars with `generate` that were not skipped and have no collected value.
 */
export async function resolveEnvValues(
  env: EnvConfig | undefined,
  input: EnvWriteInput,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const skipped = new Set(input.skipped ?? []);
  const vars = env?.vars ?? [];

  for (const v of vars) {
    if (skipped.has(v.key)) continue;

    const collected = input.collected[v.key];
    if (collected != null && collected.trim() !== "") {
      result[v.key] = collected.trim();
      continue;
    }

    if (v.generate) {
      try {
        result[v.key] = await runGenerateCommand(v.generate);
        continue;
      } catch (error) {
        logger.warning("Failed to generate env value", {
          key: v.key,
          error: error instanceof Error ? error.message : String(error),
        });
        if (v.default != null) {
          result[v.key] = v.default;
        }
        continue;
      }
    }

    if (v.default != null) {
      result[v.key] = v.default;
    }
  }

  return result;
}

/**
 * Write env values into the configured file(s). Merges with existing content.
 */
export async function writeProjectEnv(
  projectPath: string,
  env: EnvConfig | undefined,
  values: Record<string, string>,
): Promise<void> {
  if (!env?.vars?.length || Object.keys(values).length === 0) return;

  const defaultFile = env.file ?? ".env";
  const byFile = new Map<string, Record<string, string>>();

  for (const v of env.vars) {
    const value = values[v.key];
    if (value == null) continue;
    const file = v.file ?? defaultFile;
    const bucket = byFile.get(file) ?? {};
    bucket[v.key] = value;
    byFile.set(file, bucket);
  }

  for (const [relPath, vars] of byFile) {
    const abs = resolve(projectPath, relPath);
    await mkdir(dirname(abs), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(abs, "utf-8");
    } catch {
      existing = "";
    }
    const next = mergeEnvFile(existing, vars);
    await writeFile(abs, next, "utf-8");
    logger.info("Wrote env file", { path: abs, keys: Object.keys(vars) });
  }
}

function mergeEnvFile(existing: string, vars: Record<string, string>): string {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) {
      const key = match[1]!;
      if (key in vars) {
        out.push(`${key}=${quoteEnvValue(vars[key]!)}`);
        seen.add(key);
        continue;
      }
    }
    out.push(line);
  }

  for (const [key, value] of Object.entries(vars)) {
    if (seen.has(key)) continue;
    out.push(`${key}=${quoteEnvValue(value)}`);
  }

  // Ensure trailing newline.
  const text = out.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function quoteEnvValue(value: string): string {
  if (/[\s#"']/.test(value) || value === "") {
    return JSON.stringify(value);
  }
  return value;
}

/** Vars the wizard should prompt for (required, no generate, not yet collected). */
export function envVarsNeedingUserInput(env: EnvConfig | undefined): EnvVar[] {
  return (env?.vars ?? []).filter((v) => v.required && !v.generate);
}
