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
  it("produces a pure-YAML manifest from a resolved template", async () => {
    clearTemplateRegistryCache();
    const resolved = await resolveTemplateManifest("blog");
    const yaml = serializeHermanYaml(resolved);

    // No extends, no setup_goal, no markdown sections
    expect(yaml).not.toContain("extends:");
    expect(yaml).not.toContain("setup_goal:");
    expect(yaml).not.toContain("## Setup");
    expect(yaml).not.toContain("## Questions");

    // Should contain resolved dev servers from base
    expect(yaml).toContain("dev:");
    expect(yaml).toContain("servers:");
    // Command may be quoted in YAML (contains colon)
    expect(yaml).toContain("bun run dev:web");
    expect(yaml).toContain("port: 3000");

    // Should contain install command
    expect(yaml).toContain("install: bun install");

    // Should contain env vars
    expect(yaml).toContain("BETTER_AUTH_SECRET");

    // Should contain guidance section
    expect(yaml).toContain("guidance:");
    expect(yaml).toContain("simple content models");

    // Should be valid YAML
    const parsed = Bun.YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.name).toBe("Blog");
    expect(parsed.dev).toBeTruthy();
  });

  it("round-trips exportUrlAs into herman.yaml", () => {
    const yaml = serializeHermanYaml({
      id: "custom",
      frontmatter: {
        version: 1,
        name: "Multi",
        dev: {
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
              primary: true,
            },
          ],
        },
      },
      sections: {},
      serialized: "",
    });

    expect(yaml).toContain("exportUrlAs:");
    expect(yaml).toContain("API_SERVER");
    expect(yaml).toContain("API_URL");

    const parsed = Bun.YAML.parse(yaml) as {
      dev: { servers: Array<{ id: string; exportUrlAs?: string | string[] }> };
    };
    const api = parsed.dev.servers.find((s) => s.id === "api");
    expect(api?.exportUrlAs).toEqual(["API_SERVER", "API_URL"]);
  });
});

describe("readProjectManifest", () => {
  it("reads a herman.yaml file", async () => {
    const dir = makeTempDir("yaml");
    const yaml = `version: 1
name: Test Project
dev:
  install: npm install
  servers:
    - id: web
      label: Website
      command: npm run dev
      port: 3000
      primary: true
env:
  file: .env.local
  vars:
    - key: API_KEY
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
    expect(manifest!.install).toBe("npm install");
    expect(manifest!.devCommand).toBe("npm run dev");
    expect(manifest!.devPort).toBe(3000);
    expect(manifest!.guidance).toBe("Keep it simple.");
    expect(manifest!.env?.file).toBe(".env.local");
    expect(manifest!.env?.vars).toHaveLength(1);
    expect(manifest!.requirements).toHaveLength(1);

    removeTestTempDir(dir);
  });

  it("falls back to HERMAN.md when herman.yaml is absent", async () => {
    const dir = makeTempDir("herman-md-fallback");
    const md = `---
version: 1
name: MD Project
dev:
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
    writeFileSync(join(dir, "herman.yaml"), `version: 1
name: YAML Wins
dev:
  servers:
    - id: web
      label: Yaml Web
      command: yarn dev
      port: 4000
      primary: true
`);
    writeFileSync(join(dir, "HERMAN.md"), `---
version: 1
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
    writeFileSync(join(dir, "herman.yaml"), `name: Broken\ndev:\n  servers:\n    - command: echo\n`);
    writeFileSync(join(dir, "HERMAN.md"), `---\nversion: 1\ndev:\n  servers:\n    - id: web\n      label: Web\n      command: echo fallback\n      port: 9999\n      primary: true\n---\n`);

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
      `version: 1
dev:
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
    expect(yamlContent).toContain("bun run dev:web");

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
