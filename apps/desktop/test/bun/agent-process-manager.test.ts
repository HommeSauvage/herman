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
import type { PersistedSession } from "../../src/bun/window-state.js";

let tempDir: string;
let mockInstances: MockAgentBridge[] = [];
const originalFetch = globalThis.fetch;
/** ≥20-char UUID so extractPiSessionIdFromFilePath accepts it. */
const DEFAULT_PI_SESSION_ID = "019f442d-33f0-75c3-a71e-54e95c3e27fe";

const mockSessionMessages = new Map<
  string,
  Array<Record<string, unknown>>
>();
const mockGetStateSessionIds = new Map<string, string>();
const mockGetMessagesDelays = new Map<string, { emptyAttempts: number }>();
const mockGetMessagesFailures = new Set<string>();
const mockSetModelFailures = new Set<string>();
const tabModelChangedEvents: { tabId: string; currentModel?: string }[] = [];

class MockAgentBridge {
  tabId: string;
  started = false;
  stopped = false;
  folderPath?: string;
  lastStartOpts?: { piSessionId?: string };
  getMessagesAttempts = 0;
  setModelCalls: { provider: string; modelId: string }[] = [];
  onEvent?: (tabId: string, event: AgentEvent) => void;
  onStatusChange?: (tabId: string, state: string, stderr?: string) => void;

  constructor(
    tabId: string,
    sendToRenderer: (tabId: string, event: AgentEvent) => void,
    onStatusChange: (tabId: string, state: string, stderr?: string) => void,
    onEvent?: (tabId: string, event: AgentEvent) => void,
  ) {
    this.tabId = tabId;
    this.onEvent = onEvent;
    this.onStatusChange = onStatusChange;
    mockInstances.push(this);
    if (!mockSessionMessages.has(tabId)) {
      mockSessionMessages.set(tabId, []);
    }
  }

  async start(folderPath?: string, opts?: { piSessionId?: string }) {
    this.started = true;
    this.stopped = false;
    this.folderPath = folderPath;
    this.lastStartOpts = opts;
    this.onStatusChange?.(this.tabId, "running");
  }

  async stop() {
    this.stopped = true;
  }

  async restart(folderPath?: string, opts?: { piSessionId?: string }) {
    await this.start(folderPath, opts);
  }

  cleanupPersistentState() {
    mockSessionMessages.delete(this.tabId);
  }

  async sendCommand(command: { type?: string; message?: string; provider?: string; modelId?: string }) {
    if (command.type === "set_model") {
      this.setModelCalls.push({
        provider: command.provider ?? "",
        modelId: command.modelId ?? "",
      });
      if (mockSetModelFailures.has(this.tabId)) {
        return {
          type: "response" as const,
          command: "set_model",
          success: false as const,
          error: `Model not found: ${command.provider}/${command.modelId}`,
        };
      }
      return { type: "response" as const, command: "set_model", success: true as const };
    }
    if (command.type === "get_state") {
      return {
        type: "response" as const,
        command: "get_state",
        success: true as const,
        data: {
          sessionId:
            this.lastStartOpts?.piSessionId ??
            mockGetStateSessionIds.get(this.tabId) ??
            "mock-session",
        },
      };
    }
    if (command.type === "get_messages") {
      this.getMessagesAttempts++;
      const delayed = mockGetMessagesDelays.get(this.tabId);
      if (delayed && this.getMessagesAttempts <= delayed.emptyAttempts) {
        return {
          type: "response" as const,
          command: "get_messages",
          success: true as const,
          data: { messages: [] },
        };
      }
      if (mockGetMessagesFailures.has(this.tabId)) {
        throw new Error("get_messages failed");
      }
      return {
        type: "response" as const,
        command: "get_messages",
        success: true as const,
        data: { messages: mockSessionMessages.get(this.tabId) ?? [] },
      };
    }
    if (command.type === "prompt" && command.message) {
      const messages = mockSessionMessages.get(this.tabId) ?? [];
      messages.push({ id: `msg-${messages.length + 1}`, role: "user", content: command.message });
      mockSessionMessages.set(this.tabId, messages);
    }
    return { type: "response" as const, command: command.type ?? "prompt", success: true as const };
  }

  sendRaw(_command: unknown) {}
  getRecentEvents() {
    return [];
  }
  getStderr() {
    return "";
  }

  get state() {
    return this.started && !this.stopped ? "running" : "idle";
  }

  getState() {
    return this.state;
  }

  emitEvent(event: AgentEvent) {
    this.onEvent?.(this.tabId, event);
  }
}

beforeEach(() => {
  tempDir = createTestTempDir("herman-apm-");
  mockInstances = [];
  mockSessionMessages.clear();
  mockGetStateSessionIds.clear();
  mockGetMessagesDelays.clear();
  mockGetMessagesFailures.clear();
  mockSetModelFailures.clear();
  tabModelChangedEvents.length = 0;
  setHermantAppDir(tempDir);
  mock.module("../../src/bun/agent-bridge.js", () => ({
    AgentBridge: MockAgentBridge,
  }));
});

afterEach(() => {
  clearHermantAppDir(tempDir);
  mock.restore();
  globalThis.fetch = originalFetch;
});

