import { mock } from "bun:test";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/shared/agent-protocol.js";
import type { Message, Tab } from "../../src/shared/rpc.js";
import { useAgentStore } from "../../src/views/main/lib/agent-store.js";
import { clearHermantAppDir, createTestTempDir, setHermantAppDir } from "../helpers/temp-dir.js";

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
    _sendToRenderer: (tabId: string, event: AgentEvent) => void,
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

  async sendCommand() {
    return { type: "response" as const, command: "prompt", success: true as const };
  }

  sendRaw() {}
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

function resetStore() {
  const state = useAgentStore.getState();
  useAgentStore.setState({
    tabs: {},
    tabOrder: [],
    activeTabId: undefined,
    projects: [],
    sessions: [],
    ui: {
      ...state.ui,
      view: "home",
      selectedProject: null,
    },
    ads: state.ads,
    session: { messages: [], isThinking: false, availableModels: [] },
    connection: { state: "idle" },
  });
}

beforeEach(() => {
  tempDir = createTestTempDir("herman-contract-");
  mockInstances = [];
  resetStore();
  setHermantAppDir(tempDir);
  mock.module("../../src/bun/agent-bridge.js", () => ({
    AgentBridge: MockAgentBridge,
  }));
});

afterEach(() => {
  clearHermantAppDir(tempDir);
  mock.restore();
});

async function createManager() {
  const { AgentProcessManager } = await import("../../src/bun/agent-process-manager.js");
  return new AgentProcessManager({
    serverUrl: "http://localhost:4000",
    getToken: async () => undefined,
    getHermanEnabled: () => true,
    getMode: () => "normal",
    webviewRpc: {
      send: {
        agentEvent: () => {},
        agentStatusChanged: () => {},
        sessionStateChanged: () => {},
        sessionsChanged: () => {},
        tabMessagesHydrated: () => {},
      },
    },
  });
}

function comparableState(tab: Tab | undefined) {
  if (!tab) return null;
  return {
    isThinking: tab.isThinking,
    messageCount: tab.messages.length,
    lastRole: tab.messages[tab.messages.length - 1]?.role,
    lastAssistantStreaming:
      [...tab.messages].reverse().find((m) => m.role === "assistant")?.isStreaming ?? null,
    lastToolStatus: [...tab.messages].reverse().find((m) => m.role === "tool")?.status ?? null,
  };
}

function messagesFromEvents(events: AgentEvent[]): Message[] {
  // Seed a store tab and replay the events to collect the resulting messages.
  const id = useAgentStore.getState().createTab("/project");
  for (const event of events) {
    useAgentStore.getState().recordAgentEvent(id, event);
  }
  return useAgentStore.getState().tabs[id].messages;
}

async function runContract(events: AgentEvent[]) {
  const manager = await createManager();
  const managerTab = await manager.createTab("/project");

  // Reset the store again and create a tab with the same id so we can replay
  // the exact same events through the renderer state machine.
  resetStore();
  const storeTabId = useAgentStore.getState().createTab("/project");
  useAgentStore.setState((state) => {
    const tab = state.tabs[storeTabId];
    if (!tab) return state;
    const replaced = { ...tab, id: managerTab.id };
    const tabs = { ...state.tabs, [managerTab.id]: replaced };
    delete tabs[storeTabId];
    return { ...state, tabs, tabOrder: [managerTab.id] };
  });

  for (const event of events) {
    mockInstances[0].emitEvent(event);
    useAgentStore.getState().recordAgentEvent(managerTab.id, event);
  }

  const managerState = comparableState(manager.getTabs().tabs[0]);
  const storeState = comparableState(useAgentStore.getState().tabs[managerTab.id]);

  return { managerState, storeState };
}

describe("agent state contract", () => {
  it("produces identical main and renderer state for a simple assistant turn", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      },
      { type: "message_end", message: {} },
      { type: "agent_end", messages: [{ role: "assistant" }] },
    ];

    const { managerState, storeState } = await runContract(events);

    expect(managerState).toEqual(storeState);
    expect(managerState).toMatchObject({
      isThinking: false,
      messageCount: 1,
      lastRole: "assistant",
      lastAssistantStreaming: false,
    });
  });

  it("produces identical state for a turn with a tool call", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "I'll read it" },
      },
      { type: "message_end", message: {} },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { filePath: "/tmp/foo.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "file content" }] },
        isError: false,
      },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "Done" },
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
      },
    ];

    const { managerState, storeState } = await runContract(events);

    expect(managerState).toEqual(storeState);
    expect(managerState).toMatchObject({
      isThinking: false,
      messageCount: 3,
      lastRole: "assistant",
      lastAssistantStreaming: false,
      lastToolStatus: "done",
    });
  });

  it("keeps both state machines thinking when agent_end is stale", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "old" },
      },
      { type: "message_end", message: {} },
      // The agent moved on to a tool call before the old agent_end arrived.
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { filePath: "/tmp/foo.ts" },
      },
      // Old agent_end only knew about the first assistant message.
      { type: "agent_end", messages: [{ role: "assistant" }] },
    ];

    const { managerState, storeState } = await runContract(events);

    expect(managerState).toEqual(storeState);
    expect(managerState).toMatchObject({
      isThinking: true,
      lastRole: "tool",
      lastToolStatus: "running",
    });
  });

  it("agrees on isThinking after the exact log event sequence", async () => {
    // Reproduces the sequence from the reported logs: assistant makes a plan,
    // calls a read tool, then emits agent_end with toolResult in the suffix.
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "plan" },
      },
      { type: "message_end", message: {} },
      {
        type: "tool_execution_start",
        toolCallId: "tool_rxk8lIUfBgxcQM9d7MLJDDDm",
        toolName: "read",
        args: { filePath: "/tmp/foo.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool_rxk8lIUfBgxcQM9d7MLJDDDm",
        toolName: "read",
        result: { content: [{ type: "text", text: "file content" }] },
        isError: false,
      },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "answer" },
      },
      { type: "message_end", message: {} },
      {
        type: "agent_end",
        messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
      },
    ];

    const { managerState, storeState } = await runContract(events);

    expect(managerState).toEqual(storeState);
    expect(managerState).toMatchObject({
      isThinking: false,
      messageCount: 3,
      lastRole: "assistant",
      lastAssistantStreaming: false,
    });
  });
});

it("messagesFromEvents helper documents the expected role mapping", () => {
  // This test is a canary: if the desktop ever starts storing tool results
  // under a different role, the contract tests above will fail and this
  // helper makes the intended mapping explicit.
  const messages = messagesFromEvents([
    {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    },
  ]);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: "tool", toolName: "read", status: "done" });
});
