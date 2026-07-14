/** YAML frontmatter schema version for HERMAN.md. */
export const HERMAN_MANIFEST_VERSION = 1;

export type HermanSource = {
  repo: string;
  ref?: string;
};

export type Requirement = {
  id: string;
  label: string;
  /** Shell command; non-zero exit = missing. */
  check: string;
  /** Help URL for installing the requirement. */
  install?: string;
  /** When true, missing is a warning instead of a block. */
  optional?: boolean;
};

export type EnvVar = {
  key: string;
  required?: boolean;
  /** Override the default env file for this var. */
  file?: string;
  default?: string;
  /** Rookie-facing notes: why needed / how to get the key. */
  notes?: string;
  /** Shell command whose stdout becomes the value (user never sees it). */
  generate?: string;
};

export type EnvConfig = {
  /** Default target file, e.g. apps/web/.env.development.local */
  file?: string;
  vars?: EnvVar[];
};

export type DevServer = {
  id: string;
  label: string;
  command: string;
  port?: number;
  /** Drives the preview pane when true. Exactly one should be primary. */
  primary?: boolean;
};

export type DevConfig = {
  install?: string;
  servers?: DevServer[];
};

/**
 * Machine-consumed YAML frontmatter of a HERMAN.md file.
 * All fields optional except `version`.
 */
export type HermanFrontmatter = {
  version: number;
  /** Reference to another curated Herman manifest id (optional inheritance). */
  extends?: string;
  name?: string;
  description?: string;
  /** What this template is good for, so the user can decide if it fits their project. */
  suitable_for?: string;
  icon?: string;
  snapshot?: string;
  category?: string;
  source?: HermanSource;
  requirements?: Requirement[];
  env?: EnvConfig;
  dev?: DevConfig;
};

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
 * Prefer HERMAN.md; falls back to legacy herman.json fields when present.
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
