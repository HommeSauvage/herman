import { describe, expect, it } from "vitest";

import { buildSetupGoal, planHash, resolveSetupPlan } from "../../src/bun/setup-plan.js";

describe("resolveSetupPlan", () => {
  it("returns an empty plan for missing manifests", () => {
    const plan = resolveSetupPlan(undefined);
    expect(plan.envFiles).toEqual([]);
    expect(plan.setupSteps).toEqual([]);
    expect(plan.servers).toEqual([]);
    expect(plan.projectName).toBeUndefined();
  });

  it("resolves env files, setup steps, servers and name from frontmatter-shaped input", () => {
    const plan = resolveSetupPlan({
      name: "Blog",
      env: { files: [{ path: ".env", vars: { A: { value: "1" } } }] },
      setup: [{ id: "deps", label: "Deps", run: "bun install" }],
      servers: [{ id: "web", label: "Web", command: "bun dev", port: 3000, primary: true }],
    });
    expect(plan.envFiles).toHaveLength(1);
    expect(plan.setupSteps[0]?.id).toBe("deps");
    expect(plan.servers[0]?.id).toBe("web");
    expect(plan.projectName).toBe("Blog");
  });
});

describe("planHash", () => {
  it("is stable across key ordering", () => {
    const a = planHash(
      resolveSetupPlan({
        setup: [{ id: "a", label: "A", run: "echo a", skip_if: "x" }],
        servers: [{ id: "web", label: "Web", command: "echo", port: 1 }],
      }),
    );
    const b = planHash(
      resolveSetupPlan({
        setup: [{ run: "echo a", label: "A", id: "a", skip_if: "x" }],
        servers: [{ port: 1, command: "echo", label: "Web", id: "web" }],
      }),
    );
    expect(a).toBe(b);
  });

  it("changes when the manifest changes", () => {
    const base = resolveSetupPlan({
      setup: [{ id: "a", label: "A", run: "echo a" }],
    });
    const changed = resolveSetupPlan({
      setup: [{ id: "a", label: "A", run: "echo b" }],
    });
    expect(planHash(base)).not.toBe(planHash(changed));
  });
});

describe("buildSetupGoal", () => {
  it("renders env files, ordered steps and servers", () => {
    const goal = buildSetupGoal(
      resolveSetupPlan({
        env: {
          files: [
            {
              path: ".env",
              from_example: ".env.example",
              vars: {
                APP_KEY: { generate: "php artisan key:generate --show", required: true },
                DB_CONNECTION: { value: "sqlite" },
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
          { id: "seed", label: "Seeding the database", run: "php artisan db:seed", optional: true },
        ],
        servers: [
          { id: "web", label: "Website", command: "composer run dev", port: 8000, primary: true },
        ],
      }),
    );

    expect(goal).toContain("Workspace setup recipe");
    expect(goal).toContain(".env.example");
    expect(goal).toContain("APP_KEY");
    expect(goal).toContain("1. Installing PHP dependencies: `composer install`");
    expect(goal).toContain("2. Seeding the database: `php artisan db:seed`");
    expect(goal).toContain("optional");
    expect(goal).toContain("composer run dev");
  });

  it("returns empty for an empty plan", () => {
    expect(buildSetupGoal(resolveSetupPlan(undefined))).toBe("");
  });
});
