import { beforeEach, describe, expect, it } from "vitest";
import { deriveStatus } from "../../../../src/views/main/components/status-bar.js";
import type { Tab } from "../../../../src/views/main/lib/agent-store.js";
import { isTabWorking, useAgentStore } from "../../../../src/views/main/lib/agent-store.js";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    title: "Test",
    folderPath: "/project",
    projectColor: "#000000",
    messages: [],
    isThinking: false,
    showThinking: false,
    thinkingMessages: [],
    availableModels: [],
    connectionState: "idle",
    createdAt: 0,
    updatedAt: 0,
    composerValue: "",
    queuedMessages: [],
    ...overrides,
  };
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
  resetStore();
});

describe("isTabWorking", () => {
  it("returns false when isThinking is false and there are no streaming messages", () => {
    const tab = makeTab({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "done", isStreaming: false },
      ],
    });
    expect(isTabWorking(tab)).toBe(false);
  });

  it("returns true when isThinking is true even without streaming messages", () => {
    // This is the "stuck thinking" symptom: isThinking never got cleared.
    const tab = makeTab({
      isThinking: true,
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "done", isStreaming: false },
      ],
    });
    expect(isTabWorking(tab)).toBe(true);
  });

  it("returns false after agent_end finalizes a tool-involved turn", () => {
    // Replay the fixed scenario through the store and confirm the derived
    // working state is false.
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "read the file");

    useAgentStore.getState().recordAgentEvent(id, {
      type: "agent_start",
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "I'll read it" },
    });
    useAgentStore.getState().recordAgentEvent(id, { type: "message_end", message: {} });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { filePath: "/tmp/foo.ts" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "file content" }] },
      isError: false,
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Done" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "agent_end",
      messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
    });

    const tab = useAgentStore.getState().tabs[id];
    expect(tab.isThinking).toBe(false);
    expect(isTabWorking(tab)).toBe(false);
  });

  it("does not treat prior assistant messages below a user message as streaming", () => {
    const tab = makeTab({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "old", isStreaming: true },
        { id: "m3", role: "user", content: "next" },
      ],
    });
    expect(isTabWorking(tab)).toBe(false);
  });
});

describe("deriveStatus", () => {
  it("shows Thinking when isThinking is true and nothing is streaming", () => {
    const tab = makeTab({
      isThinking: true,
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "done", isStreaming: false },
      ],
    });
    const status = deriveStatus(
      tab.messages,
      tab.isThinking,
      tab.connectionState,
      tab.connectionError,
    );
    expect(status.kind).toBe("thinking");
  });

  it("shows Idle after agent_end clears isThinking", () => {
    const tab = makeTab({
      isThinking: false,
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "done", isStreaming: false },
      ],
    });
    const status = deriveStatus(
      tab.messages,
      tab.isThinking,
      tab.connectionState,
      tab.connectionError,
    );
    expect(status.kind).toBe("idle");
  });

  it("shows tool status ahead of thinking", () => {
    const tab = makeTab({
      isThinking: true,
      messages: [
        { id: "m1", role: "user", content: "hi" },
        {
          id: "m2",
          role: "tool",
          toolName: "Bash",
          toolCallId: "t1",
          status: "running",
        },
      ],
    });
    const status = deriveStatus(
      tab.messages,
      tab.isThinking,
      tab.connectionState,
      tab.connectionError,
    );
    expect(status.kind).toBe("tool");
  });
});
