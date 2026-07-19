import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/shared/agent-protocol.js";
import { clearHermantAppDir, createTestTempDir, setHermantAppDir } from "../helpers/temp-dir.js";
import { DEFAULT_FAKE_MANIFEST, fakeWizardDeps } from "../helpers/wizard-fake-deps.js";

let tempDir: string;
let mockInstances: MockAgentBridge[] = [];

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

  async sendCommand(command: {
    type?: string;
    message?: string;
    provider?: string;
    modelId?: string;
  }) {
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
  tempDir = createTestTempDir("herman-wizard-resume-");
  mockInstances = [];
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

async function advanceToCoding(
  session: { start: (templateId: string, description: string) => Promise<void> },
  projectName: string,
  opts: { alreadyStarted?: boolean } = {},
): Promise<{ projectPath: string; planPath: string; designPath: string }> {
  const { WIZARD_PLAN_FILENAME, WIZARD_DESIGN_FILENAME } = await import(
    "../../src/bun/wizard-session.js"
  );
  const projectPath = join(tempDir, projectName);
  const planPath = join(projectPath, WIZARD_PLAN_FILENAME);
  const designPath = join(projectPath, WIZARD_DESIGN_FILENAME);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(planPath, "# Interview digest\n\nUser wants a cooking blog.\n");

  if (!opts.alreadyStarted) {
    await session.start("blog", "A cooking blog");
  }
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

describe("WizardSession.resume", () => {
  it("sends /goal resume on manual resume instead of re-sending the full coding goal", async () => {
    const { WizardSession, WIZARD_RESUME_GOAL_PROMPT } = await import(
      "../../src/bun/wizard-session.js"
    );

    const session = new WizardSession({ emit: () => {}, deps: fakeDeps() });
    await advanceToCoding(session, "my-blog");

    const codingBridge = mockInstances[2];
    if (!codingBridge) throw new Error("test precondition: expected bridge at index 2");
    expect(codingBridge.prompts[0]).toMatch(/^\/goal /);
    expect(codingBridge.prompts[0]).toContain("Homepage loads");

    const promptsBeforeResume = mockInstances.reduce((n, b) => n + b.prompts.length, 0);
    await session.resume();
    await waitFor(
      () => mockInstances.reduce((n, b) => n + b.prompts.length, 0) > promptsBeforeResume,
    );

    const lastBridge = mockInstances[mockInstances.length - 1];
    if (!lastBridge) throw new Error("test precondition: expected bridge");
    const lastPrompt = lastBridge.prompts[lastBridge.prompts.length - 1];
    expect(lastPrompt).toBe(WIZARD_RESUME_GOAL_PROMPT);
    expect(lastPrompt).not.toContain("Homepage loads");
    expect(lastBridge.lastStartOpts?.piSessionId).toBe("mock-pi-session");
  });

  it("rejects resume after cancel", async () => {
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const session = new WizardSession({ emit: () => {}, deps: fakeDeps() });
    await session.start("blog", "A cooking blog");
    await waitFor(() => mockInstances.length >= 1);

    await session.cancel();

    await expect(session.resume()).rejects.toThrow(/cancelled/i);
  });

  it("WizardSessionManager.resume forwards to the session", async () => {
    const { WizardSessionManager, WIZARD_RESUME_GOAL_PROMPT } = await import(
      "../../src/bun/wizard-session.js"
    );

    const manager = new WizardSessionManager(() => {}, undefined, fakeDeps());
    const id = await manager.start("blog", "A cooking blog");
    const session = manager.get(id);
    if (!session) throw new Error("test precondition: expected session");
    await advanceToCoding(session, "mgr-blog", { alreadyStarted: true });

    const promptsBefore = mockInstances.reduce((n, b) => n + b.prompts.length, 0);
    await manager.resume(id);
    await waitFor(() => mockInstances.reduce((n, b) => n + b.prompts.length, 0) > promptsBefore);

    const lastBridge = mockInstances[mockInstances.length - 1];
    if (!lastBridge) throw new Error("test precondition: expected bridge");
    expect(lastBridge.prompts[lastBridge.prompts.length - 1]).toBe(WIZARD_RESUME_GOAL_PROMPT);
  });

  it("resumes after a terminal wizard_end failure", async () => {
    const { WizardSession, WIZARD_RESUME_GOAL_PROMPT } = await import(
      "../../src/bun/wizard-session.js"
    );

    const events: Array<{ type: string; error?: string }> = [];
    const session = new WizardSession({
      emit: (event) => {
        events.push(event);
      },
      deps: fakeDeps(),
    });
    await advanceToCoding(session, "failed-blog");

    // Simulate exhausted auto-retries ending the session (private end()).
    (session as unknown as { end: (error?: string) => void }).end(
      "Setup failed after 20 attempts: Command prompt timed out after 30000ms",
    );

    expect(events.some((e) => e.type === "wizard_end" && e.error)).toBe(true);

    const promptsBefore = mockInstances.reduce((n, b) => n + b.prompts.length, 0);
    await session.resume();
    await waitFor(() => mockInstances.reduce((n, b) => n + b.prompts.length, 0) > promptsBefore);

    const lastBridge = mockInstances[mockInstances.length - 1];
    if (!lastBridge) throw new Error("test precondition: expected bridge");
    expect(lastBridge.prompts[lastBridge.prompts.length - 1]).toBe(WIZARD_RESUME_GOAL_PROMPT);
  });

  it("throws when the manager has no matching session", async () => {
    const { WizardSessionManager } = await import("../../src/bun/wizard-session.js");
    const manager = new WizardSessionManager(() => {}, undefined, fakeDeps());
    await expect(manager.resume("wizard-missing")).rejects.toThrow(/not found/i);
  });

  it("fromCheckpoint + resume sends /goal resume with the captured pi session", async () => {
    const { WizardSession, WIZARD_RESUME_GOAL_PROMPT, WIZARD_PLAN_FILENAME } = await import(
      "../../src/bun/wizard-session.js"
    );

    const projectPath = join(tempDir, "checkpoint-blog");
    const planPath = join(projectPath, WIZARD_PLAN_FILENAME);
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(planPath, MILESTONE_PLAN);

    const session = await WizardSession.fromCheckpoint(
      {
        id: "wizard-restored",
        templateId: "blog",
        description: "A cooking blog",
        phase: "coding",
        projectPath,
        planPath,
        capturedPiSessionId: "pi-from-disk",
        phaseGoal: "Homepage loads",
        milestoneIndex: 0,
        progressLines: ["Writing: src/index.ts"],
        lastError: "Setup failed after 20 attempts",
        updatedAt: Date.now(),
      },
      { emit: () => {}, deps: fakeDeps() },
    );

    expect(session.getSnapshot().finished).toBe(true);
    expect(session.getSnapshot().capturedPiSessionId).toBe("pi-from-disk");

    await session.resume();
    await waitFor(() => mockInstances.length >= 1 && mockInstances[0]?.prompts.length >= 1);

    const bridge = mockInstances[0];
    if (!bridge) throw new Error("test precondition: expected bridge");
    expect(bridge.prompts[0]).toBe(WIZARD_RESUME_GOAL_PROMPT);
    expect(bridge.lastStartOpts?.piSessionId).toBe("pi-from-disk");
  });

  it("restoreFromDisk discards coding checkpoint when project is missing", async () => {
    const { saveWizardCheckpoint } = await import("../../src/bun/wizard-checkpoint.js");
    const { WizardSessionManager } = await import("../../src/bun/wizard-session.js");

    await saveWizardCheckpoint({
      id: "wizard-gone",
      templateId: "blog",
      description: "A cooking blog",
      phase: "coding",
      projectPath: join(tempDir, "does-not-exist"),
      capturedPiSessionId: "pi-x",
      updatedAt: Date.now(),
    });

    const manager = new WizardSessionManager(() => {}, undefined, fakeDeps());
    const recovery = await manager.restoreFromDisk();
    expect(recovery).not.toBeNull();
    expect(recovery?.resumable).toBe(false);
    expect(recovery?.blockedReason).toMatch(/no longer exists/i);

    const again = await manager.getRecovery();
    expect(again?.resumable).toBe(false);
  });

  it("restoreFromDisk rehydrates a resumable coding checkpoint as paused", async () => {
    const { saveWizardCheckpoint } = await import("../../src/bun/wizard-checkpoint.js");
    const { WizardSessionManager, WIZARD_RESUME_GOAL_PROMPT, WIZARD_PLAN_FILENAME } = await import(
      "../../src/bun/wizard-session.js"
    );

    const projectPath = join(tempDir, "restore-ok");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, WIZARD_PLAN_FILENAME), MILESTONE_PLAN);

    await saveWizardCheckpoint({
      id: "wizard-ok",
      templateId: "blog",
      description: "A cooking blog",
      phase: "coding",
      projectPath,
      planPath: join(projectPath, WIZARD_PLAN_FILENAME),
      capturedPiSessionId: "pi-ok",
      phaseGoal: "Homepage loads",
      milestoneIndex: 0,
      updatedAt: Date.now(),
      lastError: "timed out",
    });

    const manager = new WizardSessionManager(() => {}, undefined, fakeDeps());
    const recovery = await manager.restoreFromDisk();
    expect(recovery?.resumable).toBe(true);
    expect(recovery?.live).toBe(false);
    expect(recovery?.sessionId).toBe("wizard-ok");

    await manager.resume("wizard-ok");
    await waitFor(() => mockInstances.some((b) => b.prompts.includes(WIZARD_RESUME_GOAL_PROMPT)));
  });

  it("cancel does not leave a wizard checkpoint on disk", async () => {
    const { loadWizardCheckpoint } = await import("../../src/bun/wizard-checkpoint.js");
    const { WizardSession } = await import("../../src/bun/wizard-session.js");

    const session = new WizardSession({ emit: () => {}, deps: fakeDeps() });
    await session.start("blog", "A cooking blog");
    await waitFor(() => mockInstances.length >= 1);

    // Allow the start-time persist to land.
    await waitFor(async () => (await loadWizardCheckpoint()) !== null);

    await session.cancel();
    // Flush any in-flight persist that might race the clear.
    await new Promise((r) => setTimeout(r, 50));
    expect(await loadWizardCheckpoint()).toBeNull();
  });

  it("getRecovery prefers a live session over a paused orphan", async () => {
    const { saveWizardCheckpoint } = await import("../../src/bun/wizard-checkpoint.js");
    const { WizardSessionManager, WIZARD_PLAN_FILENAME } = await import(
      "../../src/bun/wizard-session.js"
    );

    const projectPath = join(tempDir, "orphan-blog");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, WIZARD_PLAN_FILENAME), "- [ ] x\n");

    await saveWizardCheckpoint({
      id: "wizard-orphan",
      templateId: "blog",
      description: "orphan",
      phase: "coding",
      projectPath,
      planPath: join(projectPath, WIZARD_PLAN_FILENAME),
      capturedPiSessionId: "pi-orphan",
      updatedAt: Date.now(),
      lastError: "boom",
    });

    const manager = new WizardSessionManager(() => {}, undefined, fakeDeps());
    await manager.restoreFromDisk();
    const liveId = await manager.start("blog", "A new blog");
    await waitFor(() => mockInstances.some((b) => b.started));

    const recovery = await manager.getRecovery();
    expect(recovery?.sessionId).toBe(liveId);
    expect(recovery?.live).toBe(true);
  });
});
