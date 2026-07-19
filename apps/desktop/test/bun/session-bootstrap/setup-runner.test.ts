import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_BASE_STEP_ID,
  ENV_GENERATE_STEP_ID,
  interpolateHermanVars,
  loadSetupStamp,
  mergeEnvContent,
  parseEnvContent,
  rewriteMainRootPaths,
  type SessionBindingValues,
  WorkspaceSetupRunner,
} from "../../../src/bun/session-bootstrap/setup-runner.js";
import { resolveSetupPlan } from "../../../src/bun/setup-plan.js";
import { createTestTempDir, removeTestTempDir } from "../../helpers/temp-dir.js";

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = createTestTempDir(`herman-setup-${prefix}-`);
  dirs.push(dir);
  return dir;
}

function makeBindings(
  workspace: string,
  main: string,
  ports: Record<string, number> = {},
): SessionBindingValues {
  return {
    tabId: "tab-test-1234",
    workspace,
    main,
    branch: "herman/session/tab-test-1234",
    projectName: "Test Project",
    serverPorts: ports,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0, dirs.length)) {
    removeTestTempDir(dir);
  }
});

describe("env file helpers", () => {
  it("parses and merges env content preserving comments", () => {
    const existing = '# comment\nA=1\nB="two words"\n';
    expect(parseEnvContent(existing).get("B")).toBe("two words");
    const merged = mergeEnvContent(existing, { A: "9", C: "three" });
    expect(merged).toContain("# comment");
    expect(merged).toContain("A=9");
    expect(merged).toContain("C=three");
    expect(merged).toContain('B="two words"');
  });

  it("rewrites only values that start with the main root", () => {
    const content = [
      "DB_DATABASE=/main/proj/database/database.sqlite",
      "APP_NAME=my-/main/proj-app",
      "LOG=/elsewhere/file.log",
    ].join("\n");
    const rewritten = rewriteMainRootPaths(content, "/main/proj", "/wt/abc");
    expect(rewritten).toContain("DB_DATABASE=/wt/abc/database/database.sqlite");
    expect(rewritten).toContain("APP_NAME=my-/main/proj-app");
    expect(rewritten).toContain("LOG=/elsewhere/file.log");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description intentionally uses placeholder syntax
  it("interpolates ${HERMAN_*} placeholders", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally testing literal placeholder syntax
      interpolateHermanVars("site-${HERMAN_PROJECT_NAME}-${HERMAN_TAB_ID}", {
        HERMAN_PROJECT_NAME: "Blog",
        HERMAN_TAB_ID: "t1",
      }),
    ).toBe("site-Blog-t1");
    // Unknown placeholders are left as-is.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally testing literal placeholder syntax
    expect(interpolateHermanVars("${HERMAN_NOPE}", {})).toBe("${HERMAN_NOPE}");
  });
});

