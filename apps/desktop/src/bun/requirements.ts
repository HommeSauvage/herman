import { getLogger } from "@logtape/logtape";

import type { Requirement, RequirementCheckResult } from "../shared/herman-manifest.js";

const logger = getLogger(["herman-desktop", "requirements"]);

/**
 * Run each requirement check command and return pass/fail results.
 */
export async function checkRequirements(
  requirements: Requirement[] | undefined,
): Promise<RequirementCheckResult[]> {
  if (!requirements?.length) return [];

  const results: RequirementCheckResult[] = [];
  for (const req of requirements) {
    try {
      const proc = Bun.spawn(["sh", "-c", req.check], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const ok = code === 0;
      results.push({
        id: req.id,
        label: req.label,
        ok,
        optional: Boolean(req.optional),
        ...(req.install ? { install: req.install } : {}),
        ...(req.why ? { why: req.why } : {}),
        ...(req.install_cmd ? { installCmd: req.install_cmd } : {}),
        detail: ok ? stdout.trim().slice(0, 200) : (stderr || stdout).trim().slice(0, 200),
      });
    } catch (error) {
      logger.warning("Requirement check threw", {
        id: req.id,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({
        id: req.id,
        label: req.label,
        ok: false,
        optional: Boolean(req.optional),
        ...(req.install ? { install: req.install } : {}),
        ...(req.why ? { why: req.why } : {}),
        ...(req.install_cmd ? { installCmd: req.install_cmd } : {}),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
