import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortRegistry } from "../../../src/bun/preview/port-registry.js";
import { readProjectManifest } from "../../../src/bun/project-manifest.js";
import { git } from "../../../src/bun/rewind-core.js";
import {
  SessionBootstrapper,
  type SessionStateChangedPayload,
} from "../../../src/bun/session-bootstrap/bootstrapper.js";
import { parseEnvContent } from "../../../src/bun/session-bootstrap/setup-runner.js";
import { initProjectRepo } from "../../../src/bun/worktree.js";
import { tabScope } from "../../../src/shared/preview.js";
import type { PersistedSession, Tab } from "../../../src/shared/rpc.js";
import { createTestTempDir, removeTestTempDir } from "../../helpers/temp-dir.js";

const dirs: string[] = [];
let binDir: string;
let previousPath: string | undefined;
let previousWorktreesDir: string | undefined;
let worktreesDir: string;
const blockerSockets: Server[] = [];

function makeDir(prefix: string): string {
  const dir = createTestTempDir(`herman-boot-${prefix}-`);
  dirs.push(dir);
  return dir;
}

/** Write an executable shim into the test bin dir. */
function writeShim(name: string, script: string): void {
  const path = join(binDir, name);
  writeFileSync(path, script);
  const { chmodSync } = require("node:fs") as typeof import("node:fs");
  chmodSync(path, 0o755);
}

const LARAVEL_YAML = `version: 2
name: Cooking
env:
  files:
    - path: .env
      from_example: .env.example
      vars:
        APP_KEY:
          generate: php artisan key:generate --show
          required: true
        DB_CONNECTION:
          value: sqlite
        DB_DATABASE:
          value: database/database.sqlite
        SERVER_PORT:
          session: primary_port
        APP_URL:
          session: primary_url
setup:
  - id: php-deps
    label: Installing PHP dependencies
    run: composer install
    skip_if: vendor/autoload.php
  - id: database
    label: Preparing the database
    run: touch database/database.sqlite && php artisan migrate --force
    skip_if: database/database.sqlite
  - id: js-deps
    label: Installing frontend dependencies
    run: bun install
    skip_if: node_modules
servers:
  - id: web
    label: Website
    command: composer run dev
    port: 8000
    portEnv: SERVER_PORT
    primary: true
`;

async function makeLaravelProject(name: string): Promise<string> {
  const dir = makeDir(name);
  writeFileSync(join(dir, "herman.yaml"), LARAVEL_YAML);
  writeFileSync(join(dir, ".env.example"), "APP_NAME=Cooking\nAPP_ENV=local\n");
  writeFileSync(join(dir, "artisan"), "<?php // artisan\n");
  // database/ must contain a tracked file or the worktree checkout has no dir.
  mkdirSync(join(dir, "database", "migrations"), { recursive: true });
  writeFileSync(join(dir, "database", "migrations", "0001_init.sql"), "-- migrations\n");
  writeFileSync(join(dir, ".gitignore"), "vendor\nnode_modules\n.env\ndatabase/*.sqlite\n");
  await initProjectRepo(dir);
  return dir;
}

type Harness = {
  bootstrapper: SessionBootstrapper;
  tabs: Map<string, Tab>;
  sessions: Map<string, PersistedSession>;
  states: SessionStateChangedPayload[];
  agentStarts: string[];
  serverLines: { serverId: string; line: string }[];
  previewStarts: {
    scope: string;
    folderPath: string;
    servers: number;
    reservedPorts: Map<string, { port: number; release: () => Promise<void> }> | undefined;
  }[];
};

function makeHarness(opts?: { mode?: "rookie" | "normal"; failPreview?: boolean }): Harness {
  const tabs = new Map<string, Tab>();
  const sessions = new Map<string, PersistedSession>();
  const states: SessionStateChangedPayload[] = [];
  const agentStarts: string[] = [];
  const serverLines: { serverId: string; line: string }[] = [];
  const previewStarts: Harness["previewStarts"] = [];

  const bootstrapper = new SessionBootstrapper({
    getTab: (tabId) => tabs.get(tabId),
    patchTab: (tabId, patch) => {
      const tab = tabs.get(tabId);
      if (tab) tabs.set(tabId, { ...tab, ...patch, updatedAt: Date.now() });
    },
    getPersisted: (tabId) => sessions.get(tabId),
    patchPersisted: (tabId, patch) => {
      const session = sessions.get(tabId);
      if (session) sessions.set(tabId, { ...session, ...patch });
    },
    isTabOpen: (tabId) => tabs.has(tabId),
    getMode: () => opts?.mode ?? "rookie",
    scheduleAgent: (tabId) => agentStarts.push(tabId),
    emitState: (payload) => states.push(payload),
    emitServerLine: (line) => serverLines.push({ serverId: line.serverId, line: line.line }),
    persist: async () => {},
    portRegistry: new PortRegistry(),
    ensurePreviewStarted: async (scope, folderPath, previewOpts) => {
      if (opts?.failPreview) throw new Error("preview boom");
      previewStarts.push({
        scope,
        folderPath,
        servers: previewOpts.servers?.length ?? 0,
        reservedPorts:
          previewOpts.reservedPorts as Harness["previewStarts"][number]["reservedPorts"],
      });
    },
    readManifest: (folderPath, projectRoot) => readProjectManifest(folderPath, projectRoot),
  });

  return { bootstrapper, tabs, sessions, states, agentStarts, serverLines, previewStarts };
}

