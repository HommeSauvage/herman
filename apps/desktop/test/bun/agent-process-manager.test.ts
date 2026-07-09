import { mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/shared/agent-protocol.js";
import type { PersistedSession } from "../../src/bun/window-state.js";

let tempDir: string;
let mockInstances: MockAgentBridge[] = [];
const mockSessionMessages = new Map<
  string,
  Array<Record<string, unknown>>
>();
const mockGetMessagesDelays = new Map<string, { emptyAttempts: number }>();
const mockGetMessagesFailures = new Set<string>();

class MockAgentBridge {
  tabId: string;
  started = false;
  stopped = false;
  folderPath?: string;
  lastStartOpts?: { piSessionId?: string };
  getMessagesAttempts = 0;
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

  async sendCommand(command: { type?: string; message?: string }) {
    if (command.type === "get_state") {
      return {
        type: "response" as const,
        command: "get_state",
        success: true as const,
        data: { sessionId: this.lastStartOpts?.piSessionId ?? "mock-session" },
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

  emitEvent(event: AgentEvent) {
    this.onEvent?.(this.tabId, event);
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "herman-apm-"));
  mockInstances = [];
  mockSessionMessages.clear();
  mockGetMessagesDelays.clear();
  mockGetMessagesFailures.clear();
  process.env.HERMAN_APP_DIR = tempDir;
  mock.module("../../src/bun/agent-bridge.js", () => ({
    AgentBridge: MockAgentBridge,
    cleanupTabAgentDir: () => {},
    mergeAgentSettings: (existing: Record<string, unknown>, skills: string[]) => ({
      ...existing,
      skills,
    }),
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.HERMAN_APP_DIR;
  mock.restore();
});

async function drainAgent(manager: Awaited<ReturnType<typeof createManager>>): Promise<void> {
  await manager.waitForAgentRuntime();
}

function writePiSessionFile(
  tabId: string,
  lines: string[],
  sessionId = "sess-1",
): void {
  const sessionsDir = join(tempDir, "agent-configs", tabId, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `2026-07-09T00-00-00-000Z_${sessionId}.jsonl`),
    lines.join("\n") + "\n",
  );
}

function piSessionLines(
  messages: Array<Record<string, unknown>>,
): string[] {
  return [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-1",
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

async function createManager(
  options: {
    getToken?: () => Promise<string | undefined>;
    getHermanEnabled?: () => boolean;
    getMode?: () => "rookie" | "normal" | undefined;
    fetchImpl?: typeof fetch;
    onSessionsChanged?: (sessions: PersistedSession[]) => void;
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
    webviewRpc: {
      send: {
        agentEvent: () => {},
        agentStatusChanged: () => {},
        tabFolderChanged: () => {},
        sessionsChanged: (payload) => onSessionsChanged?.(payload.sessions),
        tabMessagesHydrated: () => {},
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

  it("creates a worktree for the second rookie tab on same project", async () => {
    const { git } = await import("../../src/bun/rewind-core.js");
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test", scripts: { dev: "echo dev" } }));
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    await git("init -b main", tempDir);
    await git("add -A", tempDir);
    await git("-c user.email=herman@local -c user.name=Herman commit -m init", tempDir);
    const manager = await createManager({ getMode: () => "rookie" });
    const first = await manager.createTab(tempDir);
    const second = await manager.createTab(tempDir);
    expect(first.folderPath).toBe(tempDir);
    expect(second.worktree?.mainFolderPath).toBe(tempDir);
    expect(second.folderPath).toContain(".worktrees");
  });

  it("closeTab removes the open tab and stops the bridge", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.closeTab(tab.id);

    expect(manager.getTabs().tabs).toHaveLength(0);
    expect(mockInstances[0].stopped).toBe(true);
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
    writePiSessionFile(tab.id, piSessionLines([{ id: "u1", role: "user", content: "hello" }]));
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
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    writePiSessionFile(tab.id, piSessionLines([{ id: "u1", role: "user", content: "hello" }]));
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
    writePiSessionFile(
      tab.id,
      piSessionLines([
        { id: "u1", role: "user", content: "run ls" },
        { id: "a1", role: "assistant", content: "Running" },
        {
          id: "t1",
          role: "toolResult",
          toolName: "bash",
          toolCallId: "tool-1",
          content: [{ type: "text", text: "done" }],
        },
      ]),
    );
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
    writePiSessionFile(tab.id, piSessionLines([{ id: "u1", role: "user", content: "hello" }]));
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
    writePiSessionFile(tab.id, piSessionLines([{ id: "u1", role: "user", content: "hello" }]));
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
    const sessionsDir = join(tempDir, "agent-configs", tab.id, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(
        sessionsDir,
        "2026-07-09T00-00-00-000Z_019f442d-33f0-75c3-a71e-54e95c3e27fe.jsonl",
      ),
      '{"type":"session","version":3,"id":"019f442d-33f0-75c3-a71e-54e95c3e27fe","timestamp":"2026-07-09T00:00:00.000Z","cwd":"/project"}\n',
    );

    await manager.restartTabAgent(tab.id);
    expect(mockInstances.at(-1)?.lastStartOpts?.piSessionId).toBe(
      "019f442d-33f0-75c3-a71e-54e95c3e27fe",
    );
  });

  it("reopens instantly from history cache when newest pi session file is empty", async () => {
    const sessionUuid = "019f442d-33f0-75c3-a71e-54e95c3e27fe";
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await drainAgent(manager);
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    writePiSessionFile(
      tab.id,
      piSessionLines([{ id: "u1", role: "user", content: "hello" }]),
      sessionUuid,
    );
    await manager.closeTab(tab.id);

    const sessionsDir = join(tempDir, "agent-configs", tab.id, "sessions");
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
});
