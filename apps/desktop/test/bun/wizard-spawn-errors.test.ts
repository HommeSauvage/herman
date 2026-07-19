import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSpawnError } from "../../src/bun/agent-process.js";
import type { AgentEvent } from "../../src/shared/agent-protocol.js";
import { clearHermantAppDir, createTestTempDir, setHermantAppDir } from "../helpers/temp-dir.js";
import { DEFAULT_FAKE_MANIFEST, fakeWizardDeps } from "../helpers/wizard-fake-deps.js";

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

const fakeDeps = () =>
  fakeWizardDeps({
    createBridge: (...args: ConstructorParameters<typeof MockAgentBridge>) =>
      new MockAgentBridge(...args),
    manifest: DEFAULT_FAKE_MANIFEST,
  });

beforeEach(() => {
  tempDir = createTestTempDir("herman-wizard-spawn-");
  mockInstances = [];
  nextStartError = null;
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
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

const MILESTONE_PLAN = `# Plan

## Milestone 1: Foundation
- [ ] Setup project
Acceptance: App boots

## Milestone 2: Polish
- [ ] Style the home page
Acceptance: Home matches design
`;

const DESIGN_DOC = `# Design

## Design tokens
- colors: warm

## Layout system
- single column

## Page inventory
- \`/\` — Home: landing page
`;

/** Drive a session through planning → design → coding (first milestone). */
async function advanceToCoding(
  session: { start: (templateId: string, description: string) => Promise<void> },
  projectName: string,
): Promise<{ projectPath: string; planPath: string; designPath: string }> {
  const { WIZARD_PLAN_FILENAME, WIZARD_DESIGN_FILENAME } = await import(
    "../../src/bun/wizard-session.js"
  );
  const projectPath = join(tempDir, projectName);
  const planPath = join(projectPath, WIZARD_PLAN_FILENAME);
  const designPath = join(projectPath, WIZARD_DESIGN_FILENAME);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(planPath, "# Interview digest\n\nUser wants a cooking blog.\n");

  await session.start("blog", "A cooking blog");
  await waitFor(() => mockInstances.length >= 1 && mockInstances[0]?.prompts.length >= 1);

  mockInstances[0]?.emitEvent({
    type: "tool_execution_start",
    toolName: "herman_complete_planning",
    toolCallId: "tc-1",
    args: { projectPath, planPath },
  } as AgentEvent);

  await waitFor(() => mockInstances.length >= 2 && mockInstances[1]?.prompts.length >= 1);

  writeFileSync(planPath, MILESTONE_PLAN);
  writeFileSync(designPath, DESIGN_DOC);
  mockInstances[1]?.emitEvent({
    type: "tool_execution_start",
    toolName: "herman_complete_design",
    toolCallId: "tc-2",
    args: { projectPath, designPath, planPath },
  } as AgentEvent);

  await waitFor(() => mockInstances.length >= 3 && mockInstances[2]?.prompts.length >= 1);
  return { projectPath, planPath, designPath };
}

/** Coding/QA advancement is driven by the host gate, not tool_execution_start. */
function getCodingBridge(): MockAgentBridge {
  const bridge = mockInstances[2];
  if (!bridge) throw new Error("test precondition: expected coding bridge");
  return bridge;
}

function emitGateRequest(
  bridge: MockAgentBridge,
  args: { projectPath: string; summary?: string },
): void {
  bridge.emitEvent({
    type: "extension_ui_request",
    id: `gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    method: "editor",
    prefill: JSON.stringify({
      __herman_gate__: true,
      version: 1,
      phase: "coding",
      projectPath: args.projectPath,
      ...(args.summary ? { summary: args.summary } : {}),
    }),
  } as AgentEvent);
}

describe("WizardSession project path validation", () => {
  it("ignores a mangled projectPath from herman_complete_wizard and keeps the validated path", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const events: EmittedEvent[] = [];
    const session = new WizardSession({
      emit: (event) => events.push(event as EmittedEvent),
      deps: fakeDeps(),
    });
    const { projectPath } = await advanceToCoding(session, "path-blog");

    // The coding agent reports a corrupted path (leading "/" dropped) — the
    // exact failure from production logs that broke the next-phase spawn.
    emitGateRequest(getCodingBridge(), {
      projectPath: `.${projectPath}`,
      summary: "done",
    });

    // Next coding milestone must start in the ORIGINAL validated project folder.
    await waitFor(() => mockInstances.length >= 4 && mockInstances[3]?.prompts.length >= 1);
    expect(mockInstances[3]?.folderPath).toBe(projectPath);
  });

  it("ignores a nonexistent projectPath from herman_complete_wizard", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const session = new WizardSession({ emit: () => {}, deps: fakeDeps() });
    const { projectPath } = await advanceToCoding(session, "ghost-blog");

    emitGateRequest(getCodingBridge(), {
      projectPath: join(tempDir, "does-not-exist"),
      summary: "done",
    });

    await waitFor(() => mockInstances.length >= 4 && mockInstances[3]?.prompts.length >= 1);
    expect(mockInstances[3]?.folderPath).toBe(projectPath);
  });

  it("accepts the projectPath when it matches the validated one", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const session = new WizardSession({ emit: () => {}, deps: fakeDeps() });
    const { projectPath } = await advanceToCoding(session, "match-blog");

    emitGateRequest(getCodingBridge(), { projectPath, summary: "done" });

    await waitFor(() => mockInstances.length >= 4 && mockInstances[3]?.prompts.length >= 1);
    expect(mockInstances[3]?.folderPath).toBe(projectPath);
    expect(session.getSnapshot().projectPath).toBe(projectPath);
  });
});

describe("WizardSession deterministic spawn failures", () => {
  it("ends without retrying when the project folder vanishes before a phase start", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const events: EmittedEvent[] = [];
    const session = new WizardSession({
      emit: (event) => events.push(event as EmittedEvent),
      deps: fakeDeps(),
    });
    const { projectPath } = await advanceToCoding(session, "vanished-blog");

    // Delete the project folder between phases, then complete coding with the
    // (previously valid) path. The phase guard must fail fast — no retries.
    rmSync(projectPath, { recursive: true, force: true });
    const instancesBefore = mockInstances.length;
    emitGateRequest(getCodingBridge(), { projectPath, summary: "done" });

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
    const session = new WizardSession({
      emit: (event) => events.push(event as EmittedEvent),
      deps: fakeDeps(),
    });
    const { projectPath } = await advanceToCoding(session, "nobin-blog");

    nextStartError = new AgentSpawnError(
      `Agent binary not found: ${join(tempDir, "herman-agent")}`,
      "binary-missing",
      { binaryPath: join(tempDir, "herman-agent"), cwd: projectPath },
    );
    const instancesBefore = mockInstances.length;
    emitGateRequest(getCodingBridge(), { projectPath, summary: "done" });

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
    const session = new WizardSession({
      emit: (event) => events.push(event as EmittedEvent),
      deps: fakeDeps(),
    });
    const { projectPath } = await advanceToCoding(session, "transient-blog");

    // "spawn-failed" (e.g. a resource limit) stays on the retry path; the
    // next attempt succeeds because nextStartError is consumed once.
    nextStartError = new AgentSpawnError(
      "Failed to spawn agent process: posix_spawn failed",
      "spawn-failed",
      { binaryPath: join(tempDir, "herman-agent"), cwd: projectPath },
    );
    emitGateRequest(getCodingBridge(), { projectPath, summary: "done" });

    // Attempt 1 throws (consuming mockInstances[3]); the retry starts a fresh
    // bridge (mockInstances[4]) which succeeds.
    await waitFor(() => events.some((e) => e.type === "wizard_retrying"));
    await waitFor(() => mockInstances.length >= 5 && mockInstances[4]?.prompts.length >= 1, {
      timeoutMs: 8_000,
    });
    expect(mockInstances[4]?.folderPath).toBe(projectPath);
  }, 15_000);
});