function registerTab(harness: Harness, projectRoot: string): Tab {
  const id = crypto.randomUUID();
  const now = Date.now();
  const tab: Tab = {
    id,
    title: "Cooking",
    folderPath: projectRoot,
    projectRoot,
    projectColor: "#fff",
    messages: [],
    isThinking: false,
    showThinking: false,
    thinkingMessages: [],
    availableModels: [],
    connectionState: "idle",
    setup: { phase: "pending", label: "Preparing your session…" },
    createdAt: now,
    updatedAt: now,
    composerValue: "",
    queuedMessages: [],
  };
  harness.tabs.set(id, tab);
  harness.sessions.set(id, {
    id,
    title: tab.title,
    folderPath: projectRoot,
    projectRoot,
    projectColor: "#fff",
    isolation: "worktree",
    createdAt: now,
    updatedAt: now,
  });
  return tab;
}

/** Git-canonical project path (macOS /var → /private/var symlink). */
function realPath(path: string): string {
  return realpathSync(path);
}

async function blockPort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // Already occupied on this machine — the precondition holds.
      if (err.code === "EADDRINUSE") return resolve();
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
  blockerSockets.push(server);
}

beforeEach(() => {
  previousPath = process.env.PATH;
  previousWorktreesDir = process.env.HERMAN_WORKTREES_DIR;
  binDir = makeDir("bin");
  worktreesDir = makeDir("worktrees-root");
  process.env.HERMAN_WORKTREES_DIR = worktreesDir;
  process.env.PATH = `${binDir}:${previousPath}`;

  // composer / php / bun shims — stand-ins for the real toolchains.
  writeShim(
    "composer",
    `#!/bin/sh
if [ "$1" = "install" ]; then
  mkdir -p vendor && echo "<?php // autoload" > vendor/autoload.php
  echo "composer install done"
  exit 0
fi
echo "composer $* (shim)"
exit 0
`,
  );
  writeShim(
    "php",
    `#!/bin/sh
if [ "$1" = "artisan" ] && [ "$2" = "key:generate" ]; then
  echo "base64:generated-app-key"
  exit 0
fi
if [ "$1" = "artisan" ] && [ "$2" = "migrate" ]; then
  echo "migrated (shim)"
  exit 0
fi
echo "php $* (shim)"
exit 0
`,
  );
  writeShim(
    "bun",
    `#!/bin/sh
if [ "$1" = "install" ]; then
  mkdir -p node_modules && echo "{}" > node_modules/.package.json
  echo "bun install done"
  exit 0
fi
exec /bin/sh -c "echo bun $* (shim)"
`,
  );
});

