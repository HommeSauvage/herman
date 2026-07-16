import { z } from "zod";

/** YAML frontmatter schema version for HERMAN.md. */
export const HERMAN_MANIFEST_VERSION = 1;

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
  /** Help URL for installing the requirement. */
  install: z.string().optional(),
  /** When true, missing is a warning instead of a block. */
  optional: z.boolean().optional(),
});

export const EnvVarSchema = z.object({
  key: z.string(),
  required: z.boolean().optional(),
  /** Override the default env file for this var. */
  file: z.string().optional(),
  default: z.string().optional(),
  /** Rookie-facing notes: why needed / how to get the key. */
  notes: z.string().optional(),
  /** Shell command whose stdout becomes the value (user never sees it). */
  generate: z.string().optional(),
});

export const EnvConfigSchema = z.object({
  /** Default target file, e.g. apps/web/.env.development.local */
  file: z.string().optional(),
  vars: z.array(EnvVarSchema).optional(),
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
});

/** Normalize `exportUrlAs` to a trimmed non-empty string list. */
export function normalizeExportUrlAs(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return (typeof value === "string" ? [value] : value).map((s) => s.trim()).filter(Boolean);
}

export const DevConfigSchema = z.object({
  install: z.string().optional(),
  servers: z.array(DevServerSchema).optional(),
});

/**
 * Full HERMAN.md frontmatter schema (template files, supports extends).
 */
export const HermanFrontmatterSchema = z
  .object({
    version: z.number().int(),
    /** Reference to another curated Herman manifest id (optional inheritance). */
    extends: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    /** What this template is good for, so the user can decide if it fits their project. */
    suitable_for: z.string().optional(),
    icon: z.string().optional(),
    snapshot: z.string().optional(),
    category: z.string().optional(),
    /** Goal that the wizard coding session passes to pi-goal (tick plan boxes).
     *  Falls back to a sensible default when omitted. */
    setup_goal: z.string().optional(),
    source: HermanSourceSchema.optional(),
    requirements: z.array(RequirementSchema).optional(),
    env: EnvConfigSchema.optional(),
    dev: DevConfigSchema.optional(),
  })
  .refine((data) => data.version === HERMAN_MANIFEST_VERSION, {
    message: `Unsupported manifest version, expected ${HERMAN_MANIFEST_VERSION}`,
    path: ["version"],
  });

/** Resolved herman.yaml schema (project-level, no extends, guidance as YAML key). */
export const HermanYamlSchema = z.object({
  version: z.number(),
  name: z.string().optional(),
  description: z.string().optional(),
  dev: DevConfigSchema.optional(),
  env: EnvConfigSchema.optional(),
  guidance: z.string().optional(),
  requirements: z.array(RequirementSchema).optional(),
});

// ── Inferred types ─────────────────────────────────────────────────────────

export type HermanSource = z.infer<typeof HermanSourceSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type EnvConfig = z.infer<typeof EnvConfigSchema>;
export type DevServer = z.infer<typeof DevServerSchema>;
export type DevConfig = z.infer<typeof DevConfigSchema>;
export type HermanFrontmatter = z.infer<typeof HermanFrontmatterSchema>;

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
  install?: string;
  guidance?: string;
  env?: EnvConfig;
  requirements?: Requirement[];
  /** Legacy flat fields for back-compat consumers. */
  devCommand?: string;
  devPort?: number;
  buildCommand?: string;
  outputDir?: string;
  deployTarget?: string;
};
