import { z } from "zod";

/** YAML frontmatter schema version for HERMAN.md / herman.yaml. */
export const HERMAN_MANIFEST_VERSION = 2;

// ── Zod schemas ────────────────────────────────────────────────────────────

export const HermanSourceSchema = z.object({
  repo: z.string(),
  ref: z.string().optional(),
});

export const RequirementSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Shell command; non-zero exit = missing. */
  check: z.string(),
  /** Help URL for installing the requirement manually. */
  install: z.string().optional(),
  /** Plain-language reason shown to non-technical users (why this tool is needed). */
  why: z.string().optional(),
  /**
   * Template-author override for the install command. Used when the tool is
   * not in Herman's curated registry (or the registry strategy doesn't apply).
   */
  install_cmd: z.string().optional(),
  /** When true, missing is a warning instead of a block. */
  optional: z.boolean().optional(),
});

/**
 * v2 env var value. Exactly four sources, resolved in order:
 * already present in the sourced file → `value` literal → `session` binding →
 * `generate` command (runs after setup steps). `required`/`notes` keep their
 * wizard ask-the-user meaning.
 */
export const EnvVarValueSchema = z.object({
  /** Literal value; ${HERMAN_*} interpolated at provisioning time. */
  value: z.string().optional(),
  /** Built-in per-session binding. */
  session: z
    .enum(["primary_port", "primary_url", "workspace", "main", "branch", "tab_id"])
    .optional(),
  /** Shell command whose stdout becomes the value (runs AFTER setup steps). */
  generate: z.string().optional(),
  /** Wizard: ask the user for this value. */
  required: z.boolean().optional(),
  /** Rookie-facing notes: why needed / how to get the key. */
  notes: z.string().optional(),
});

export const EnvFileSchema = z.object({
  /** Env file path relative to the workspace root. */
  path: z.string(),
  /** Copy from the main project when present (default true). */
  from_main: z.boolean().optional(),
  /** Fallback: copy from this file inside the workspace. */
  from_example: z.string().optional(),
  /** missing_only (default) fills only absent vars; force overwrites. */
  merge: z.enum(["missing_only", "force"]).optional(),
  /** Rewrite absolute main-root paths → workspace paths (default true). */
  rewrite_paths: z.boolean().optional(),
  vars: z.record(z.string(), EnvVarValueSchema).optional(),
});

export const EnvConfigV2Schema = z.object({
  files: z.array(EnvFileSchema),
});

export const SetupStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Shell command, run via `sh -c` in the workspace. */
  run: z.string(),
  /** Workspace-relative path exists → skip. */
  skip_if: z.string().optional(),
  /** Env var non-empty in `env_file` (default: first env file) → skip. */
  skip_if_env: z.string().optional(),
  env_file: z.string().optional(),
  /** Failure = warning, not blocker. */
  optional: z.boolean().optional(),
  /** Seconds (default 300, hard cap 900). */
  timeout: z.number().optional(),
});

export const DevServerSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  port: z.number().optional(),
  /** Drives the preview pane when true. Exactly one should be primary. */
  primary: z.boolean().optional(),
  /**
   * Env var name(s) set on every Herman-spawned server to this server's
   * resolved `http://localhost:{port}` URL.
   */
  exportUrlAs: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  /**
   * Env var name(s) set on this server's spawn environment to its resolved
   * port (e.g. SERVER_PORT for `php artisan serve`).
   */
  portEnv: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
});

/** Normalize a string-or-list manifest field to a trimmed non-empty string list. */
export function normalizeStringList(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return (typeof value === "string" ? [value] : value).map((s) => s.trim()).filter(Boolean);
}

/** Normalize `exportUrlAs` to a trimmed non-empty string list. */
export function normalizeExportUrlAs(value: string | string[] | undefined): string[] {
  return normalizeStringList(value);
}

/** Normalize `portEnv` to a trimmed non-empty string list. */
export function normalizePortEnv(value: string | string[] | undefined): string[] {
  return normalizeStringList(value);
}

/** Fields shared by template frontmatter and resolved project herman.yaml (v2). */
const manifestRuntimeFields = {
  name: z.string().optional(),
  description: z.string().optional(),
  requirements: z.array(RequirementSchema).optional(),
  env: EnvConfigV2Schema.optional(),
  setup: z.array(SetupStepSchema).optional(),
  servers: z.array(DevServerSchema).optional(),
};

/**
 * Full HERMAN.md frontmatter schema (template files, supports extends).
 * v1 documents are migrated by {@link migrateV1Manifest} before parsing.
 */
export const HermanFrontmatterSchema = z
  .object({
    version: z.number().int(),
    /** Reference to another curated Herman manifest id (optional inheritance). */
    extends: z.string().optional(),
    /** What this template is good for, so the user can decide if it fits their project. */
    suitable_for: z.string().optional(),
    icon: z.string().optional(),
    snapshot: z.string().optional(),
    category: z.string().optional(),
    /** Goal that the wizard coding session passes to pi-goal (tick plan boxes).
     *  Falls back to a sensible default when omitted. */
    setup_goal: z.string().optional(),
    source: HermanSourceSchema.optional(),
    ...manifestRuntimeFields,
  })
  .refine((data) => data.version === HERMAN_MANIFEST_VERSION, {
    message: `Unsupported manifest version, expected ${HERMAN_MANIFEST_VERSION}`,
    path: ["version"],
  });

/** Resolved herman.yaml schema (project-level, no extends, guidance as YAML key). */
export const HermanYamlSchema = z
  .object({
    version: z.number(),
    guidance: z.string().optional(),
    ...manifestRuntimeFields,
  })
  .refine((data) => data.version === HERMAN_MANIFEST_VERSION, {
    message: `Unsupported manifest version, expected ${HERMAN_MANIFEST_VERSION}`,
    path: ["version"],
  });