afterEach(async () => {
  process.env.PATH = previousPath;
  if (previousWorktreesDir == null) {
    delete process.env.HERMAN_WORKTREES_DIR;
  } else {
    process.env.HERMAN_WORKTREES_DIR = previousWorktreesDir;
  }
  for (const socket of blockerSockets.splice(0, blockerSockets.length)) {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  for (const dir of dirs.splice(0, dirs.length)) {
    removeTestTempDir(dir);
  }
});

describe("SessionBootstrapper (Laravel fixture, shimmed toolchain)", () => {
  it("runs the full pipeline: worktree → steps in order → agent → preview with SERVER_PORT", async () => {
    const project = await makeLaravelProject("cooking");
    const harness = makeHarness();
    const tab = registerTab(harness, project);

    await harness.bootstrapper.bootstrap(tab.id, { kind: "create" });

    const readyTab = harness.tabs.get(tab.id);
    if (!readyTab) throw new Error("test precondition: expected tab");
    // Isolated workspace created (never the main tree).
    expect(readyTab.folderPath).toBe(join(worktreesDir, tab.id));
    expect(readyTab.folderPath).not.toBe(project);
    expect(readyTab.worktree?.mainFolderPath).toBe(realPath(project));
    expect(readyTab.setup.phase).toBe("ready");

    // The manifest recipe actually ran (this is Bug B's regression test):
    // vendor/ + database/database.sqlite + node_modules exist in the worktree.
    expect(existsSync(join(readyTab.folderPath, "vendor", "autoload.php"))).toBe(true);
    expect(existsSync(join(readyTab.folderPath, "database", "database.sqlite"))).toBe(true);
    expect(existsSync(join(readyTab.folderPath, "node_modules"))).toBe(true);

    // .env provisioned: example carried in, literals + session bindings set,
    // APP_KEY generated AFTER setup steps (needs vendor/).
    const env = parseEnvContent(readFileSync(join(readyTab.folderPath, ".env"), "utf-8"));
    expect(env.get("APP_NAME")).toBe("Cooking");
    expect(env.get("DB_CONNECTION")).toBe("sqlite");
    expect(env.get("APP_KEY")).toBe("base64:generated-app-key");
    const serverPort = Number(env.get("SERVER_PORT"));
    expect(serverPort).toBeGreaterThanOrEqual(8000);
    expect(env.get("APP_URL")).toBe(`http://localhost:${serverPort}`);

    // The .env in the main project was never touched.
    expect(existsSync(join(project, ".env"))).toBe(false);
    expect(existsSync(join(project, "vendor"))).toBe(false);

    // Agent started exactly once, after setup became ready.
    expect(harness.agentStarts).toEqual([tab.id]);
    const readyIdx = harness.states.findIndex((s) => s.setup.phase === "ready");
    expect(readyIdx).toBeGreaterThanOrEqual(0);

    // Preview auto-started per tab, on the worktree, with the SAME port the
    // env file got (pre-reserved before setup ran).
    expect(harness.previewStarts).toHaveLength(1);
    const preview = harness.previewStarts[0];
    if (!preview) throw new Error("test precondition: expected preview start");
    expect(preview.scope).toBe(tabScope(tab.id));
    expect(preview.folderPath).toBe(readyTab.folderPath);
    expect(preview.folderPath).not.toBe(project);
    expect(preview.servers).toBe(1);
    expect(preview.reservedPorts?.get("web")?.port).toBe(serverPort);

    // Bug A regression: every emitted state carries the full payload
    // (setup + folderPath + worktree) — nothing is dropped in forwarding.
    const readyState = harness.states[readyIdx];
    if (!readyState) throw new Error("test precondition: expected ready state");
    expect(readyState.worktree).toEqual(readyTab.worktree);
    expect(readyState.folderPath).toBe(readyTab.folderPath);

    // Step progress was observable: env-base, php-deps, database, js-deps, env-generate.
    const pendingSteps = harness.states
      .filter((s) => s.setup.phase === "pending" && s.setup.steps)
      .flatMap((s) => (s.setup.phase === "pending" ? (s.setup.steps ?? []) : []));
    const seenStepIds = new Set(pendingSteps.map((s) => s.id));
    for (const id of [
      "herman:env-base",
      "php-deps",
      "database",
      "js-deps",
      "herman:env-generate",
    ]) {
      expect(seenStepIds.has(id)).toBe(true);
    }
    // Setup output streamed into the preview-context ring under serverId "setup".
    expect(
      harness.serverLines.some(
        (l) => l.serverId === "setup" && l.line.includes("composer install done"),
      ),
    ).toBe(true);

    // Session persisted with the plan hash + completion time.
    const persisted = harness.sessions.get(tab.id);
    if (!persisted) throw new Error("test precondition: expected session");
    expect(persisted.setupCompletedAt).toBeTruthy();
    expect(persisted.setupPlanHash).toBeTruthy();

    // The stamp dir is excluded from git status (changes panel stays clean).
    const status = await git("status --porcelain", readyTab.folderPath);
    expect(status).toBe("");
  });

  it("reserves a different port when the preferred one is taken, and stamps it into env + preview", async () => {
    await blockPort(8000);
    const project = await makeLaravelProject("cooking-busy");
    const harness = makeHarness();
    const tab = registerTab(harness, project);

    await harness.bootstrapper.bootstrap(tab.id, { kind: "create" });
    const readyTab = harness.tabs.get(tab.id);
    if (!readyTab) throw new Error("test precondition: expected tab");
    expect(readyTab.setup.phase).toBe("ready");
    const env = parseEnvContent(readFileSync(join(readyTab.folderPath, ".env"), "utf-8"));
    const serverPort = Number(env.get("SERVER_PORT"));
    expect(serverPort).not.toBe(8000);
    expect(harness.previewStarts[0]?.reservedPorts?.get("web")?.port).toBe(serverPort);
  });

  it("resumes a crashed setup, running only the missing steps", async () => {
    const project = await makeLaravelProject("cooking-resume");
    const harness = makeHarness();
    const tab = registerTab(harness, project);

    await harness.bootstrapper.bootstrap(tab.id, { kind: "create" });
    const readyTab = harness.tabs.get(tab.id);
    if (!readyTab) throw new Error("test precondition: expected tab");
    expect(readyTab.setup.phase).toBe("ready");

    // Simulate a crash + restart: new bootstrapper instance, same on-disk state.
    const harness2 = makeHarness();
    harness2.tabs.set(tab.id, { ...readyTab, setup: { phase: "pending", label: "Checking…" } });
    const existingSession = harness.sessions.get(tab.id);
    if (!existingSession) throw new Error("test precondition: expected session");
    harness2.sessions.set(tab.id, existingSession);

    await harness2.bootstrapper.bootstrap(tab.id, { kind: "repair" });

    const repaired = harness2.tabs.get(tab.id);
    if (!repaired) throw new Error("test precondition: expected repaired tab");
    expect(repaired.setup.phase).toBe("ready");
    // Setup steps were stamp-skipped: vendor/ was not re-created (mtime unchanged is hard
    // to assert — instead assert no second composer install line streamed).
    expect(
      harness2.serverLines.filter((l) => l.line.includes("composer install done")),
    ).toHaveLength(0);
    // Agent + preview restarted after repair.
    expect(harness2.agentStarts).toEqual([tab.id]);
    expect(harness2.previewStarts).toHaveLength(1);
  });

  it("marks retryable error on setup failure and still starts the agent in the worktree", async () => {
    const project = await makeLaravelProject("cooking-fail");
    // Break the database step.
    writeShim(
      "php",
      `#!/bin/sh
if [ "$1" = "artisan" ] && [ "$2" = "migrate" ]; then
  echo "SQLSTATE: connection refused" >&2
  exit 1
fi
if [ "$1" = "artisan" ] && [ "$2" = "key:generate" ]; then
  echo "base64:generated-app-key"
  exit 0
fi
exit 0
`,
    );
    const harness = makeHarness();
    const tab = registerTab(harness, project);

    await harness.bootstrapper.bootstrap(tab.id, { kind: "create" });

    const failedTab = harness.tabs.get(tab.id);
    if (!failedTab) throw new Error("test precondition: expected tab");
    expect(failedTab.setup.phase).toBe("error");
    if (failedTab.setup.phase === "error") {
      expect(failedTab.setup.step).toBe("database");
      expect(failedTab.setup.retryable).toBe(true);
      expect(failedTab.setup.error).toContain("Preparing the database failed");
    }
    // The workspace exists and the agent still starts in it (Q2: the agent
    // is the best fixer, runs in the same workspace).
    expect(failedTab.folderPath).toBe(join(worktreesDir, tab.id));
    expect(harness.agentStarts).toEqual([tab.id]);
    // No preview auto-start on failure.
    expect(harness.previewStarts).toHaveLength(0);

    // Fix the shim and retry — the pipeline resumes and completes.
    writeShim(
      "php",
      `#!/bin/sh
if [ "$1" = "artisan" ] && [ "$2" = "key:generate" ]; then
  echo "base64:generated-app-key"
  exit 0
fi
echo "php $* (shim)"
exit 0
`,
    );
    const retry = await harness.bootstrapper.retry(tab.id);
    expect(retry.ok).toBe(true);
    const retried = harness.tabs.get(tab.id);
    if (!retried) throw new Error("test precondition: expected tab");
    expect(retried.setup.phase).toBe("ready");
    expect(existsSync(join(retried.folderPath, "database", "database.sqlite"))).toBe(true);
    expect(harness.previewStarts).toHaveLength(1);
  });

  it("direct sessions (normal mode) skip setup and previews", async () => {
    const project = await makeLaravelProject("cooking-normal");
    const harness = makeHarness({ mode: "normal" });
    const tab = registerTab(harness, project);
    harness.tabs.set(tab.id, { ...tab, setup: { phase: "none" } });
    const directSession = harness.sessions.get(tab.id);
    if (!directSession) throw new Error("test precondition: expected session");
    harness.sessions.set(tab.id, { ...directSession, isolation: "direct" });

    await harness.bootstrapper.bootstrap(tab.id, { kind: "create" });

    expect(harness.tabs.get(tab.id)?.setup.phase).toBe("none");
    expect(harness.agentStarts).toEqual([tab.id]);
    expect(harness.previewStarts).toHaveLength(0);
    // No worktree was created for a direct session.
    expect(harness.tabs.get(tab.id)?.folderPath).toBe(project);
  });
});
