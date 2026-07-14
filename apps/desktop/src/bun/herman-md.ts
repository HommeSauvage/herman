import type {
  DevServer,
  EnvVar,
  HermanFrontmatter,
  HermanSections,
  ParsedHermanManifest,
  Requirement,
} from "../shared/herman-manifest.js";
import { HERMAN_MANIFEST_VERSION } from "../shared/herman-manifest.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const SECTION_RE = /^##\s+(.+)\s*$/gm;

const KNOWN_SECTIONS = new Set(["setup", "questions", "guidance"]);

/**
 * Parse a HERMAN.md document into frontmatter + known Markdown sections.
 */
export function parseHermanMd(raw: string, id: string): ParsedHermanManifest {
  const trimmed = raw.replace(/^\uFEFF/, "");
  const match = trimmed.match(FRONTMATTER_RE);

  let frontmatterRaw = "";
  let body = trimmed;
  if (match) {
    frontmatterRaw = match[1] ?? "";
    body = match[2] ?? "";
  }

  let parsed: unknown = {};
  if (frontmatterRaw.trim()) {
    try {
      parsed = Bun.YAML.parse(frontmatterRaw);
    } catch (error) {
      throw new Error(
        `Invalid YAML frontmatter in ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const frontmatter = validateFrontmatter(parsed, id);
  const sections = parseSections(body);

  return { id, frontmatter, sections, body: body.trimStart() };
}

function validateFrontmatter(raw: unknown, id: string): HermanFrontmatter {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`HERMAN.md frontmatter in ${id} must be a YAML object`);
  }
  const obj = raw as Record<string, unknown>;

  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error(`HERMAN.md in ${id} requires integer frontmatter.version`);
  }
  if (version !== HERMAN_MANIFEST_VERSION) {
    throw new Error(
      `HERMAN.md in ${id} has unsupported version ${version} (expected ${HERMAN_MANIFEST_VERSION})`,
    );
  }

  const fm: HermanFrontmatter = { version };

  if (typeof obj.extends === "string") fm.extends = obj.extends;
  if (typeof obj.name === "string") fm.name = obj.name;
  if (typeof obj.description === "string") fm.description = obj.description;
  if (typeof obj.extended_description === "string") fm.extended_description = obj.extended_description;
  if (typeof obj.icon === "string") fm.icon = obj.icon;
  if (typeof obj.snapshot === "string") fm.snapshot = obj.snapshot;
  if (typeof obj.category === "string") fm.category = obj.category;

  if (obj.source != null) {
    if (typeof obj.source !== "object" || Array.isArray(obj.source)) {
      throw new Error(`HERMAN.md source in ${id} must be an object`);
    }
    const source = obj.source as Record<string, unknown>;
    if (typeof source.repo !== "string" || !source.repo.trim()) {
      throw new Error(`HERMAN.md source.repo in ${id} is required when source is set`);
    }
    fm.source = {
      repo: source.repo.trim(),
      ...(typeof source.ref === "string" ? { ref: source.ref } : {}),
    };
  }

  if (obj.requirements != null) {
    if (!Array.isArray(obj.requirements)) {
      throw new Error(`HERMAN.md requirements in ${id} must be an array`);
    }
    fm.requirements = obj.requirements.map((item, i) => parseRequirement(item, id, i));
  }

  if (obj.env != null) {
    if (typeof obj.env !== "object" || Array.isArray(obj.env)) {
      throw new Error(`HERMAN.md env in ${id} must be an object`);
    }
    const env = obj.env as Record<string, unknown>;
    fm.env = {
      ...(typeof env.file === "string" ? { file: env.file } : {}),
      ...(Array.isArray(env.vars)
        ? { vars: env.vars.map((item, i) => parseEnvVar(item, id, i)) }
        : {}),
    };
  }

  if (obj.dev != null) {
    if (typeof obj.dev !== "object" || Array.isArray(obj.dev)) {
      throw new Error(`HERMAN.md dev in ${id} must be an object`);
    }
    const dev = obj.dev as Record<string, unknown>;
    fm.dev = {
      ...(typeof dev.install === "string" ? { install: dev.install } : {}),
      ...(Array.isArray(dev.servers)
        ? { servers: dev.servers.map((item, i) => parseDevServer(item, id, i)) }
        : {}),
    };
  }

  return fm;
}

function parseRequirement(item: unknown, id: string, index: number): Requirement {
  if (typeof item !== "object" || item == null || Array.isArray(item)) {
    throw new Error(`HERMAN.md requirements[${index}] in ${id} must be an object`);
  }
  const r = item as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.label !== "string" || typeof r.check !== "string") {
    throw new Error(`HERMAN.md requirements[${index}] in ${id} needs id, label, check`);
  }
  return {
    id: r.id,
    label: r.label,
    check: r.check,
    ...(typeof r.install === "string" ? { install: r.install } : {}),
    ...(typeof r.optional === "boolean" ? { optional: r.optional } : {}),
  };
}

function parseEnvVar(item: unknown, id: string, index: number): EnvVar {
  if (typeof item !== "object" || item == null || Array.isArray(item)) {
    throw new Error(`HERMAN.md env.vars[${index}] in ${id} must be an object`);
  }
  const v = item as Record<string, unknown>;
  if (typeof v.key !== "string" || !v.key.trim()) {
    throw new Error(`HERMAN.md env.vars[${index}] in ${id} needs key`);
  }
  return {
    key: v.key,
    ...(typeof v.required === "boolean" ? { required: v.required } : {}),
    ...(typeof v.file === "string" ? { file: v.file } : {}),
    ...(typeof v.default === "string" ? { default: v.default } : {}),
    ...(typeof v.notes === "string" ? { notes: v.notes } : {}),
    ...(typeof v.generate === "string" ? { generate: v.generate } : {}),
  };
}

function parseDevServer(item: unknown, id: string, index: number): DevServer {
  if (typeof item !== "object" || item == null || Array.isArray(item)) {
    throw new Error(`HERMAN.md dev.servers[${index}] in ${id} must be an object`);
  }
  const s = item as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.label !== "string" || typeof s.command !== "string") {
    throw new Error(`HERMAN.md dev.servers[${index}] in ${id} needs id, label, command`);
  }
  return {
    id: s.id,
    label: s.label,
    command: s.command,
    ...(typeof s.port === "number" ? { port: s.port } : {}),
    ...(typeof s.primary === "boolean" ? { primary: s.primary } : {}),
  };
}

function parseSections(body: string): HermanSections {
  const sections: HermanSections = {};
  const headings: { name: string; start: number; bodyStart: number }[] = [];

  SECTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECTION_RE.exec(body)) != null) {
    const name = (match[1] ?? "").trim().toLowerCase();
    headings.push({
      name,
      start: match.index,
      bodyStart: match.index + match[0].length,
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const end = i + 1 < headings.length ? headings[i + 1]!.start : body.length;
    const content = body.slice(heading.bodyStart, end).trim();
    if (!KNOWN_SECTIONS.has(heading.name)) continue;
    if (heading.name === "setup") sections.setup = content;
    else if (heading.name === "questions") sections.questions = content;
    else if (heading.name === "guidance") sections.guidance = content;
  }

  return sections;
}

/**
 * Serialize a resolved frontmatter + sections back to HERMAN.md.
 * Omits `extends` so the project copy is self-contained.
 */
export function serializeHermanMd(
  frontmatter: HermanFrontmatter,
  sections: HermanSections,
): string {
  const { extends: _ext, ...rest } = frontmatter;
  const yaml = dumpFrontmatterYaml(rest);
  const parts: string[] = ["---", yaml.trimEnd(), "---", ""];

  if (sections.setup?.trim()) {
    parts.push("## Setup", "", sections.setup.trim(), "");
  }
  if (sections.questions?.trim()) {
    parts.push("## Questions", "", sections.questions.trim(), "");
  }
  if (sections.guidance?.trim()) {
    parts.push("## Guidance", "", sections.guidance.trim(), "");
  }

  return `${parts.join("\n").trimEnd()}\n`;
}

/** Minimal YAML dump for our frontmatter shape (block style). */
function dumpFrontmatterYaml(fm: Omit<HermanFrontmatter, "extends">): string {
  const lines: string[] = [];
  lines.push(`version: ${fm.version}`);
  if (fm.name != null) lines.push(`name: ${yamlString(fm.name)}`);
  if (fm.description != null) lines.push(`description: ${yamlString(fm.description)}`);
  if (fm.extended_description != null) lines.push(`extended_description: ${yamlString(fm.extended_description)}`);
  if (fm.icon != null) lines.push(`icon: ${yamlString(fm.icon)}`);
  if (fm.snapshot != null) lines.push(`snapshot: ${yamlString(fm.snapshot)}`);
  if (fm.category != null) lines.push(`category: ${yamlString(fm.category)}`);

  if (fm.source) {
    lines.push("source:");
    lines.push(`  repo: ${yamlString(fm.source.repo)}`);
    if (fm.source.ref) lines.push(`  ref: ${yamlString(fm.source.ref)}`);
  }

  if (fm.requirements?.length) {
    lines.push("requirements:");
    for (const r of fm.requirements) {
      lines.push(`  - id: ${yamlString(r.id)}`);
      lines.push(`    label: ${yamlString(r.label)}`);
      lines.push(`    check: ${yamlString(r.check)}`);
      if (r.install) lines.push(`    install: ${yamlString(r.install)}`);
      if (r.optional) lines.push(`    optional: true`);
    }
  }

  if (fm.env) {
    lines.push("env:");
    if (fm.env.file) lines.push(`  file: ${yamlString(fm.env.file)}`);
    if (fm.env.vars?.length) {
      lines.push("  vars:");
      for (const v of fm.env.vars) {
        lines.push(`    - key: ${yamlString(v.key)}`);
        if (v.required != null) lines.push(`      required: ${v.required}`);
        if (v.file) lines.push(`      file: ${yamlString(v.file)}`);
        if (v.default) lines.push(`      default: ${yamlString(v.default)}`);
        if (v.notes) lines.push(`      notes: ${yamlString(v.notes)}`);
        if (v.generate) lines.push(`      generate: ${yamlString(v.generate)}`);
      }
    }
  }

  if (fm.dev) {
    lines.push("dev:");
    if (fm.dev.install) lines.push(`  install: ${yamlString(fm.dev.install)}`);
    if (fm.dev.servers?.length) {
      lines.push("  servers:");
      for (const s of fm.dev.servers) {
        lines.push(`    - id: ${yamlString(s.id)}`);
        lines.push(`      label: ${yamlString(s.label)}`);
        lines.push(`      command: ${yamlString(s.command)}`);
        if (s.port != null) lines.push(`      port: ${s.port}`);
        if (s.primary) lines.push(`      primary: true`);
      }
    }
  }

  return lines.join("\n");
}

function yamlString(value: string): string {
  if (
    value === "" ||
    /[:#{}[\],&*?|>!%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(true|false|null|~|\d+)/i.test(value) ||
    value.includes("\n") ||
    value.includes('"')
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Merge frontmatter: base first, child wins on scalars; keyed arrays merge by id/key.
 */
export function mergeFrontmatter(
  base: HermanFrontmatter,
  child: HermanFrontmatter,
): HermanFrontmatter {
  const merged: HermanFrontmatter = {
    version: child.version || base.version,
    ...(child.name != null ? { name: child.name } : base.name != null ? { name: base.name } : {}),
    ...(child.description != null
      ? { description: child.description }
      : base.description != null
        ? { description: base.description }
        : {}),
    ...(child.extended_description != null
      ? { extended_description: child.extended_description }
      : base.extended_description != null
        ? { extended_description: base.extended_description }
        : {}),
    ...(child.icon != null ? { icon: child.icon } : base.icon != null ? { icon: base.icon } : {}),
    ...(child.snapshot != null
      ? { snapshot: child.snapshot }
      : base.snapshot != null
        ? { snapshot: base.snapshot }
        : {}),
    ...(child.category != null
      ? { category: child.category }
      : base.category != null
        ? { category: base.category }
        : {}),
    ...(child.source != null
      ? { source: child.source }
      : base.source != null
        ? { source: base.source }
        : {}),
  };

  // Do not carry extends into resolved output.
  merged.requirements = mergeByKey(base.requirements, child.requirements, (r) => r.id);
  merged.env = mergeEnv(base.env, child.env);
  merged.dev = mergeDev(base.dev, child.dev);

  return merged;
}

function mergeByKey<T>(
  base: T[] | undefined,
  child: T[] | undefined,
  keyFn: (item: T) => string,
): T[] | undefined {
  if (!base?.length && !child?.length) return undefined;
  const map = new Map<string, T>();
  for (const item of base ?? []) map.set(keyFn(item), item);
  for (const item of child ?? []) map.set(keyFn(item), item);
  return [...map.values()];
}

function mergeEnv(
  base: HermanFrontmatter["env"],
  child: HermanFrontmatter["env"],
): HermanFrontmatter["env"] | undefined {
  if (!base && !child) return undefined;
  return {
    ...(child?.file != null ? { file: child.file } : base?.file != null ? { file: base.file } : {}),
    vars: mergeByKey(base?.vars, child?.vars, (v) => v.key),
  };
}

function mergeDev(
  base: HermanFrontmatter["dev"],
  child: HermanFrontmatter["dev"],
): HermanFrontmatter["dev"] | undefined {
  if (!base && !child) return undefined;
  return {
    ...(child?.install != null
      ? { install: child.install }
      : base?.install != null
        ? { install: base.install }
        : {}),
    servers: mergeByKey(base?.servers, child?.servers, (s) => s.id),
  };
}

/**
 * Merge Markdown sections by heading.
 * Child re-declaring a heading replaces it; new headings are appended.
 * For Setup specifically we concatenate base then child when both exist
 * and the child does NOT fully replace — per plan: child re-declaring replaces.
 * So: if child has the section, use child's; else keep base's.
 */
export function mergeSections(base: HermanSections, child: HermanSections): HermanSections {
  return {
    setup: child.setup != null ? child.setup : base.setup,
    questions: child.questions != null ? child.questions : base.questions,
    guidance: child.guidance != null ? child.guidance : base.guidance,
  };
}