async function drainAgent(manager: Awaited<ReturnType<typeof createManager>>): Promise<void> {
  await manager.waitForAgentRuntime();
}

/** Wait for the background bootstrap to finish (rookie git projects). */
async function waitForWorktreeReady(
  manager: Awaited<ReturnType<typeof createManager>>,
  tabId: string,
  timeoutMs = 15_000,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = manager.getTab(tabId);
    if (tab?.setup.phase === "ready" && tab.worktree) return tab;
    if (tab?.setup.phase === "error") {
      throw new Error(tab.setup.error ?? "workspace setup failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for worktree on tab ${tabId}`);
}

function writePiSessionFile(
  _tabId: string,
  lines: string[],
  sessionId = DEFAULT_PI_SESSION_ID,
): void {
  const sessionsDir = join(tempDir, "agent", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `2026-07-09T00-00-00-000Z_${sessionId}.jsonl`),
    lines.join("\n") + "\n",
  );
}

function piSessionLines(
  messages: Array<Record<string, unknown>>,
  sessionId = DEFAULT_PI_SESSION_ID,
): string[] {
  return [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-07-09T00:00:00.000Z",
      cwd: "/project",
    }),
    ...messages.map((message, index) =>
      JSON.stringify({
        type: "message",
        id: `entry-${index + 1}`,
        parentId: index === 0 ? null : `entry-${index}`,
        timestamp: `2026-07-09T00:00:0${index + 1}.000Z`,
        message,
      }),
    ),
  ];
}

/** Write JSONL and persist piSessionId via mock get_state + capture on restart. */
async function attachPiSession(
  manager: Awaited<ReturnType<typeof createManager>>,
  tabId: string,
  messages: Array<Record<string, unknown>>,
  sessionId = DEFAULT_PI_SESSION_ID,
): Promise<string> {
  writePiSessionFile(tabId, piSessionLines(messages, sessionId), sessionId);
  mockGetStateSessionIds.set(tabId, sessionId);
  await manager.restartTabAgent(tabId);
  return sessionId;
}

async function createManager(
  options: {
    getToken?: () => Promise<string | undefined>;
    getHermanEnabled?: () => boolean;
    getMode?: () => "rookie" | "normal" | undefined;
    fetchImpl?: typeof fetch;
    onSessionsChanged?: (sessions: PersistedSession[]) => void;
    getNewTabModel?: () => string | undefined;
    onExplicitModelSelection?: (modelId: string) => void;
    onAgentModelsSync?: (models: string[]) => void;
  } = {},
) {
  const { AgentProcessManager } = await import("../../src/bun/agent-process-manager.js");
  if (options.fetchImpl) {
    globalThis.fetch = options.fetchImpl;
  }
  const { onSessionsChanged, ...rest } = options;
  return new AgentProcessManager({
    serverUrl: "http://localhost:4000",
    getToken: rest.getToken ?? (async () => undefined),
    getHermanEnabled: rest.getHermanEnabled ?? (() => true),
    getMode: rest.getMode ?? (() => "normal"),
    getNewTabModel: rest.getNewTabModel,
    onExplicitModelSelection: rest.onExplicitModelSelection,
    onAgentModelsSync: rest.onAgentModelsSync,
    webviewRpc: {
      send: {
        agentEvent: () => {},
        agentStatusChanged: () => {},
        sessionStateChanged: () => {},
        sessionsChanged: (payload) => onSessionsChanged?.(payload.sessions),
        tabMessagesHydrated: () => {},
        tabModelChanged: (payload) => {
          tabModelChangedEvents.push(payload);
        },
      },
    },
  });
}

