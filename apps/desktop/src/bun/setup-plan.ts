import { createHash } from "node:crypto";

import type {
  DevServer,
  EnvFile,
  HermanFrontmatter,
  ProjectManifestView,
  SetupStep,
} from "../shared/herman-manifest.js";

/**
 * The resolved workspace recipe: env files + ordered setup steps + servers.
 * Derived from a v2 manifest (template frontmatter or project herman.yaml)
 * — v1 documents are migrated by the read layer before this runs.
 */
export type ResolvedSetupPlan = {
  envFiles: EnvFile[];
  setupSteps: SetupStep[];
  servers: DevServer[];
  projectName?: string;
};

type ManifestLike = Partial<Pick<HermanFrontmatter, "env" | "setup" | "servers" | "name">> &
  Partial<Pick<ProjectManifestView, "env" | "setup" | "servers" | "name">>;

/** Resolve the setup plan from any manifest-shaped object. */
export function resolveSetupPlan(manifest: ManifestLike | undefined | null): ResolvedSetupPlan {
  return {
    envFiles: manifest?.env?.files ?? [],
    setupSteps: manifest?.setup ?? [],
    servers: manifest?.servers ?? [],
    ...(manifest?.name ? { projectName: manifest.name } : {}),
  };
}

/** Stable stringify with sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Hash of the resolved plan (env files + setup steps + servers). Stored in
 * the workspace stamp file; manifest changes invalidate completed steps.
 */
export function planHash(plan: ResolvedSetupPlan): string {
  const hash = createHash("sha256");
  hash.update(
    stableStringify({
      envFiles: plan.envFiles,
      setupSteps: plan.setupSteps,
      servers: plan.servers,
    }),
  );
  return hash.digest("hex");
}

/**
 * Generate the wizard's workspace-setup section from the resolved plan, so
 * first-time setup of the main tree and every future worktree setup execute
 * the same recipe (no wizard/session drift).
 */
export function buildSetupGoal(plan: ResolvedSetupPlan): string {
  const lines: string[] = [
    "## Workspace setup recipe (from herman.yaml — run exactly this, in order)",
  ];

  if (plan.envFiles.length > 0) {
    lines.push("", "### Env files (provision BEFORE setup steps)");
    for (const file of plan.envFiles) {
      const source = file.from_example
        ? `copy \`${file.from_example}\` → \`${file.path}\` when missing`
        : `create \`${file.path}\` when missing`;
      lines.push(`- ${source}`);
      for (const [key, v] of Object.entries(file.vars ?? {})) {
        const parts = [`  - \`${key}\``];
        if (v.value != null) parts.push(`= \`${v.value}\``);
        if (v.generate) parts.push(`generate via \`${v.generate}\` (run AFTER setup steps)`);
        if (v.required) parts.push("(required)");
        if (v.notes) parts.push(`— ${v.notes}`);
        lines.push(parts.join(" "));
      }
    }
  }

  if (plan.setupSteps.length > 0) {
    lines.push("", "### Setup steps (run in order)");
    plan.setupSteps.forEach((step, index) => {
      const extras: string[] = [];
      if (step.skip_if) extras.push(`skip when \`${step.skip_if}\` exists`);
      if (step.optional) extras.push("optional — continue on failure");
      lines.push(
        `${index + 1}. ${step.label}: \`${step.run}\`${extras.length ? ` (${extras.join("; ")})` : ""}`,
      );
    });
  }

  if (plan.servers.length > 0) {
    lines.push("", "### Dev servers (Herman runs these for previews)");
    for (const server of plan.servers) {
      lines.push(
        `- \`${server.id}\`: \`${server.command}\`${server.port != null ? ` (preferred port ${server.port})` : ""}`,
      );
    }
  }

  if (plan.envFiles.length === 0 && plan.setupSteps.length === 0 && plan.servers.length === 0) {
    return "";
  }
  return lines.join("\n");
}
