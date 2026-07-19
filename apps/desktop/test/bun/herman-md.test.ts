import { describe, expect, it } from "vitest";

import {
  mergeFrontmatter,
  mergeSections,
  parseHermanMd,
  serializeHermanMd,
} from "../../src/bun/herman-md.js";
import { clearTemplateRegistryCache, getGalleryTemplates, resolveTemplateManifest } from "../../src/bun/template-registry.js";

describe("herman-md parser", () => {
  it("parses v2 frontmatter and known sections", () => {
    const raw = `---
version: 2
name: Blog
source:
  repo: https://github.com/example/repo
  ref: main
setup:
  - id: deps
    label: Installing dependencies
    run: bun install
    skip_if: node_modules
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
    expect(parsed.frontmatter.version).toBe(2);
    expect(parsed.frontmatter.name).toBe("Blog");
    expect(parsed.frontmatter.source?.repo).toContain("example/repo");
    expect(parsed.frontmatter.servers?.[0]?.port).toBe(3000);
    expect(parsed.frontmatter.setup?.[0]?.run).toBe("bun install");
    expect(parsed.sections.setup).toContain("Do the setup");
    expect(parsed.sections.questions).toContain("blog name");
    expect(parsed.sections.guidance).toContain("Keep it simple");
  });

  it("migrates v1 frontmatter to v2 on read", () => {
    const raw = `---
version: 1
name: Blog
dev:
  install: bun install
  servers:
    - id: web
      label: Website
      command: bun run dev
      port: 3000
      primary: true
env:
  file: .env
  vars:
    - key: A
      required: true
      default: x
---
`;
    const parsed = parseHermanMd(raw, "blog");
    expect(parsed.frontmatter.version).toBe(2);
    // dev.install → setup step
    expect(parsed.frontmatter.setup).toEqual([
      { id: "install", label: "Running project setup", run: "bun install" },
    ]);
    // dev.servers → top-level servers
    expect(parsed.frontmatter.servers?.[0]?.port).toBe(3000);
    // env.file + env.vars[] → env.files[]
    expect(parsed.frontmatter.env?.files).toEqual([
      { path: ".env", vars: { A: { value: "x", required: true } } },
    ]);
  });

  it("round-trips requirement why and install_cmd", () => {
    const parsed = parseHermanMd(
      `---
version: 2
name: Laravel
requirements:
  - id: php
    label: PHP 8.3+
    check: php --version
    install: https://php.net
    why: Runs your website's backend.
  - id: redis
    label: Redis
    check: redis-cli --version
    install_cmd: brew install redis
    optional: true
---
`,
      "laravel",
    );
    const php = parsed.frontmatter.requirements?.[0];
    expect(php?.why).toBe("Runs your website's backend.");
    expect(php?.install).toBe("https://php.net");
    const redis = parsed.frontmatter.requirements?.[1];
    expect(redis?.install_cmd).toBe("brew install redis");
    expect(redis?.optional).toBe(true);

    const serialized = serializeHermanMd(parsed.frontmatter, parsed.sections);
    expect(serialized).toContain("why: Runs your website's backend.");
    expect(serialized).toContain("install_cmd: brew install redis");

    // And the serialized form parses back identically.
    const reparsed = parseHermanMd(serialized, "laravel");
    expect(reparsed.frontmatter.requirements).toEqual(parsed.frontmatter.requirements);
  });

  it("parses and serializes exportUrlAs and portEnv as string and array", () => {
    const asString = parseHermanMd(
      `---
version: 2
name: Api
servers:
  - id: api
    label: API
    command: bun run dev:api
    port: 3010
    exportUrlAs: API_SERVER
    portEnv: SERVER_PORT
---
`,
      "api",
    );
    expect(asString.frontmatter.servers?.[0]?.exportUrlAs).toBe("API_SERVER");
    expect(asString.frontmatter.servers?.[0]?.portEnv).toBe("SERVER_PORT");

    const asArray = parseHermanMd(
      `---
version: 2
name: Api
servers:
  - id: api
    label: API
    command: bun run dev:api
    port: 3010
    exportUrlAs:
      - API_SERVER
      - API_URL
    portEnv:
      - SERVER_PORT
      - PORT
---
`,
      "api",
    );
    expect(asArray.frontmatter.servers?.[0]?.exportUrlAs).toEqual([
      "API_SERVER",
      "API_URL",
    ]);
    expect(asArray.frontmatter.servers?.[0]?.portEnv).toEqual(["SERVER_PORT", "PORT"]);

    const serialized = serializeHermanMd(asArray.frontmatter, asArray.sections);
    expect(serialized).toContain("exportUrlAs:");
    expect(serialized).toContain("API_SERVER");
    expect(serialized).toContain("API_URL");
    expect(serialized).toContain("portEnv:");

    const stringSerialized = serializeHermanMd(asString.frontmatter, asString.sections);
    expect(stringSerialized).toContain("exportUrlAs: API_SERVER");
    expect(stringSerialized).toContain("portEnv: SERVER_PORT");
  });

  it("serializes env files and setup steps (v2 round-trip)", () => {
    const parsed = parseHermanMd(
      `---
version: 2
name: App
env:
  files:
    - path: .env
      from_example: .env.example
      merge: missing_only
      vars:
        APP_KEY:
          generate: php artisan key:generate --show
          required: true
        SERVER_PORT:
          session: primary_port
setup:
  - id: deps
    label: Installing dependencies
    run: composer install
    skip_if: vendor/autoload.php
    timeout: 600
  - id: seed
    label: Seeding
    run: php artisan db:seed
    optional: true
---
`,
      "app",
    );

    const serialized = serializeHermanMd(parsed.frontmatter, parsed.sections);
    const reparsed = parseHermanMd(serialized, "app");
    expect(reparsed.frontmatter.env).toEqual(parsed.frontmatter.env);
    expect(reparsed.frontmatter.setup).toEqual(parsed.frontmatter.setup);
  });

  it("merge: child replaces setup/env/servers arrays wholesale", () => {
    const base = parseHermanMd(
      `---
version: 2
name: Base
source:
  repo: https://github.com/example/base
env:
  files:
    - path: .env
      vars:
        A:
          required: true
        B:
          value: x
setup:
  - id: deps
    label: Base deps
    run: bun install
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
version: 2
extends: base
name: Child
env:
  files:
    - path: .env.local
      vars:
        B:
          value: "y"
        C:
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
    // env.files: child replaces wholesale (no concat — ordering trap).
    expect(fm.env?.files).toHaveLength(1);
    expect(fm.env?.files?.[0]?.path).toBe(".env.local");
    expect(Object.keys(fm.env?.files?.[0]?.vars ?? {}).sort()).toEqual(["B", "C"]);
    // setup/servers: child did not declare them → base kept.
    expect(fm.setup?.[0]?.id).toBe("deps");
    expect(fm.servers?.[0]?.port).toBe(3000);
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

    // blog extends laravel → inherits the laravel source + servers (v2).
    const resolved = await resolveTemplateManifest("blog");
    expect(resolved.frontmatter.source?.repo).toContain("herman-starter-laravel");
    expect(resolved.frontmatter.servers?.[0]?.port).toBe(8000);
    expect(resolved.frontmatter.servers?.[0]?.portEnv).toBe("SERVER_PORT");
    expect(resolved.frontmatter.setup?.length).toBeGreaterThan(0);
    expect(resolved.serialized).toContain("## Setup");
    expect(resolved.serialized).not.toContain("extends:");
  });
});