describe("AgentProcessManager", () => {
  it("createTab creates a tab and starts a bridge", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project", "My session");

    expect(tab.title).toBe("My session");
    expect(tab.folderPath).toBe("/project");
    expect(manager.getTabs().tabs).toHaveLength(1);
    await drainAgent(manager);
    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0].started).toBe(true);
  });

  it("createTab falls back to the active tab folder", async () => {
    const manager = await createManager();
    await manager.createTab("/first-project");
    const tab = await manager.createTab();
    expect(tab.folderPath).toBe("/first-project");
  });

  it("creates a worktree for every rookie tab on a git project", async () => {
    const { git } = await import("../../src/bun/rewind-core.js");
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    writeFileSync(
      join(tempDir, ".gitignore"),
      "node_modules\npackage-lock.json\nbun.lock\nbun.lockb\n",
    );
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    await git("init -b main", tempDir);
    await git("add -A", tempDir);
    await git("-c user.email=herman@local -c user.name=Herman commit -m init", tempDir);
    const manager = await createManager({ getMode: () => "rookie" });
    const first = await manager.createTab(tempDir);
    const second = await manager.createTab(tempDir);
    const firstReady = await waitForWorktreeReady(manager, first.id);
    const secondReady = await waitForWorktreeReady(manager, second.id);
    // mainFolderPath is now normalized to the canonical git root (resolves symlinks)
    expect(firstReady.worktree?.mainFolderPath).toBe(firstReady.projectRoot);
    expect(firstReady.folderPath).toContain(".worktrees");
    expect(secondReady.worktree?.mainFolderPath).toBe(secondReady.projectRoot);
    expect(secondReady.folderPath).toContain(".worktrees");
    expect(firstReady.folderPath).not.toBe(secondReady.folderPath);
    // Both tabs share the same project root
    expect(firstReady.projectRoot).toBe(secondReady.projectRoot);
    // The project root matches the canonical git path
    expect(firstReady.projectRoot).toBe(secondReady.worktree?.mainFolderPath);
  });

  it("closeTab removes the open tab and stops the bridge", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.closeTab(tab.id);

    expect(manager.getTabs().tabs).toHaveLength(0);
    expect(mockInstances[0].stopped).toBe(true);
  });

  it("adopts the wizard's first session through the same worktree pipeline (Bug C)", async () => {
    const { git } = await import("../../src/bun/rewind-core.js");
    writeFileSync(join(tempDir, "index.txt"), "wizard output\n");
    writeFileSync(
      join(tempDir, ".gitignore"),
      "node_modules\npackage-lock.json\nbun.lock\nbun.lockb\n",
    );
    await git("init -b main", tempDir);
    await git("add -A", tempDir);
    await git("-c user.email=herman@local -c user.name=Herman commit -m \"Initial project\"", tempDir);

    const manager = await createManager({ getMode: () => "rookie" });
    // The wizard committed everything, so a worktree from HEAD carries the
    // full wizard output — no special direct-on-main path.
    const tab = await manager.adoptWizardSession(tempDir, "wizard-1");
    expect(tab.setup.phase).toBe("pending");

    const ready = await waitForWorktreeReady(manager, tab.id);
    expect(ready.folderPath).toContain(".worktrees");
    expect(ready.worktree?.mainFolderPath).toBe(ready.projectRoot);
    expect(ready.setup.phase).toBe("ready");

    // The wizard's committed output is present in the isolated workspace.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(ready.folderPath, "index.txt"), "utf-8")).toBe("wizard output\n");

    // The persisted session is pinned to worktree isolation.
    const sessions = manager.getProjectsAndSessions().sessions;
    expect(sessions.find((s) => s.id === tab.id)?.isolation).toBe("worktree");
  });

  it("never silently migrates a direct session into a worktree on reopen", async () => {
    const { git } = await import("../../src/bun/rewind-core.js");
    writeFileSync(join(tempDir, "index.txt"), "v1\n");
    writeFileSync(
      join(tempDir, ".gitignore"),
      "node_modules\npackage-lock.json\nbun.lock\nbun.lockb\n",
    );
    await git("init -b main", tempDir);
    await git("add -A", tempDir);
    await git("-c user.email=herman@local -c user.name=Herman commit -m init", tempDir);

    // Legacy wizard-adopted session: persisted with direct isolation.
    const manager = await createManager({ getMode: () => "rookie" });
    const { saveWindowState } = await import("../../src/bun/window-state.js");
    const now = Date.now();
    await saveWindowState({
      sessions: [
        {
          id: "legacy-direct",
          title: "Legacy",
          folderPath: tempDir,
          projectRoot: tempDir,
          projectColor: "#fff",
          isolation: "direct",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    // Register in the manager's store via restore.
    await manager.restore();

    const tab = await manager.openSession("legacy-direct");
    expect(tab).toBeTruthy();
    // Still direct: no worktree, no pending setup — the tab opens on main.
    expect(tab!.setup.phase).toBe("none");
    expect(tab!.worktree).toBeUndefined();
    expect(tab!.folderPath).toBe(tempDir);
  });

  it("closeTab preserves session archive and history", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await manager.closeTab(tab.id);

    const { sessions } = manager.getProjectsAndSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(tab.id);

    const { loadTabHistory } = await import("../../src/bun/tab-history.js");
    const messages = await loadTabHistory(tab.id);
    expect(messages).toEqual([{ id: expect.any(String), role: "user", content: "hello" }]);
  });

  it("discards empty tabs instead of archiving them", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.setComposerDraft(tab.id, "unsent message");
    await manager.closeTab(tab.id);

    const { sessions } = manager.getProjectsAndSessions();
    expect(sessions).toHaveLength(0);

    const { loadComposerDraft } = await import("../../src/bun/composer-drafts.js");
    expect(await loadComposerDraft(tab.id)).toBe("");

    const { loadTabHistory } = await import("../../src/bun/tab-history.js");
    expect(await loadTabHistory(tab.id)).toEqual([]);
  });

  it("openSession paints from pi JSONL then syncs from agent", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await attachPiSession(manager, tab.id, [{ id: "u1", role: "user", content: "hello" }]);
    await manager.closeTab(tab.id);

    await manager.openSession(tab.id);
    expect(manager.getTabs().tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
    ]);
    mockSessionMessages.set(tab.id, [
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "Hi" },
    ]);
    await manager.retryTabMessageHydration(tab.id);
    expect(manager.getTabs().tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "Hi" },
    ]);
    expect(manager.getMessageHydrationResult(tab.id)?.status).toBe("success");
  });

  it("restore hydrates open tabs from pi JSONL", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const manager = await createManager();
    const tab = await manager.createTab(projectDir);
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await attachPiSession(manager, tab.id, [{ id: "u1", role: "user", content: "hello" }]);
    await manager.closeTab(tab.id);
    await manager.openSession(tab.id);

    const restoredManager = await createManager();
    const restored = await restoredManager.restore();
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
    ]);
    expect(restoredManager.getMessageHydrationResult(tab.id)?.status).toBe("success");
  });

  it("restore skips the agent and surfaces a clear error when the project folder is gone", async () => {
    const projectDir = join(tempDir, "deleted-project");
    mkdirSync(projectDir, { recursive: true });
    const manager = await createManager();
    const tab = await manager.createTab(projectDir);
    await drainAgent(manager);
    const instancesBefore = mockInstances.length;

    // Simulate the folder being moved/deleted while the app is closed.
    rmSync(projectDir, { recursive: true, force: true });

    const restoredManager = await createManager();
    const restored = await restoredManager.restore();
    await restoredManager.waitForAgentRuntime();

    // No new bridge is started for the missing folder...
    expect(mockInstances.length).toBe(instancesBefore);
    // ...and the restored tab carries a clear, actionable error instead of a
    // misleading posix_spawn ENOENT against the agent binary.
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.connectionError).toContain("no longer exists");
    expect(restored.tabs[0]?.connectionError).toContain(projectDir);
  });

  it("reports failed hydration when get_messages returns no data", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    mockSessionMessages.delete(tab.id);
    const bridge = mockInstances[0];
    const originalSendCommand = bridge.sendCommand.bind(bridge);
    bridge.sendCommand = async (command) => {
      if (command.type === "get_messages") {
        return {
          type: "response" as const,
          command: "get_messages",
          success: true as const,
          data: {},
        } as Awaited<ReturnType<typeof originalSendCommand>>;
      }
      return originalSendCommand(command);
    };

    const result = await manager.retryTabMessageHydration(tab.id);
    expect(result.status).toBe("empty");
    expect(result.messages).toEqual([]);
  });

  it("reports empty hydration when agent session has no messages", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    const result = await manager.retryTabMessageHydration(tab.id);
    expect(result.status).toBe("empty");
    expect(result.messages).toEqual([]);
  });

  it("closeProject removes project but keeps sessions with messages", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await manager.closeProject("/project");

    const { projects, sessions } = manager.getProjectsAndSessions();
    expect(projects).not.toContain("/project");
    expect(sessions).toHaveLength(1);
    expect(manager.getTabs().tabs).toHaveLength(0);
  });

  it("persists messages captured from agent events", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });

    const { saveTabHistory, loadTabHistory } = await import("../../src/bun/tab-history.js");
    await saveTabHistory(tab.id, manager.getTabs().tabs[0]?.messages ?? []);
    const messages = await loadTabHistory(tab.id);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: expect.any(String),
      role: "assistant",
      content: "",
      isStreaming: true,
    });
  });

  it("persists user messages from prompt commands", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });

    const { loadTabHistory } = await import("../../src/bun/tab-history.js");
    await manager.closeTab(tab.id);
    const messages = await loadTabHistory(tab.id);

    expect(messages).toEqual([{ id: expect.any(String), role: "user", content: "hello" }]);
  });

  it("generates the title from the first user message in parallel with the agent", async () => {
    const sessionsChanged: PersistedSession[][] = [];
    let fetchCalled = false;
    const manager = await createManager({
      getToken: async () => "test-token",
      onSessionsChanged: (sessions) => sessionsChanged.push(sessions),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        fetchCalled = true;
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          userMessage?: string;
        };
        expect(body).toEqual({ userMessage: "Add a login button" });
        return new Response(JSON.stringify({ title: "Add login button" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const tab = await manager.createTab("/project");

    // sendCommand is awaited and returns immediately even though title fetch is in flight.
    const response = await manager.sendCommand(tab.id, {
      type: "prompt",
      message: "Add a login button",
    });
    expect(response.success).toBe(true);
    expect(fetchCalled).toBe(true);

    // Title fetch is fire-and-forget; wait for the microtask queue to drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const { tabs, activeTabId } = manager.getTabs();
    expect(tabs[0]?.title).toBe("Add login button");
    expect(activeTabId).toBe(tab.id);
    expect(sessionsChanged).toHaveLength(1);
    expect(sessionsChanged[0]?.[0]?.title).toBe("Add login button");
  });

  it("does not regenerate the title on subsequent user messages", async () => {
    let fetchCount = 0;
    const manager = await createManager({
      getToken: async () => "test-token",
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ title: "Follow-up title" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "First message" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.sendCommand(tab.id, { type: "prompt", message: "Second message" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchCount).toBe(1);
  });

  it("keeps the optimistic message title when the server returns an empty title", async () => {
    const manager = await createManager({
      getToken: async () => "test-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ title: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "First message" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getTabs().tabs[0]?.title).toBe("First message");
  });

  it("keeps the optimistic message title when the server returns the fallback placeholder", async () => {
    const manager = await createManager({
      getToken: async () => "test-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ title: "Untitled session" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "First message" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getTabs().tabs[0]?.title).toBe("First message");
  });

  it("persists the optimistic message title when title generation fails", async () => {
    const manager = await createManager({
      getToken: async () => "test-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "Title generation failed" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "First message" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const { sessions } = manager.getProjectsAndSessions();
    expect(sessions[0]?.title).toBe("First message");
  });

  it("setComposerDraft updates the in-memory value and persists after debounce", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.setComposerDraft(tab.id, "draft text");

    expect(manager.getTabs().tabs[0]?.composerValue).toBe("draft text");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { loadComposerDraft } = await import("../../src/bun/composer-drafts.js");
    expect(await loadComposerDraft(tab.id)).toBe("draft text");
  });

  it("persists composer draft when closing a tab with messages", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await manager.setComposerDraft(tab.id, "unsent message");
    await manager.closeTab(tab.id);

    const { loadComposerDraft } = await import("../../src/bun/composer-drafts.js");
    expect(await loadComposerDraft(tab.id)).toBe("unsent message");
  });

  it("restores composer draft when reopening a session with messages", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await manager.setComposerDraft(tab.id, "draft text");
    await manager.closeTab(tab.id);

    const reopened = await manager.openSession(tab.id);
    expect(reopened?.composerValue).toBe("draft text");
  });

  it("clears composer draft after sending a prompt", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.setComposerDraft(tab.id, "unsent message");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.getTabs().tabs[0]?.composerValue).toBe("");
    const { loadComposerDraft } = await import("../../src/bun/composer-drafts.js");
    expect(await loadComposerDraft(tab.id)).toBe("");
  });

  it("updates the assistant message even after tool messages", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });
    mockInstances[0].emitEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    mockInstances[0].emitEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });
    mockInstances[0].emitEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    const messages = manager.getTabs().tabs[0]?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "Hello world" });
  });

  it("clears streaming state when aborting", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });
    mockInstances[0].emitEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });
    mockInstances[0].emitEvent({ type: "agent_start" });

    manager.abortTab(tab.id);

    const reopened = manager.getTabs().tabs[0];
    expect(reopened?.isThinking).toBe(false);
    const asst = reopened?.messages.find((m) => m.role === "assistant");
    expect(asst).toMatchObject({ isStreaming: false });
    const tool = reopened?.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ status: "error", output: "Stopped by user" });
  });

  it("agent_end clears isThinking when the tab has prior message history", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");

    // First turn completed.
    await manager.sendCommand(tab.id, { type: "prompt", message: "first" });
    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });
    mockInstances[0].emitEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "old answer" },
    });
    mockInstances[0].emitEvent({ type: "message_end", message: {} });
    mockInstances[0].emitEvent({
      type: "agent_end",
      messages: [{ role: "user" }, { role: "assistant" }],
    });

    // Second turn in progress.
    await manager.sendCommand(tab.id, { type: "prompt", message: "second" });
    mockInstances[0].emitEvent({ type: "agent_start" });
    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });
    mockInstances[0].emitEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "new answer" },
    });
    expect(manager.getTabs().tabs[0]?.isThinking).toBe(true);

    // agent_end for the second turn should clear isThinking even though the
    // tab has messages from the first turn.
    mockInstances[0].emitEvent({
      type: "agent_end",
      messages: [{ role: "user" }, { role: "assistant" }],
    });

    const updated = manager.getTabs().tabs[0];
    expect(updated?.isThinking).toBe(false);
    const last = updated?.messages[updated.messages.length - 1];
    expect(last).toMatchObject({ role: "assistant", content: "new answer", isStreaming: false });
  });

  it("agent_end clears isThinking when the agent reports toolResult and the tab stores tool", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");

    await manager.sendCommand(tab.id, { type: "prompt", message: "read the file" });
    mockInstances[0].emitEvent({ type: "agent_start" });
    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });
    mockInstances[0].emitEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "I'll read it" },
    });
    mockInstances[0].emitEvent({ type: "message_end", message: {} });

    mockInstances[0].emitEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
    });
    mockInstances[0].emitEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "file content" }] },
      isError: false,
    });

    mockInstances[0].emitEvent({
      type: "message_start",
      message: { role: "assistant" },
    });
    mockInstances[0].emitEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Done" },
    });
    expect(manager.getTabs().tabs[0]?.isThinking).toBe(true);

    // The agent's agent_end carries toolResult messages, but the desktop
    // stores tool results as role "tool".  This must still clear isThinking.
    mockInstances[0].emitEvent({
      type: "agent_end",
      messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
    });

    const updated = manager.getTabs().tabs[0];
    expect(updated?.isThinking).toBe(false);
    const last = updated?.messages[updated.messages.length - 1];
    expect(last).toMatchObject({ role: "assistant", content: "Done", isStreaming: false });
  });

  it("rehydrates assistant and tool messages from pi session JSONL", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "run ls" });
    await attachPiSession(manager, tab.id, [
      { id: "u1", role: "user", content: "run ls" },
      { id: "a1", role: "assistant", content: "Running" },
      {
        id: "t1",
        role: "toolResult",
        toolName: "bash",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "done" }],
      },
    ]);
    await manager.closeTab(tab.id);

    await manager.openSession(tab.id);
    const messages = manager.getTabs().tabs[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolName: "bash",
      status: "done",
      output: "done",
    });
  });

  it("paints instantly from pi session JSONL on reopen", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await attachPiSession(manager, tab.id, [{ id: "u1", role: "user", content: "hello" }]);
    await manager.closeTab(tab.id);

    await manager.openSession(tab.id);
    expect(manager.getTabs().tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
    ]);
    expect(manager.getMessageHydrationResult(tab.id)?.status).toBe("success");
  });

  it("keeps pi-painted messages when background get_messages fails", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await attachPiSession(manager, tab.id, [{ id: "u1", role: "user", content: "hello" }]);
    mockGetMessagesFailures.add(tab.id);
    await manager.closeTab(tab.id);

    await manager.openSession(tab.id);
    expect(manager.getTabs().tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
    ]);
    await drainAgent(manager);
    expect(manager.getTabs().tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
    ]);
    expect(manager.getMessageHydrationResult(tab.id)?.status).toBe("success");
  });

  it("passes piSessionId when restarting the agent bridge", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    const sessionUuid = DEFAULT_PI_SESSION_ID;
    writePiSessionFile(
      tab.id,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionUuid,
          timestamp: "2026-07-09T00:00:00.000Z",
          cwd: "/project",
        }),
      ],
      sessionUuid,
    );
    mockGetStateSessionIds.set(tab.id, sessionUuid);

    // First restart captures the UUID from get_state; second passes it through.
    await manager.restartTabAgent(tab.id);
    await manager.restartTabAgent(tab.id);
    expect(mockInstances.at(-1)?.lastStartOpts?.piSessionId).toBe(sessionUuid);
  });

  it("reopens instantly from history cache when newest pi session file is empty", async () => {
    const sessionUuid = DEFAULT_PI_SESSION_ID;
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await attachPiSession(
      manager,
      tab.id,
      [{ id: "u1", role: "user", content: "hello" }],
      sessionUuid,
    );
    await manager.closeTab(tab.id);

    const sessionsDir = join(tempDir, "agent", "sessions");
    writeFileSync(
      join(sessionsDir, "2026-07-10T00-00-00-000Z_empty-new.jsonl"),
      JSON.stringify({
        type: "session",
        version: 3,
        id: "empty-new",
        timestamp: "2026-07-10T00:00:00.000Z",
        cwd: "/project",
      }) + "\n",
    );

    const { sessions } = manager.getProjectsAndSessions();
    expect(sessions[0]?.piSessionId).toBe(sessionUuid);

    await manager.openSession(tab.id);
    expect(manager.getTabs().tabs[0]?.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
    ]);
    expect(manager.getMessageHydrationResult(tab.id)?.status).toBe("success");
  });

  it("opens a new tab quickly with no messages when no cache exists", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);

    expect(manager.getTabs().tabs[0]?.messages).toEqual([]);
  });

  it("rejects revert when another open tab shares the same folder path", async () => {
    const { git } = await import("../../src/bun/rewind-core.js");
    const { RevertConflictError } = await import("../../src/bun/rewind-manager.js");
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(
      join(tempDir, ".gitignore"),
      "node_modules\npackage-lock.json\nbun.lock\nbun.lockb\n",
    );
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    await git("init -b main", tempDir);
    await git("add -A", tempDir);
    await git("-c user.email=herman@local -c user.name=Herman commit -m init", tempDir);

    const manager = await createManager({ getMode: () => "rookie" });
    const first = await manager.createTab(tempDir);
    const second = await manager.createTab(tempDir);
    const firstReady = await waitForWorktreeReady(manager, first.id);
    await waitForWorktreeReady(manager, second.id);
    await drainAgent(manager);
    await manager.sendCommand(first.id, { type: "prompt", message: "hello" });
    await manager.sendCommand(second.id, { type: "prompt", message: "world" });

    const store = (manager as unknown as { store: { tabs: Map<string, { folderPath: string }> } }).store;
    const secondTab = store.tabs.get(second.id);
    if (secondTab) {
      // Force a shared folderPath conflict (stale createTab() return is still the project root).
      secondTab.folderPath = firstReady.folderPath!;
    }

    const firstMessages = manager.getTabs().tabs.find((t) => t.id === first.id)?.messages ?? [];
    const userIndex = firstMessages.findIndex((m) => m.role === "user");
    await expect(manager.revertTab(first.id, userIndex)).rejects.toBeInstanceOf(RevertConflictError);
  });

  it("unrevert restores files from the safety checkpoint", async () => {
    const { readFileSync } = await import("node:fs");
    const { git, createCheckpoint, getRepoRoot } = await import("../../src/bun/rewind-core.js");
    const { rewindManager } = await import("../../src/bun/rewind-manager.js");

    writeFileSync(join(tempDir, "a.txt"), "v1\n");
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(
      join(tempDir, ".gitignore"),
      "node_modules\npackage-lock.json\nbun.lock\nbun.lockb\n",
    );
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    await git("init -b main", tempDir);
    await git("config user.email test@example.com", tempDir);
    await git("config user.name Test", tempDir);
    await git("add -A", tempDir);
    await git("commit -m init", tempDir);

    const manager = await createManager({ getMode: () => "rookie" });
    const tab = await manager.createTab(tempDir);
    const ready = await waitForWorktreeReady(manager, tab.id);
    await drainAgent(manager);

    const sessionUuid = "019f3f64-46f5-7f30-82f1-c78e8d4a2e2e";
    const appDir = process.env.HERMAN_APP_DIR!;
    const piSessionDir = join(appDir, "agent", "sessions");
    mkdirSync(piSessionDir, { recursive: true });
    writeFileSync(join(piSessionDir, `2026-07-08T00-00-00-000Z_${sessionUuid}.jsonl`), "");
    mockGetStateSessionIds.set(tab.id, sessionUuid);
    await manager.restartTabAgent(tab.id);

    const worktreePath = ready.folderPath!;
    const repoRoot = await getRepoRoot(worktreePath);
    await rewindManager.init(tab.id, worktreePath, sessionUuid);
    await createCheckpoint({
      root: repoRoot,
      id: "cp-before",
      sessionId: sessionUuid,
      trigger: "turn",
      turnIndex: 0,
    });

    writeFileSync(join(worktreePath, "a.txt"), "v2\n");
    await manager.sendCommand(tab.id, { type: "prompt", message: "change file" });
    const messages = manager.getTabs().tabs.find((t) => t.id === tab.id)?.messages ?? [];
    const userIndex = messages.findIndex((m) => m.role === "user");

    const reverted = await manager.revertTab(tab.id, userIndex);
    expect(reverted.revertSafetyCheckpointId).toBeDefined();
    expect(readFileSync(join(worktreePath, "a.txt"), "utf-8")).toBe("v1\n");

    writeFileSync(join(worktreePath, "a.txt"), "v3\n");
    const restored = await manager.unrevertTab(tab.id);
    expect(restored.revertMessageId).toBeUndefined();
    expect(readFileSync(join(worktreePath, "a.txt"), "utf-8")).toBe("v2\n");

    rewindManager.dispose(tab.id);
  });
});