// ── v1 → v2 read shim ──────────────────────────────────────────────────────

type V1EnvVar = {
  key?: string;
  required?: boolean;
  file?: string;
  default?: string;
  notes?: string;
  generate?: string;
};

/**
 * Migrate a raw v1 manifest object (HERMAN.md frontmatter or herman.yaml) to
 * the v2 shape. Pure and idempotent: v2 documents pass through unchanged
 * except that `version` is normalized to 2.
 *
 * - `dev.install` → `setup: [{ id: "install", … }]` (no skip conditions; the
 *   workspace stamp file provides idempotency).
 * - `dev.servers` → top-level `servers`.
 * - `env.file` + `env.vars[]` → `env.files[]`, grouping per-var `file`
 *   overrides into their own file entries.
 */
export function migrateV1Manifest(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...input, version: 2 };

  // dev → setup + servers
  const dev = input.dev as { install?: string; servers?: unknown } | undefined;
  if (dev && typeof dev === "object") {
    if (typeof dev.install === "string" && dev.install.trim() && out.setup == null) {
      out.setup = [
        { id: "install", label: "Running project setup", run: dev.install },
      ];
    }
    if (dev.servers != null && out.servers == null) {
      out.servers = dev.servers;
    }
  }
  delete out.dev;

  // env v1 (file + vars[]) → env.files[]
  const env = input.env as { file?: string; vars?: V1EnvVar[] } | undefined;
  if (env && typeof env === "object" && !Array.isArray((env as { files?: unknown }).files)) {
    const byFile = new Map<string, Record<string, unknown>>();
    for (const v of env.vars ?? []) {
      if (!v?.key) continue;
      const path = v.file ?? env.file ?? ".env";
      const bucket = byFile.get(path) ?? {};
      const entry: Record<string, unknown> = {};
      if (v.default != null) entry.value = v.default;
      if (v.generate) entry.generate = v.generate;
      if (v.required != null) entry.required = v.required;
      if (v.notes) entry.notes = v.notes;
      bucket[v.key] = entry;
      byFile.set(path, bucket);
    }
    const files = [...byFile.entries()].map(([path, vars]) => ({ path, vars }));
    // Preserve the declared default file even when no vars target it.
    if (files.length === 0 && typeof env.file === "string" && env.file.trim()) {
      files.push({ path: env.file, vars: {} });
    }
    if (files.length > 0) {
      out.env = { files };
    } else {
      delete out.env;
    }
  } else if (env && typeof env === "object") {
    out.env = env;
  }

  return out;
}

/** True when a raw parsed YAML/frontmatter object declares schema version 1. */
export function isV1Manifest(raw: unknown): boolean {
  return (
    Boolean(raw) &&
    typeof raw === "object" &&
    (raw as { version?: unknown }).version === 1
  );
}

// ── Inferred types ─────────────────────────────────────────────────────────

export type HermanSource = z.infer<typeof HermanSourceSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type EnvVarValue = z.infer<typeof EnvVarValueSchema>;
export type EnvFile = z.infer<typeof EnvFileSchema>;
export type EnvConfigV2 = z.infer<typeof EnvConfigV2Schema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
export type DevServer = z.infer<typeof DevServerSchema>;
export type HermanFrontmatter = z.infer<typeof HermanFrontmatterSchema>;
export type HermanYaml = z.infer<typeof HermanYamlSchema>;

// ── Compound / computed types (not directly validated by a single YAML parse) ──

/** Known Markdown body sections (case-insensitive headings). */
export type HermanSections = {
  setup?: string;
  questions?: string;
  guidance?: string;
};

export type ParsedHermanManifest = {
  /** Manifest id derived from filename (e.g. "blog" from blog.HERMAN.md). */
  id: string;
  frontmatter: HermanFrontmatter;
  sections: HermanSections;
  /** Raw markdown body after frontmatter (for serialization). */
  body: string;
};

/**
 * Fully resolved manifest after `extends` chain is flattened.
 * Ready to write into a project as HERMAN.md and to drive the wizard.
 */
export type ResolvedManifest = {
  id: string;
  frontmatter: HermanFrontmatter;
  sections: HermanSections;
  /** Serialized HERMAN.md with extends flattened (no `extends` field). */
  serialized: string;
};

/** Gallery card for the template picker. */
export type GalleryTemplate = {
  id: string;
  name: string;
  description: string;
  /** What this template is good for, so the user can decide if it fits their project. */
  suitableFor?: string;
  icon?: string;
  snapshot?: string;
  category?: string;
  /** Effective source repo after resolve (may be empty for base-only manifests). */
  sourceRepo?: string;
};

export type RequirementCheckResult = {
  id: string;
  label: string;
  ok: boolean;
  optional: boolean;
  install?: string;
  why?: string;
  installCmd?: string;
  detail?: string;
};

/**
 * Project-level manifest shape returned to the renderer for preview/dev.
 * Reads herman.yaml first, then falls back to HERMAN.md.
 */
export type ProjectManifestView = {
  servers: DevServer[];
  /** Convenience: primary server (or first). */
  primary?: DevServer;
  /** Ordered, idempotent setup steps for a fresh workspace. */
  setup?: SetupStep[];
  /** Environment files provisioned before setup steps run. */
  env?: EnvConfigV2;
  guidance?: string;
  requirements?: Requirement[];
  name?: string;
  description?: string;
  /** Legacy flat fields for back-compat consumers. */
  devCommand?: string;
  devPort?: number;
  buildCommand?: string;
  outputDir?: string;
  deployTarget?: string;
};