describe("WorkspaceSetupRunner", () => {
  it("runs setup steps in order and writes the stamp", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [
        { id: "one", label: "Step one", run: "echo first > one.txt" },
        { id: "two", label: "Step two", run: "echo second > two.txt" },
      ],
    });

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "one.txt"), "utf-8")).toContain("first");
    expect(readFileSync(join(workspace, "two.txt"), "utf-8")).toContain("second");

    const stamp = await loadSetupStamp(workspace);
    expect(stamp).toBeTruthy();
    expect(stamp?.completed.one).toBeTruthy();
    expect(stamp?.completed.two).toBeTruthy();
    expect(stamp?.completed[ENV_BASE_STEP_ID]).toBeTruthy();
    expect(stamp?.completed[ENV_GENERATE_STEP_ID]).toBeTruthy();
    expect(stamp?.failed).toBeUndefined();
  });

  it("copies env from main, applies literals and session bindings, rewrites paths", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    mkdirSync(join(main, "database"), { recursive: true });
    writeFileSync(
      join(main, ".env"),
      [
        "APP_NAME=Cooking",
        `DB_DATABASE=${main}/database/database.sqlite`,
        "SECRET_FROM_MAIN=keepme",
        "SERVER_PORT=8000",
      ].join("\n"),
    );

    const plan = resolveSetupPlan({
      env: {
        files: [
          {
            path: ".env",
            vars: {
              DB_CONNECTION: { value: "sqlite" },
              SERVER_PORT: { session: "primary_port" },
              APP_URL: { session: "primary_url" },
            },
          },
        ],
      },
      servers: [{ id: "web", label: "Web", command: "echo dev", port: 8000, primary: true }],
    });

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main, { web: 8123 }),
    });
    expect(result.ok).toBe(true);

    const env = parseEnvContent(readFileSync(join(workspace, ".env"), "utf-8"));
    // Wizard-collected values ride along from main.
    expect(env.get("SECRET_FROM_MAIN")).toBe("keepme");
    expect(env.get("APP_NAME")).toBe("Cooking");
    // Main-root path rewritten into the workspace.
    expect(env.get("DB_DATABASE")).toBe(`${workspace}/database/database.sqlite`);
    // Literal applied (was missing).
    expect(env.get("DB_CONNECTION")).toBe("sqlite");
    // Session binding overrides the main-copied value.
    expect(env.get("SERVER_PORT")).toBe("8123");
    expect(env.get("APP_URL")).toBe("http://localhost:8123");
  });

  it("falls back to from_example, then to creating an empty file", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    writeFileSync(join(workspace, ".env.example"), "FROM_EXAMPLE=1\n");

    const plan = resolveSetupPlan({
      env: {
        files: [
          { path: ".env", from_example: ".env.example" },
          { path: ".env.other", from_example: ".env.missing" },
        ],
      },
    });

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, ".env"), "utf-8")).toContain("FROM_EXAMPLE=1");
    expect(existsSync(join(workspace, ".env.other"))).toBe(true);
  });

  it("honors merge: force vs missing_only for literal values", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    writeFileSync(join(main, ".env"), "A=from-main\n");

    const plan = resolveSetupPlan({
      env: {
        files: [
          { path: ".env", merge: "force", vars: { A: { value: "forced" } } },
          { path: ".env.missing-only", vars: { A: { value: "not-forced" } } },
        ],
      },
    });
    writeFileSync(join(workspace, ".env.missing-only"), "A=existing\n");

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    expect(parseEnvContent(readFileSync(join(workspace, ".env"), "utf-8")).get("A")).toBe("forced");
    expect(
      parseEnvContent(readFileSync(join(workspace, ".env.missing-only"), "utf-8")).get("A"),
    ).toBe("existing");
  });

  it("skips steps via skip_if and skip_if_env", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    writeFileSync(join(workspace, ".env"), "SEEDED=yes\n");

    const plan = resolveSetupPlan({
      env: { files: [{ path: ".env" }] },
      setup: [
        { id: "deps", label: "Deps", run: "echo ran > deps-ran.txt", skip_if: "node_modules" },
        { id: "seed", label: "Seed", run: "echo ran > seed-ran.txt", skip_if_env: "SEEDED" },
        { id: "other", label: "Other", run: "echo ran > other-ran.txt" },
      ],
    });

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(workspace, "deps-ran.txt"))).toBe(false);
    expect(existsSync(join(workspace, "seed-ran.txt"))).toBe(false);
    expect(existsSync(join(workspace, "other-ran.txt"))).toBe(true);
  });

  it("treats optional step failure as a warning and continues", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [
        { id: "seed", label: "Seeding", run: "exit 3", optional: true },
        { id: "after", label: "After", run: "echo ok > after.txt" },
      ],
    });

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.stepId).toBe("seed");
    }
    expect(existsSync(join(workspace, "after.txt"))).toBe(true);
    const stamp = await loadSetupStamp(workspace);
    expect(stamp?.completed.seed?.warning).toBeTruthy();
  });

  it("fails setup on non-optional step failure and records the failed marker", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [
        { id: "boom", label: "Boom step", run: "echo some-output && exit 1" },
        { id: "never", label: "Never", run: "echo no > never.txt" },
      ],
    });

    const runner = new WorkspaceSetupRunner();
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("boom");
      expect(result.error).toContain("Boom step failed");
      expect(result.output).toContain("some-output");
    }
    expect(existsSync(join(workspace, "never.txt"))).toBe(false);
    const stamp = await loadSetupStamp(workspace);
    expect(stamp?.failed?.stepId).toBe("boom");
  });

  it("resumes an interrupted setup, running only the missing steps", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [
        { id: "one", label: "One", run: "echo 1 >> runs.txt" },
        { id: "two", label: "Two", run: "echo 2 >> runs.txt" },
      ],
    });

    // Simulate a completed first run.
    const first = new WorkspaceSetupRunner();
    const r1 = await first.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(r1.ok).toBe(true);
    expect(readFileSync(join(workspace, "runs.txt"), "utf-8").trim().split("\n")).toEqual([
      "1",
      "2",
    ]);

    // Second run: everything already completed — nothing re-runs.
    const second = new WorkspaceSetupRunner();
    const r2 = await second.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(workspace, "runs.txt"), "utf-8").trim().split("\n")).toEqual([
      "1",
      "2",
    ]);
  });

  it("re-runs a completed step when its skip_if path vanished (repair)", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [
        {
          id: "deps",
          label: "Deps",
          run: "mkdir -p node_modules && echo ran >> deps-runs.txt",
          skip_if: "node_modules",
        },
      ],
    });

    const runner = new WorkspaceSetupRunner();
    await runner.run({ workspace, mainRoot: main, plan, bindings: makeBindings(workspace, main) });
    expect(readFileSync(join(workspace, "deps-runs.txt"), "utf-8").trim()).toBe("ran");

    // node_modules deleted behind our back → the step must re-run on resume.
    const { rmSync } = await import("node:fs");
    rmSync(join(workspace, "node_modules"), { recursive: true, force: true });
    const r2 = await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(workspace, "deps-runs.txt"), "utf-8").trim().split("\n")).toEqual([
      "ran",
      "ran",
    ]);
  });

  it("invalidates completed steps when the plan hash changes", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const planV1 = resolveSetupPlan({
      setup: [{ id: "one", label: "One", run: "echo run >> runs.txt" }],
    });

    await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan: planV1,
      bindings: makeBindings(workspace, main),
    });
    expect(readFileSync(join(workspace, "runs.txt"), "utf-8").trim()).toBe("run");

    // Same step id, different command → plan hash changes → re-run.
    const planV2 = resolveSetupPlan({
      setup: [{ id: "one", label: "One", run: "echo run >> runs.txt # changed" }],
    });
    await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan: planV2,
      bindings: makeBindings(workspace, main),
    });
    expect(readFileSync(join(workspace, "runs.txt"), "utf-8").trim().split("\n")).toEqual([
      "run",
      "run",
    ]);
  });

  it("passes HERMAN_* env to setup steps", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [
        {
          id: "env-dump",
          label: "Dump env",
          run: 'echo "$HERMAN_WORKSPACE|$HERMAN_MAIN|$HERMAN_BRANCH|$HERMAN_TAB_ID|$HERMAN_PRIMARY_PORT|$HERMAN_PORT_WEB" > herman-env.txt',
        },
      ],
      servers: [{ id: "web", label: "Web", command: "echo", port: 8000, primary: true }],
    });

    const result = await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main, { web: 8222 }),
    });
    expect(result.ok).toBe(true);
    const dump = readFileSync(join(workspace, "herman-env.txt"), "utf-8").trim();
    expect(dump).toBe(`${workspace}|${main}|herman/session/tab-test-1234|tab-test-1234|8222|8222`);
  });

  it("runs generate commands only for still-missing vars, after setup steps", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    writeFileSync(join(main, ".env"), "PRESENT=already\n");

    const plan = resolveSetupPlan({
      env: {
        files: [
          {
            path: ".env",
            vars: {
              PRESENT: { generate: "echo should-not-run" },
              GENERATED: { generate: "echo generated-value" },
              // Simulates php artisan key:generate --show needing vendor/ first.
              DEPENDS_ON_SETUP: { generate: "cat setup-marker.txt 2>/dev/null || echo missing" },
            },
          },
        ],
      },
      setup: [{ id: "marker", label: "Marker", run: "echo from-setup > setup-marker.txt" }],
    });

    const result = await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    const env = parseEnvContent(readFileSync(join(workspace, ".env"), "utf-8"));
    expect(env.get("PRESENT")).toBe("already");
    expect(env.get("GENERATED")).toBe("generated-value");
    // Ran AFTER the setup step created the marker file.
    expect(env.get("DEPENDS_ON_SETUP")).toBe("from-setup");
  });

  it("fails setup when a required generate command fails", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      env: {
        files: [{ path: ".env", vars: { MUST_HAVE: { generate: "exit 1", required: true } } }],
      },
    });

    const result = await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe(ENV_GENERATE_STEP_ID);
      expect(result.error).toContain("MUST_HAVE");
    }
  });

  it("streams step output lines and step snapshots to callbacks", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    const plan = resolveSetupPlan({
      setup: [{ id: "chatty", label: "Chatty step", run: "echo hello-from-step" }],
    });

    const lines: string[] = [];
    const snapshots: { id: string; status: string }[][] = [];
    const runner = new WorkspaceSetupRunner({
      onLine: (_source, line) => lines.push(line),
      onSteps: (steps) => snapshots.push(steps.map((s) => ({ id: s.id, status: s.status }))),
    });
    const result = await runner.run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    expect(lines).toContain("hello-from-step");
    // Step went pending → running → done across the snapshots.
    const chattyStates = snapshots.map((s) => s.find((x) => x.id === "chatty")?.status);
    expect(chattyStates).toContain("running");
    expect(chattyStates[chattyStates.length - 1]).toBe("done");
  });

  it("re-provisions env-base when a declared env file was deleted", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    writeFileSync(join(main, ".env"), "FROM_MAIN=1\n");

    const plan = resolveSetupPlan({
      env: { files: [{ path: ".env", vars: { LITERAL: { value: "yes" } } }] },
    });

    await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(readFileSync(join(workspace, ".env"), "utf-8")).toContain("FROM_MAIN=1");

    // The env file disappears behind our back → full re-provision on resume.
    const { rmSync } = await import("node:fs");
    rmSync(join(workspace, ".env"));
    const result = await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main),
    });
    expect(result.ok).toBe(true);
    const env = parseEnvContent(readFileSync(join(workspace, ".env"), "utf-8"));
    expect(env.get("FROM_MAIN")).toBe("1");
    expect(env.get("LITERAL")).toBe("yes");
  });

  it("re-applies session bindings on resume without re-copying the main file", async () => {
    const workspace = makeDir("wt");
    const main = makeDir("main");
    writeFileSync(join(main, ".env"), "SERVER_PORT=8000\nEDIT_ME=original\n");

    const plan = resolveSetupPlan({
      env: {
        files: [{ path: ".env", vars: { SERVER_PORT: { session: "primary_port" } } }],
      },
      servers: [{ id: "web", label: "Web", command: "echo", port: 8000, primary: true }],
    });

    await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main, { web: 8100 }),
    });
    let env = parseEnvContent(readFileSync(join(workspace, ".env"), "utf-8"));
    expect(env.get("SERVER_PORT")).toBe("8100");

    // User edits the env file; the main file also changes afterwards.
    writeFileSync(
      join(workspace, ".env"),
      `${readFileSync(join(workspace, ".env"), "utf-8")}USER_EDIT=1\n`,
    );
    writeFileSync(join(main, ".env"), "SERVER_PORT=8000\nEDIT_ME=changed\nNEW_MAIN_VALUE=x\n");

    // Resume with a NEW reserved port: bindings update, nothing else is touched.
    await new WorkspaceSetupRunner().run({
      workspace,
      mainRoot: main,
      plan,
      bindings: makeBindings(workspace, main, { web: 8200 }),
    });
    env = parseEnvContent(readFileSync(join(workspace, ".env"), "utf-8"));
    expect(env.get("SERVER_PORT")).toBe("8200");
    expect(env.get("USER_EDIT")).toBe("1");
    expect(env.get("EDIT_ME")).toBe("original");
    expect(env.get("NEW_MAIN_VALUE")).toBeUndefined();
  });
});