describe("AgentProcessManager model selection", () => {
  function emitModelsSync(
    tabId: string,
    models: string[],
    currentModel?: string,
    instanceIndex = 0,
  ) {
    const bridge = mockInstances[instanceIndex];
    if (!bridge) throw new Error("no mock bridge");
    bridge.emitEvent({
      type: "models_sync",
      models,
      ...(currentModel ? { currentModel } : {}),
    } as AgentEvent);
  }

  it("setTabModel persists the selection for the session, even with no agent running", async () => {
    const manager = await createManager();
    // No folder → no agent bridge is started.
    const tab = await manager.createTab();

    const result = await manager.setTabModel(tab.id, "kimi-k2.7-code", { explicit: true });

    expect(result).toEqual({ ok: true, model: "herman/kimi-k2.7-code", applied: false });
    expect(manager.getTab(tab.id)?.currentModel).toBe("herman/kimi-k2.7-code");
    expect(tabModelChangedEvents).toEqual([
      { tabId: tab.id, currentModel: "herman/kimi-k2.7-code" },
    ]);

    // A new manager (app restart) restores the selection from window state.
    const restoredManager = await createManager();
    const restored = await restoredManager.restore();
    expect(restored.tabs[0]?.currentModel).toBe("herman/kimi-k2.7-code");
  });

  it("applies the desired model once the agent registry advertises it", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);

    // Before any models_sync there is no registry — setTabModel persists but
    // does not fire a blind set_model.
    await manager.setTabModel(tab.id, "herman/kimi", { explicit: true });
    expect(mockInstances[0].setModelCalls).toEqual([]);

    // The first models_sync (registry ready) drives the apply.
    emitModelsSync(tab.id, ["herman/kimi", "herman/glm"], "herman/glm");
    await manager.waitForAgentRuntime();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInstances[0].setModelCalls).toEqual([{ provider: "herman", modelId: "kimi" }]);
  });

  it("does not re-apply when the agent already has the desired model", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);

    emitModelsSync(tab.id, ["herman/kimi"], "herman/kimi");
    await manager.setTabModel(tab.id, "herman/kimi", { explicit: true });
    // Agent already reported kimi as current — no set_model needed.
    expect(mockInstances[0].setModelCalls).toEqual([]);
    // But the tab state and persistence still reflect the explicit choice.
    expect(manager.getTab(tab.id)?.currentModel).toBe("herman/kimi");
  });

  it("waits for a model that is not in the registry and applies it when it appears", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);

    emitModelsSync(tab.id, ["herman/glm"], "herman/glm");
    await manager.setTabModel(tab.id, "herman/kimi", { explicit: true });
    expect(mockInstances[0].setModelCalls).toEqual([]);

    // The model appears in a later sync (e.g. after a server-side change).
    emitModelsSync(tab.id, ["herman/glm", "herman/kimi"], "herman/glm");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInstances[0].setModelCalls).toEqual([{ provider: "herman", modelId: "kimi" }]);
  });

  it("bounds set_model retries per registry snapshot, and a changed list re-opens the budget", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    mockSetModelFailures.add(tab.id);

    await manager.setTabModel(tab.id, "herman/kimi", { explicit: true });

    // The same registry snapshot keeps failing; attempts are capped at 3.
    for (let i = 0; i < 5; i++) {
      emitModelsSync(tab.id, ["herman/kimi", "herman/glm"], "herman/glm");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const attempts = mockInstances[0].setModelCalls.length;
    expect(attempts).toBe(3);

    // A changed registry (new model shows up) earns a fresh budget.
    emitModelsSync(tab.id, ["herman/kimi", "herman/glm", "herman/new"], "herman/glm");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInstances[0].setModelCalls.length).toBeGreaterThan(attempts);
  });

  it("records explicit selections as the last-used model (normalized)", async () => {
    const recorded: string[] = [];
    const manager = await createManager({
      onExplicitModelSelection: (modelId) => recorded.push(modelId),
    });
    const tab = await manager.createTab();

    await manager.setTabModel(tab.id, "kimi", { explicit: true });
    expect(recorded).toEqual(["herman/kimi"]);
  });

  it("adopts the agent-reported model for tabs without a selection, without recording it", async () => {
    const recorded: string[] = [];
    const manager = await createManager({
      onExplicitModelSelection: (modelId) => recorded.push(modelId),
    });
    const tab = await manager.createTab("/project");
    await drainAgent(manager);

    expect(manager.getTab(tab.id)?.currentModel).toBeUndefined();
    emitModelsSync(tab.id, ["herman/glm"], "herman/glm");

    expect(manager.getTab(tab.id)?.currentModel).toBe("herman/glm");
    // Agent defaults are not user choices — the global last-used stays unset.
    expect(recorded).toEqual([]);
  });

  it("restores the persisted model into a fresh agent after restart", async () => {
    const projectDir = join(tempDir, "model-project");
    mkdirSync(projectDir, { recursive: true });
    const manager = await createManager();
    const tab = await manager.createTab(projectDir);
    await drainAgent(manager);
    emitModelsSync(tab.id, ["herman/kimi", "herman/glm"], "herman/glm");
    await manager.setTabModel(tab.id, "herman/kimi", { explicit: true });

    // Simulate app restart: a new manager restores the open tab and starts a
    // fresh bridge; the persisted model is applied on the first models_sync.
    const instancesBefore = mockInstances.length;
    const restoredManager = await createManager();
    await restoredManager.restore();
    await restoredManager.waitForAgentRuntime();
    const freshBridge = mockInstances[instancesBefore];
    expect(freshBridge).toBeDefined();

    freshBridge.emitEvent({
      type: "models_sync",
      models: ["herman/kimi", "herman/glm"],
      currentModel: "herman/glm",
    } as AgentEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(freshBridge.setModelCalls).toEqual([{ provider: "herman", modelId: "kimi" }]);
  });

  it("createTab seeds the model from getNewTabModel", async () => {
    const manager = await createManager({ getNewTabModel: () => "herman/seeded" });
    const tab = await manager.createTab("/project");
    expect(tab.currentModel).toBe("herman/seeded");
  });

  it("openPiSession restores the model the pi session was using", async () => {
    const manager = await createManager();
    const sessionId = "sess-model-test";
    writePiSessionFile(
      "unused-tab",
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-07-09T00:00:00.000Z",
          cwd: "/project",
        }),
        JSON.stringify({
          type: "model_change",
          id: "mc-1",
          parentId: null,
          timestamp: "2026-07-09T00:00:01.000Z",
          provider: "herman",
          modelId: "glm-4.5",
        }),
      ],
      sessionId,
    );

    const tab = await manager.openPiSession("/project", sessionId);

    expect(tab.currentModel).toBe("herman/glm-4.5");
  });

  it("keeps the selected model when reopening a tab from session history", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    emitModelsSync(tab.id, ["herman/kimi", "herman/glm"], "herman/glm");
    await manager.setTabModel(tab.id, "herman/kimi", { explicit: true });

    // Give the session a conversation, then close and reopen from history.
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await attachPiSession(manager, tab.id, [{ id: "u1", role: "user", content: "hello" }]);
    await manager.closeTab(tab.id);

    const sessions = manager.getProjectsAndSessions().sessions;
    expect(sessions[0]?.currentModel).toBe("herman/kimi");

    await manager.openSession(tab.id);
    expect(manager.getTab(tab.id)?.currentModel).toBe("herman/kimi");

    // And the (new) agent gets the persisted model applied on first sync.
    const instancesBefore = mockInstances.length;
    await manager.waitForAgentRuntime();
    const freshBridge = mockInstances[instancesBefore - 1];
    freshBridge.emitEvent({
      type: "models_sync",
      models: ["herman/kimi", "herman/glm"],
      currentModel: "herman/glm",
    } as AgentEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(freshBridge.setModelCalls).toEqual([{ provider: "herman", modelId: "kimi" }]);
  });

  it("falls back to the new-tab model for pi sessions without model history", async () => {
    const manager = await createManager({ getNewTabModel: () => "herman/fallback" });
    const sessionId = "sess-no-model";
    writePiSessionFile(
      "unused-tab",
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-07-09T00:00:00.000Z",
          cwd: "/project",
        }),
      ],
      sessionId,
    );

    const tab = await manager.openPiSession("/project", sessionId);

    expect(tab.currentModel).toBe("herman/fallback");
  });
});
