import { mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import type { AgentEvent } from "../../src/shared/agent-protocol.js";
import type { ResolvedManifest } from "../../src/shared/herman-manifest.js";
import { AgentSpawnError } from "../../src/bun/agent-process.js";

let tempDir: string;
let mockInstances: MockAgentBridge[] = [];
/** When set, the next bridge start() throws this instead of "running". */
let nextStartError: Error | null = null;

class MockAgentBridge {
  tabId: string;
  started = false;
  stopped = false;
  folderPath?: string;
  lastStartOpts?: { piSessionId?: string };
  prompts: string[] = [];
  onEvent?: (tabId: string, event: AgentEvent) => void;
  onStatusChange?: (tabId: string, state: string, stderr?: string) => void;

  constructor(
    tabId: string,
    _sendToRenderer: (tabId: string, event: AgentEvent) => void,
    onStatusChange: (tabId: string, state: string, stderr?: string) => void,
    onEvent?: (tabId: string, event: AgentEvent) => void,
  ) {
    this.tabId = tabId;
    this.onEvent = onEvent;
    this.onStatusChange = onStatusChange;
    mockInstances.push(this);
  }

  async start(folderPath?: string, opts?: { piSessionId?: string }) {
    if (nextStartError) {
      const error = nextStartError;
      nextStartError = null;
      throw error;
    }
    this.started = true;
    this.stopped = false;
    this.folderPath = folderPath;
    this.lastStartOpts = opts;
    this.onStatusChange?.(this.tabId, "running");
    // Unblock WizardSession's models_sync wait.
    queueMicrotask(() => {
      this.onEvent?.(this.tabId, {
        type: "models_sync",
        models: ["herman/test-model"],
        currentModel: "herman/test-model",
      } as AgentEvent);
    });
  }

  async stop() {
    this.stopped = true;
  }

  cleanupPersistentState() {}

  async sendCommand(command: { type?: string; message?: string }) {
    if (command.type === "get_state") {
      return {
        type: "response" as const,
        command: "get_state",
        success: true as const,
        data: { sessionId: this.lastStartOpts?.piSessionId ?? "mock-pi-session" },
      };
    }
    if (command.type === "prompt" && typeof command.message === "string") {
      this.prompts.push(command.message);
    }
    return {
      type: "response" as const,
      command: command.type ?? "prompt",
      success: true as const,
    };
  }

  sendExtensionUiResponse(_requestId: string, _payload: unknown) {}

  emitEvent(event: AgentEvent) {
    this.onEvent?.(this.tabId, event);
  }
}

const mockManifest: ResolvedManifest = {
  id: "blog",
  frontmatter: {
    version: 1,
    name: "Blog",
    description: "A personal blog",
    source: { repo: "https://github.com/example/blog.git", ref: "main" },
    setup_goal: "Homepage loads",
  },
  sections: {
    setup: "Install deps.",
    questions: "- Topics?",
    guidance: "Keep it simple.",
  },
  serialized: "",
};

beforeEach(() => {
  tempDir = createTestTempDir("herman-wizard-spawn-");
  mockInstances = [];
  nextStartError = null;
  setHermantAppDir(tempDir);
  mock.module("../../src/bun/agent-bridge.js", () => ({
    AgentBridge: MockAgentBridge,
  }));
  mock.module("../../src/bun/template-registry.js", () => ({
    resolveTemplateManifest: async () => mockManifest,
  }));
  mock.module("../../src/bun/agent-config-sync.js", () => ({
    resolveWizardExtensionPath: () => [],
  }));
});

afterEach(() => {
  clearHermantAppDir(tempDir);
  mock.restore();
});

function waitFor(
  predicate: () => boolean,
  { timeoutMs = 3_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

type EmittedEvent = { type: string; error?: string; phase?: string };

/** Drive a session through planning into the coding phase. */
async function advanceToCoding(
  session: { start: (templateId: string, description: string) => Promise<void> },
  projectName: string,
): Promise<{ projectPath: string; planPath: string }> {
  const { WIZARD_PLAN_FILENAME } = await import("../../src/bun/wizard-session.js");
  const projectPath = join(tempDir, projectName);
  const planPath = join(projectPath, WIZARD_PLAN_FILENAME);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(planPath, "# Plan\n\n- [ ] Setup\n");

  await session.start("blog", "A cooking blog");
  await waitFor(() => mockInstances.length >= 1 && mockInstances[0]!.prompts.length >= 1);

  mockInstances[0]!.emitEvent({
    type: "tool_execution_start",
    toolName: "herman_complete_planning",
    toolCallId: "tc-1",
    args: { projectPath, planPath },
  } as AgentEvent);

  await waitFor(() => mockInstances.length >= 2 && mockInstances[1]!.prompts.length >= 1);
  return { projectPath, planPath };
}

function emitCompleteWizard(bridge: MockAgentBridge, args: Record<string, unknown>): void {
  bridge.emitEvent({
    type: "tool_execution_start",
    toolName: "herman_complete_wizard",
    toolCallId: "tc-complete",
    args,
  } as AgentEvent);
}

describe("WizardSession project path validation", () => {
  it("ignores a mangled projectPath from herman_complete_wizard and keeps the validated path", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const events: EmittedEvent[] = [];
    const session = new WizardSession({ emit: (event) => events.push(event as EmittedEvent) });
    const { projectPath } = await advanceToCoding(session, "path-blog");

    // The coding agent reports a corrupted path (leading "/" dropped) — the
    // exact failure from production logs that broke the QA phase spawn.
    emitCompleteWizard(mockInstances[1]!, {
      projectPath: `.${projectPath}`,
      summary: "done",
    });

    // QA phase must start in the ORIGINAL validated project folder.
    await waitFor(() => mockInstances.length >= 3 && mockInstances[2]!.prompts.length >= 1);
    expect(mockInstances[2]!.folderPath).toBe(projectPath);
  });

  it("ignores a nonexistent projectPath from herman_complete_wizard", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const session = new WizardSession({ emit: () => {} });
    const { projectPath } = await advanceToCoding(session, "ghost-blog");

    emitCompleteWizard(mockInstances[1]!, {
      projectPath: join(tempDir, "does-not-exist"),
      summary: "done",
    });

    await waitFor(() => mockInstances.length >= 3 && mockInstances[2]!.prompts.length >= 1);
    expect(mockInstances[2]!.folderPath).toBe(projectPath);
  });

  it("accepts the projectPath when it matches the validated one", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const session = new WizardSession({ emit: () => {} });
    const { projectPath } = await advanceToCoding(session, "match-blog");

    emitCompleteWizard(mockInstances[1]!, { projectPath, summary: "done" });

    await waitFor(() => mockInstances.length >= 3 && mockInstances[2]!.prompts.length >= 1);
    expect(mockInstances[2]!.folderPath).toBe(projectPath);
    expect(session.getSnapshot().projectPath).toBe(projectPath);
  });
});

