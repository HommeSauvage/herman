import type {
  EnvVarValue,
  HermanFrontmatter,
  HermanSections,
  ParsedHermanManifest,
} from "../shared/herman-manifest.js";
import {
  isV1Manifest,
  migrateV1Manifest,
  HermanFrontmatterSchema,
} from "../shared/herman-manifest.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const SECTION_RE = /^##\s+(.+)\s*$/gm;

const KNOWN_SECTIONS = new Set(["setup", "questions", "guidance"]);

/**
 * Parse a HERMAN.md document into frontmatter + known Markdown sections.
 * v1 frontmatter is migrated to v2 on read.
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
  const migrated = isV1Manifest(raw) ? migrateV1Manifest(raw) : raw;
  const result = HermanFrontmatterSchema.safeParse(migrated);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.join(".");
    throw new Error(
      `HERMAN.md in ${id}: ${first.message}${path ? ` (at ${path})` : ""}`,
    );
  }
  return result.data;
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
export function dumpFrontmatterYaml(fm: Omit<HermanFrontmatter, "extends">): string {
  const lines: string[] = [];
  lines.push(`version: ${fm.version}`);
  if (fm.name != null) lines.push(`name: ${yamlString(fm.name)}`);
  if (fm.description != null) lines.push(`description: ${yamlString(fm.description)}`);
  if (fm.suitable_for != null) lines.push(`suitable_for: ${yamlString(fm.suitable_for)}`);
  if (fm.icon != null) lines.push(`icon: ${yamlString(fm.icon)}`);
  if (fm.snapshot != null) lines.push(`snapshot: ${yamlString(fm.snapshot)}`);
  if (fm.category != null) lines.push(`category: ${yamlString(fm.category)}`);
  if (fm.setup_goal != null) lines.push(`setup_goal: ${yamlString(fm.setup_goal)}`);

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
      if (r.why) lines.push(`    why: ${yamlString(r.why)}`);
      if (r.install_cmd) lines.push(`    install_cmd: ${yamlString(r.install_cmd)}`);
      if (r.optional) lines.push(`    optional: true`);
    }
  }

  if (fm.env?.files?.length) {
    lines.push("env:");
    lines.push("  files:");
    for (const f of fm.env.files) {
      lines.push(`    - path: ${yamlString(f.path)}`);
      if (f.from_main != null) lines.push(`      from_main: ${f.from_main}`);
      if (f.from_example) lines.push(`      from_example: ${yamlString(f.from_example)}`);
      if (f.merge) lines.push(`      merge: ${yamlString(f.merge)}`);
      if (f.rewrite_paths != null) lines.push(`      rewrite_paths: ${f.rewrite_paths}`);
      const vars = f.vars ?? {};
      const keys = Object.keys(vars);
      if (keys.length > 0) {
        lines.push("      vars:");
        for (const key of keys) {
          const v = vars[key]!;
          lines.push(`        ${yamlString(key)}:`);
          dumpEnvVarValue(lines, v, "          ");
        }
      }
    }
  }

  if (fm.setup?.length) {
    lines.push("setup:");
    for (const s of fm.setup) {
      lines.push(`  - id: ${yamlString(s.id)}`);
      lines.push(`    label: ${yamlString(s.label)}`);
      lines.push(`    run: ${yamlString(s.run)}`);
      if (s.skip_if) lines.push(`    skip_if: ${yamlString(s.skip_if)}`);
      if (s.skip_if_env) lines.push(`    skip_if_env: ${yamlString(s.skip_if_env)}`);
      if (s.env_file) lines.push(`    env_file: ${yamlString(s.env_file)}`);
      if (s.optional) lines.push(`    optional: true`);
      if (s.timeout != null) lines.push(`    timeout: ${s.timeout}`);
    }
  }

  if (fm.servers?.length) {
    lines.push("servers:");
    for (const s of fm.servers) {
      lines.push(`  - id: ${yamlString(s.id)}`);
      lines.push(`    label: ${yamlString(s.label)}`);
      lines.push(`    command: ${yamlString(s.command)}`);
      if (s.port != null) lines.push(`    port: ${s.port}`);
      if (s.primary) lines.push(`    primary: true`);
      dumpStringOrList(lines, "exportUrlAs", s.exportUrlAs, "    ");
      dumpStringOrList(lines, "portEnv", s.portEnv, "    ");
    }
  }

  return lines.join("\n");
}

function dumpEnvVarValue(lines: string[], v: EnvVarValue, indent: string): void {
  if (v.value != null) lines.push(`${indent}value: ${yamlString(v.value)}`);
  if (v.session) lines.push(`${indent}session: ${yamlString(v.session)}`);
  if (v.generate) lines.push(`${indent}generate: ${yamlString(v.generate)}`);
  if (v.required != null) lines.push(`${indent}required: ${v.required}`);
  if (v.notes) lines.push(`${indent}notes: ${yamlString(v.notes)}`);
}

function dumpStringOrList(
  lines: string[],
  key: string,
  value: string | string[] | undefined,
  indent: string,
): void {
  if (value == null) return;
  if (typeof value === "string") {
    lines.push(`${indent}${key}: ${yamlString(value)}`);
    return;
  }
  if (value.length === 0) return;
  lines.push(`${indent}${key}:`);
  for (const item of value) {
    lines.push(`${indent}  - ${yamlString(item)}`);
  }
}

export function yamlString(value: string): string {
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
 * Merge frontmatter: base first, child wins on scalars; `requirements` merge
 * by id. Ordered arrays (`setup`, `env.files`, `servers`) are REPLACED
 * wholesale by the child when it declares them — concatenation is an
 * ordering trap for setup recipes.
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
    ...(child.suitable_for != null
      ? { suitable_for: child.suitable_for }
      : base.suitable_for != null
        ? { suitable_for: base.suitable_for }
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
    ...(child.setup_goal != null
      ? { setup_goal: child.setup_goal }
      : base.setup_goal != null
        ? { setup_goal: base.setup_goal }
        : {}),
    ...(child.source != null
      ? { source: child.source }
      : base.source != null
        ? { source: base.source }
        : {}),
  };

  // Do not carry extends into resolved output.
  merged.requirements = mergeByKey(base.requirements, child.requirements, (r) => r.id);
  // Array-replace semantics for the workspace recipe (see docstring).
  if (child.env ?? base.env) merged.env = child.env ?? base.env;
  if (child.setup ?? base.setup) merged.setup = child.setup ?? base.setup;
  if (child.servers ?? base.servers) merged.servers = child.servers ?? base.servers;

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
