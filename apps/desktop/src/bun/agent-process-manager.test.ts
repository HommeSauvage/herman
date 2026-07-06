import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../shared/agent-protocol.js";
import type { PersistedSession } from "./window-state.js";

let tempDir: string;
let mockInstances: MockAgentBridge[] = [];

class MockAgentBridge {
  tabId: string;
  started = false;
  stopped = false;
  folderPath?: string;
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
  }

  async start(folderPath?: string) {
    this.started = true;
    this.folderPath = folderPath;
    this.onStatusChange?.(this.tabId, "running");
  }

  async stop() {
    this.stopped = true;
  }

  async restart(folderPath?: string) {
    await this.start(folderPath);
  }

  async sendCommand(command: unknown) {
    return { type: "response" as const, command: "prompt", success: true as const };
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
  process.env.HERMAN_APP_DIR = tempDir;
  mock.module("./agent-bridge.js", () => ({
    AgentBridge: MockAgentBridge,
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.HERMAN_APP_DIR;
});

async function createManager(
  options: {
    getToken?: () => Promise<string | undefined>;
    getHermanEnabled?: () => boolean;
    fetchImpl?: typeof fetch;
    onSessionsChanged?: (sessions: PersistedSession[]) => void;
  } = {},
) {
  const { AgentProcessManager } = await import("./agent-process-manager.js");
  if (options.fetchImpl) {
    globalThis.fetch = options.fetchImpl;
  }
  const { onSessionsChanged, ...rest } = options;
  return new AgentProcessManager({
    serverUrl: "http://localhost:4000",
    getToken: rest.getToken ?? (async () => undefined),
    getHermanEnabled: rest.getHermanEnabled ?? (() => true),
    webviewRpc: {
      send: {
        agentEvent: () => {},
        agentStatusChanged: () => {},
        tabFolderChanged: () => {},
        sessionsChanged: (payload) => onSessionsChanged?.(payload.sessions),
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
    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0].started).toBe(true);
  });

  it("createTab falls back to the active tab folder", async () => {
    const manager = await createManager();
    await manager.createTab("/first-project");
    const tab = await manager.createTab();
    expect(tab.folderPath).toBe("/first-project");
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

    const { loadTabHistory } = await import("./tab-history.js");
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

    const { loadComposerDraft } = await import("./composer-drafts.js");
    expect(await loadComposerDraft(tab.id)).toBe("");

    const { loadTabHistory } = await import("./tab-history.js");
    expect(await loadTabHistory(tab.id)).toEqual([]);
  });

  it("openSession rehydrates from history", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await manager.closeTab(tab.id);

    const reopened = await manager.openSession(tab.id);
    expect(reopened?.messages).toEqual([
      { id: expect.any(String), role: "user", content: "hello" },
    ]);
    expect(manager.getTabs().tabs).toHaveLength(1);
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

    await manager.saveTabHistoryNow(tab.id);
    const { loadTabHistory } = await import("./tab-history.js");
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
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });

    await manager.saveTabHistoryNow(tab.id);
    const { loadTabHistory } = await import("./tab-history.js");
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
    const { loadComposerDraft } = await import("./composer-drafts.js");
    expect(await loadComposerDraft(tab.id)).toBe("draft text");
  });

  it("persists composer draft when closing a tab with messages", async () => {
    const manager = await createManager();
    const tab = await manager.createTab("/project");
    await manager.sendCommand(tab.id, { type: "prompt", message: "hello" });
    await manager.setComposerDraft(tab.id, "unsent message");
    await manager.closeTab(tab.id);

    const { loadComposerDraft } = await import("./composer-drafts.js");
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
    const { loadComposerDraft } = await import("./composer-drafts.js");
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

  it("sanitizes stale streaming messages when rehydrating from history", async () => {
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
    await manager.saveTabHistoryNow(tab.id);
    await manager.closeTab(tab.id);

    const reopened = await manager.openSession(tab.id);
    expect(reopened?.isThinking).toBe(false);
    const asst = reopened?.messages.find((m) => m.role === "assistant");
    expect(asst).toMatchObject({ isStreaming: false });
    const tool = reopened?.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ status: "error", output: "Stopped by user" });
  });
});
