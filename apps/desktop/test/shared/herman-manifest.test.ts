import { describe, expect, it } from "vitest";

import {
  HermanYamlSchema,
  isV1Manifest,
  migrateV1Manifest,
  normalizePortEnv,
} from "../../src/shared/herman-manifest.js";

describe("migrateV1Manifest", () => {
  it("maps dev.install onto a single setup step and dev.servers onto servers", () => {
    const migrated = migrateV1Manifest({
      version: 1,
      name: "App",
      dev: {
        install: "composer run setup",
        servers: [
          { id: "web", label: "Website", command: "composer run dev", port: 8000, primary: true },
        ],
      },
    }) as Record<string, unknown>;

    expect(migrated.version).toBe(2);
    expect(migrated.dev).toBeUndefined();
    expect(migrated.setup).toEqual([
      { id: "install", label: "Running project setup", run: "composer run setup" },
    ]);
    expect(migrated.servers).toEqual([
      { id: "web", label: "Website", command: "composer run dev", port: 8000, primary: true },
    ]);
  });

  it("groups env vars by file, honoring per-var file overrides", () => {
    const migrated = migrateV1Manifest({
      version: 1,
      env: {
        file: ".env",
        vars: [
          { key: "A", default: "1" },
          { key: "B", file: ".env.local", notes: "extra", required: true },
          { key: "C", generate: "openssl rand -base64 32" },
        ],
      },
    }) as { env: { files: { path: string; vars: Record<string, Record<string, unknown>> }[] } };

    expect(migrated.env.files).toHaveLength(2);
    const env = migrated.env.files.find((f) => f.path === ".env");
    const local = migrated.env.files.find((f) => f.path === ".env.local");
    expect(Object.keys(env?.vars).sort()).toEqual(["A", "C"]);
    expect(env?.vars.A).toEqual({ value: "1" });
    expect(env?.vars.C).toEqual({ generate: "openssl rand -base64 32" });
    expect(local?.vars.B).toEqual({ notes: "extra", required: true });
  });

  it("migrates the real mamine-cooking-v2 herman.yaml shape", () => {
    // Verified on disk 2026-07-19: dev.install composer run setup, server
    // composer run dev port 8000, env APP_KEY/DB_CONNECTION/DB_DATABASE.
    const v1 = {
      version: 1,
      name: "Mamine Cooking V2",
      dev: {
        install: "composer run setup",
        servers: [
          { id: "web", label: "Website", command: "composer run dev", port: 8000, primary: true },
        ],
      },
      env: {
        file: ".env",
        vars: [
          { key: "APP_KEY", required: true, generate: "php artisan key:generate --show" },
          { key: "DB_CONNECTION", required: true, default: "sqlite" },
          { key: "DB_DATABASE", required: true, default: "database/database.sqlite" },
        ],
      },
    };

    expect(isV1Manifest(v1)).toBe(true);
    const migrated = migrateV1Manifest(v1);
    const parsed = HermanYamlSchema.parse(migrated);

    expect(parsed.version).toBe(2);
    expect(parsed.setup).toEqual([
      { id: "install", label: "Running project setup", run: "composer run setup" },
    ]);
    expect(parsed.servers?.[0]?.command).toBe("composer run dev");
    const file = parsed.env?.files[0];
    expect(file?.path).toBe(".env");
    expect(file?.vars?.APP_KEY?.generate).toBe("php artisan key:generate --show");
    expect(file?.vars?.DB_CONNECTION?.value).toBe("sqlite");
    expect(file?.vars?.DB_DATABASE?.value).toBe("database/database.sqlite");
  });

  it("passes v2 documents through untouched", () => {
    const v2 = {
      version: 2,
      setup: [{ id: "deps", label: "Deps", run: "bun install" }],
      env: { files: [{ path: ".env", vars: { A: { value: "1" } } }] },
    };
    expect(isV1Manifest(v2)).toBe(false);
    expect(migrateV1Manifest(v2)).toEqual({ ...v2, version: 2 });
  });
});

describe("HermanYamlSchema (v2)", () => {
  it("round-trips a full v2 document", () => {
    const doc = {
      version: 2,
      name: "Blog",
      description: "A place to write",
      requirements: [{ id: "php", label: "PHP 8.3+", check: "php --version" }],
      env: {
        files: [
          {
            path: ".env",
            from_main: true,
            from_example: ".env.example",
            merge: "missing_only",
            rewrite_paths: true,
            vars: {
              APP_KEY: { generate: "php artisan key:generate --show", required: true },
              SERVER_PORT: { session: "primary_port" },
              APP_URL: { session: "primary_url" },
              DB_DATABASE: { value: "database/database.sqlite" },
            },
          },
        ],
      },
      setup: [
        {
          id: "php-deps",
          label: "Installing PHP dependencies",
          run: "composer install",
          skip_if: "vendor/autoload.php",
        },
        { id: "seed", label: "Seeding", run: "php artisan db:seed", optional: true, timeout: 120 },
      ],
      servers: [
        {
          id: "web",
          label: "Website",
          command: "composer run dev",
          port: 8000,
          portEnv: ["SERVER_PORT"],
          exportUrlAs: "APP_URL",
          primary: true,
        },
      ],
      guidance: "Do things the Laravel way.",
    };

    const parsed = HermanYamlSchema.parse(doc);
    expect(parsed.env?.files[0]?.vars?.SERVER_PORT?.session).toBe("primary_port");
    expect(parsed.setup?.[0]?.skip_if).toBe("vendor/autoload.php");
    expect(parsed.setup?.[1]?.optional).toBe(true);
    expect(parsed.servers?.[0]?.portEnv).toEqual(["SERVER_PORT"]);
  });

  it("rejects version 3 and non-v2 after migration", () => {
    expect(HermanYamlSchema.safeParse({ version: 3 }).success).toBe(false);
  });

  it("rejects unknown session bindings", () => {
    const result = HermanYamlSchema.safeParse({
      version: 2,
      env: { files: [{ path: ".env", vars: { X: { session: "whatever" } } }] },
    });
    expect(result.success).toBe(false);
  });
});

describe("normalizePortEnv", () => {
  it("normalizes string and list forms", () => {
    expect(normalizePortEnv("SERVER_PORT")).toEqual(["SERVER_PORT"]);
    expect(normalizePortEnv(["A", " B ", ""])).toEqual(["A", "B"]);
    expect(normalizePortEnv(undefined)).toEqual([]);
  });
});
