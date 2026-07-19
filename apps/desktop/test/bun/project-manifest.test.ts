import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDir, removeTestTempDir } from "../helpers/temp-dir.js";
import {
  readProjectManifest,
  serializeHermanYaml,
  setupProjectRepo,
} from "../../src/bun/project-manifest.js";
import {
  clearTemplateRegistryCache,
  resolveTemplateManifest,
} from "../../src/bun/template-registry.js";

function makeTempDir(prefix: string): string {
  const dir = createTestTempDir(`herman-manifest-${prefix}-`);
  return dir;
}

afterEach(() => {
  removeTestTempDir("/tmp/unused"); // no-op, temp-dir handles cleanup per test
});

describe("serializeHermanYaml", () => {
  it("produces a pure-YAML v2 manifest from a resolved template", async () => {
    clearTemplateRegistryCache();
    const resolved = await resolveTemplateManifest("blog");
    const yaml = serializeHermanYaml(resolved);

    // No extends, no setup_goal, no markdown sections
    expect(yaml).not.toContain("extends:");
    expect(yaml).not.toContain("setup_goal:");
    expect(yaml).not.toContain("## Setup");
    expect(yaml).not.toContain("## Questions");

    // v2: no `dev:` section; top-level servers + setup (from laravel chain)
    expect(yaml).not.toContain("dev:");
    expect(yaml).toContain("servers:");
    expect(yaml).toContain("composer run dev");
    expect(yaml).toContain("port: 8000");
    expect(yaml).toContain("portEnv: SERVER_PORT");
    expect(yaml).toContain("setup:");
    expect(yaml).toContain("composer install");

    // Should contain env file vars
    expect(yaml).toContain("APP_KEY");

    // Should contain guidance section
    expect(yaml).toContain("guidance:");

    // Should be valid YAML
    const parsed = Bun.YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed.version).toBe(2);
    expect(parsed.name).toBe("Blog");
    expect(parsed.servers).toBeTruthy();
    expect(parsed.setup).toBeTruthy();
  });

  it("round-trips exportUrlAs and portEnv into herman.yaml", () => {
    const yaml = serializeHermanYaml({
      id: "custom",
      frontmatter: {
        version: 2,
        name: "Multi",
        servers: [
          {
            id: "api",
            label: "API",
            command: "bun run dev:api",
            port: 3010,
            exportUrlAs: ["API_SERVER", "API_URL"],
          },
          {
            id: "web",
            label: "Website",
            command: "bun run dev:web",
            port: 3000,
            portEnv: "PORT",
            primary: true,
          },
        ],
      },
      sections: {},
      serialized: "",
    });

    expect(yaml).toContain("exportUrlAs:");
    expect(yaml).toContain("API_SERVER");
    expect(yaml).toContain("API_URL");
    expect(yaml).toContain("portEnv: PORT");

    const parsed = Bun.YAML.parse(yaml) as {
      servers: Array<{ id: string; exportUrlAs?: string | string[]; portEnv?: string | string[] }>;
    };
    const api = parsed.servers.find((s) => s.id === "api");
    expect(api?.exportUrlAs).toEqual(["API_SERVER", "API_URL"]);
    const web = parsed.servers.find((s) => s.id === "web");
    expect(web?.portEnv).toBe("PORT");
  });
});

