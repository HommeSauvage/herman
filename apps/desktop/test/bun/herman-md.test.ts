import { describe, expect, it } from "vitest";

import {
  mergeFrontmatter,
  mergeSections,
  parseHermanMd,
  serializeHermanMd,
} from "../../src/bun/herman-md.js";
import { clearTemplateRegistryCache, getGalleryTemplates, resolveTemplateManifest } from "../../src/bun/template-registry.js";

describe("herman-md parser", () => {
  it("parses block-style frontmatter and known sections", () => {
    const raw = `---
version: 1
name: Blog
source:
  repo: https://github.com/example/repo
  ref: main
dev:
  install: bun install
  servers:
    - id: web
      label: Website
      command: bun run dev
      port: 3000
      primary: true
---

## Setup
Do the setup.

## Questions
Ask about the blog name.

## Guidance
Keep it simple.
`;
    const parsed = parseHermanMd(raw, "blog");
    expect(parsed.frontmatter.version).toBe(1);
    expect(parsed.frontmatter.name).toBe("Blog");
    expect(parsed.frontmatter.source?.repo).toContain("example/repo");
    expect(parsed.frontmatter.dev?.servers?.[0]?.port).toBe(3000);
    expect(parsed.sections.setup).toContain("Do the setup");
    expect(parsed.sections.questions).toContain("blog name");
    expect(parsed.sections.guidance).toContain("Keep it simple");
  });

  it("merges extends frontmatter by keyed arrays", () => {
    const base = parseHermanMd(
      `---
version: 1
name: Base
source:
  repo: https://github.com/example/base
env:
  file: .env
  vars:
    - key: A
      required: true
    - key: B
      default: x
dev:
  servers:
    - id: web
      label: Web
      command: bun run dev
      port: 3000
      primary: true
---
`,
      "base",
    );
    const child = parseHermanMd(
      `---
version: 1
extends: base
name: Child
env:
  vars:
    - key: B
      default: y
    - key: C
      notes: extra
---

## Setup
Child setup
`,
      "child",
    );

    const fm = mergeFrontmatter(base.frontmatter, child.frontmatter);
    const sections = mergeSections(base.sections, child.sections);
    expect(fm.name).toBe("Child");
    expect(fm.source?.repo).toContain("example/base");
    expect(fm.env?.vars?.map((v) => v.key).sort()).toEqual(["A", "B", "C"]);
    expect(fm.env?.vars?.find((v) => v.key === "B")?.default).toBe("y");
    expect(sections.setup).toContain("Child setup");

    const serialized = serializeHermanMd(fm, sections);
    expect(serialized).toContain("name: Child");
    expect(serialized).not.toContain("extends:");
    expect(serialized).toContain("## Setup");
  });
});

describe("template registry", () => {
  it("loads gallery templates and resolves extends", async () => {
    clearTemplateRegistryCache();
    const gallery = await getGalleryTemplates();
    expect(gallery.length).toBeGreaterThan(0);
    expect(gallery.every((t) => t.category !== "base")).toBe(true);

    const blog = gallery.find((t) => t.id === "blog");
    expect(blog).toBeTruthy();

    const resolved = await resolveTemplateManifest("blog");
    expect(resolved.frontmatter.source?.repo).toContain("herman-starter");
    expect(resolved.frontmatter.dev?.servers?.[0]?.port).toBe(3000);
    expect(resolved.serialized).toContain("## Setup");
    expect(resolved.serialized).not.toContain("extends:");
  });
});