describe("WizardSession deterministic spawn failures", () => {
  it("ends without retrying when the project folder vanishes before a phase start", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const events: EmittedEvent[] = [];
    const session = new WizardSession({ emit: (event) => events.push(event as EmittedEvent) });
    const { projectPath } = await advanceToCoding(session, "vanished-blog");

    // Delete the project folder between phases, then complete coding with the
    // (previously valid) path. The phase guard must fail fast — no retries.
    rmSync(projectPath, { recursive: true, force: true });
    const instancesBefore = mockInstances.length;
    emitCompleteWizard(mockInstances[1]!, { projectPath, summary: "done" });

    await waitFor(() => events.some((e) => e.type === "wizard_end" && !!e.error));
    const end = events.find((e) => e.type === "wizard_end");
    expect(end?.error).toContain("no longer exists");

    // No retry storm: no new bridge starts and no wizard_retrying events.
    await new Promise((r) => setTimeout(r, 100));
    expect(mockInstances.length).toBe(instancesBefore);
    expect(events.some((e) => e.type === "wizard_retrying")).toBe(false);
  });

  it("ends without retrying when the agent binary is missing", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const events: EmittedEvent[] = [];
    const session = new WizardSession({ emit: (event) => events.push(event as EmittedEvent) });
    const { projectPath } = await advanceToCoding(session, "nobin-blog");

    nextStartError = new AgentSpawnError(
      `Agent binary not found: ${join(tempDir, "herman-agent")}`,
      "binary-missing",
      { binaryPath: join(tempDir, "herman-agent"), cwd: projectPath },
    );
    const instancesBefore = mockInstances.length;
    emitCompleteWizard(mockInstances[1]!, { projectPath, summary: "done" });

    await waitFor(() => events.some((e) => e.type === "wizard_end" && !!e.error));
    const end = events.find((e) => e.type === "wizard_end");
    expect(end?.error).toContain("Agent binary not found");

    // Exactly one failed start attempt; no retry storm, no wizard_retrying.
    await new Promise((r) => setTimeout(r, 100));
    expect(mockInstances.length).toBe(instancesBefore + 1);
    expect(events.some((e) => e.type === "wizard_retrying")).toBe(false);
  });

  it("still retries transient spawn failures", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const events: EmittedEvent[] = [];
    const session = new WizardSession({ emit: (event) => events.push(event as EmittedEvent) });
    const { projectPath } = await advanceToCoding(session, "transient-blog");

    // "spawn-failed" (e.g. a resource limit) stays on the retry path; the
    // next attempt succeeds because nextStartError is consumed once.
    nextStartError = new AgentSpawnError(
      "Failed to spawn agent process: posix_spawn failed",
      "spawn-failed",
      { binaryPath: join(tempDir, "herman-agent"), cwd: projectPath },
    );
    emitCompleteWizard(mockInstances[1]!, { projectPath, summary: "done" });

    // Attempt 1 throws (consuming mockInstances[2]); the retry starts a fresh
    // bridge (mockInstances[3]) which succeeds.
    await waitFor(() => events.some((e) => e.type === "wizard_retrying"));
    await waitFor(() => mockInstances.length >= 4 && mockInstances[3]!.prompts.length >= 1, {
      timeoutMs: 8_000,
    });
    expect(mockInstances[3]!.folderPath).toBe(projectPath);
  }, 15_000);
});