describe("readProjectManifest", () => {
  it("reads a v2 herman.yaml file", async () => {
    const dir = makeTempDir("yaml");
    const yaml = `version: 2
name: Test Project
setup:
  - id: install
    label: Installing dependencies
    run: npm install
servers:
  - id: web
    label: Website
    command: npm run dev
    port: 3000
    primary: true
env:
  files:
    - path: .env.local
      vars:
        API_KEY:
          required: true
guidance: Keep it simple.
requirements:
  - id: node
    label: Node.js
    check: node --version
`;
    writeFileSync(join(dir, "herman.yaml"), yaml);

    const manifest = await readProjectManifest(dir);
    expect(manifest).toBeTruthy();
    expect(manifest!.servers).toHaveLength(1);
    expect(manifest!.servers[0]!.command).toBe("npm run dev");
    expect(manifest!.servers[0]!.port).toBe(3000);
    expect(manifest!.primary?.command).toBe("npm run dev");
    expect(manifest!.setup?.[0]?.run).toBe("npm install");
    expect(manifest!.devCommand).toBe("npm run dev");
    expect(manifest!.devPort).toBe(3000);
    expect(manifest!.guidance).toBe("Keep it simple.");
    expect(manifest!.env?.files[0]?.path).toBe(".env.local");
    expect(Object.keys(manifest!.env?.files[0]?.vars ?? {})).toEqual(["API_KEY"]);
    expect(manifest!.requirements).toHaveLength(1);

    removeTestTempDir(dir);
  });

  it("migrates a v1 herman.yaml on read", async () => {
    const dir = makeTempDir("yaml-v1");
    // The real-world v1 shape (mamine-cooking-v2): dev.install + dev.servers + env.vars
    const yaml = `version: 1
name: Cooking
dev:
  install: composer run setup
  servers:
    - id: web
      label: Website
      command: composer run dev
      port: 8000
      primary: true
env:
  file: .env
  vars:
    - key: APP_KEY
      required: true
      generate: php artisan key:generate --show
    - key: DB_CONNECTION
      default: sqlite
`;
    writeFileSync(join(dir, "herman.yaml"), yaml);

    const manifest = await readProjectManifest(dir);
    expect(manifest).toBeTruthy();
    // dev.install → setup step (idempotency comes from the stamp, not heuristics)
    expect(manifest!.setup).toEqual([
      { id: "install", label: "Running project setup", run: "composer run setup" },
    ]);
    // dev.servers → servers
    expect(manifest!.servers[0]!.command).toBe("composer run dev");
    expect(manifest!.servers[0]!.port).toBe(8000);
    // env.file + env.vars[] → env.files[]
    expect(manifest!.env?.files).toHaveLength(1);
    expect(manifest!.env?.files[0]?.path).toBe(".env");
    expect(manifest!.env?.files[0]?.vars?.APP_KEY?.generate).toBe(
      "php artisan key:generate --show",
    );
    expect(manifest!.env?.files[0]?.vars?.DB_CONNECTION?.value).toBe("sqlite");

    removeTestTempDir(dir);
  });

  it("falls back to HERMAN.md when herman.yaml is absent", async () => {
    const dir = makeTempDir("herman-md-fallback");
    const md = `---
version: 2
name: MD Project
servers:
  - id: web
    label: Web
    command: echo dev
    port: 8080
    primary: true
---

## Setup
Run it.
`;
    writeFileSync(join(dir, "HERMAN.md"), md);

    const manifest = await readProjectManifest(dir);
    expect(manifest).toBeTruthy();
    expect(manifest!.servers).toHaveLength(1);
    expect(manifest!.servers[0]!.port).toBe(8080);

    removeTestTempDir(dir);
  });

  it("prefers herman.yaml over HERMAN.md when both exist", async () => {
    const dir = makeTempDir("both");
    writeFileSync(join(dir, "herman.yaml"), `version: 2
name: YAML Wins
servers:
  - id: web
    label: Yaml Web
    command: yarn dev
    port: 4000
    primary: true
`);
    writeFileSync(join(dir, "HERMAN.md"), `---
version: 2
name: MD Project
---

`);
    const manifest = await readProjectManifest(dir);
    expect(manifest).toBeTruthy();
    expect(manifest!.servers[0]!.port).toBe(4000);
    expect(manifest!.servers[0]!.command).toBe("yarn dev");

    removeTestTempDir(dir);
  });

  it("falls back to HERMAN.md when herman.yaml is invalid", async () => {
    const dir = makeTempDir("invalid-yaml");
    // herman.yaml is missing required `version: number` — zod rejects it
    writeFileSync(join(dir, "herman.yaml"), `name: Broken\nservers:\n  - command: echo\n`);
    writeFileSync(join(dir, "HERMAN.md"), `---\nversion: 2\nservers:\n  - id: web\n    label: Web\n    command: echo fallback\n    port: 9999\n    primary: true\n---\n`);

    const manifest = await readProjectManifest(dir);
    expect(manifest).toBeTruthy();
    expect(manifest!.servers[0]!.port).toBe(9999);
    expect(manifest!.servers[0]!.command).toBe("echo fallback");

    removeTestTempDir(dir);
  });

  it("returns undefined when no manifest exists", async () => {
    const dir = makeTempDir("empty");
    const manifest = await readProjectManifest(dir);
    expect(manifest).toBeUndefined();
    removeTestTempDir(dir);
  });

  it("falls back to projectRoot when worktree folder has no manifest", async () => {
    const projectRoot = makeTempDir("project-root");
    const worktree = makeTempDir("worktree-no-manifest");
    writeFileSync(
      join(projectRoot, "herman.yaml"),
      `version: 2
servers:
  - id: web
    label: Website
    command: npm run dev
    port: 3000
    primary: true
`,
    );

    const manifest = await readProjectManifest(worktree, projectRoot);
    expect(manifest).toBeTruthy();
    expect(manifest!.servers[0]!.command).toBe("npm run dev");
    expect(manifest!.servers[0]!.port).toBe(3000);

    removeTestTempDir(projectRoot);
    removeTestTempDir(worktree);
  });
});

describe("setupProjectRepo", () => {
  it("removes old .git, writes herman.yaml, and initializes a new repo", async () => {
    clearTemplateRegistryCache();
    const resolved = await resolveTemplateManifest("blog");
    const dir = makeTempDir("setup");

    // Simulate a cloned repo: create a fake .git dir and an old HERMAN.md
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "HERMAN.md"), "old manifest");
    writeFileSync(join(dir, "index.ts"), "// source");

    await setupProjectRepo(dir, resolved);

    // Old HERMAN.md should be gone
    expect(existsSync(join(dir, "HERMAN.md"))).toBe(false);

    // herman.yaml should exist
    const yamlPath = join(dir, "herman.yaml");
    expect(existsSync(yamlPath)).toBe(true);
    const yamlContent = readFileSync(yamlPath, "utf-8");
    expect(yamlContent).toContain("composer run dev");

    // Should be a valid git repo with at least one commit
    const { git } = await import("../../src/bun/rewind-core.js");
    const branch = await git("rev-parse --abbrev-ref HEAD", dir);
    expect(branch).toBe("main");

    // herman.yaml should be tracked (committed)
    const tracked = await git("ls-files herman.yaml", dir);
    expect(tracked).toContain("herman.yaml");

    removeTestTempDir(dir);
  });
});
