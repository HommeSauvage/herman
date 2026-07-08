import { beforeEach, describe, expect, it } from "vitest";

import type { AdCampaign } from "../../../shared/agent-protocol.js";
import type { TabId } from "../../../shared/tab-utils.js";
import { isTabWorking, useAgentStore, type Tab } from "./agent-store.js";

function nativeAdsFor(id: TabId): AdCampaign[] {
  return useAgentStore.getState().tabs[id]?.nativeAds ?? [];
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
    ads: {
      focused: true,
      visible: true,
      nativeInsertionsThisSession: 0,
      nativeInsertionsToday: 0,
      nativeInsertionDate: new Date().toISOString().slice(0, 10),
      lastNativeMessageIndex: null,
    },
    session: { messages: [], isThinking: false, availableModels: [] },
    connection: { state: "idle" },
  });
}

beforeEach(() => {
  resetStore();
});

describe("createTab", () => {
  it("creates a tab and activates it", () => {
    const id = useAgentStore.getState().createTab("/project");
    const state = useAgentStore.getState();

    expect(state.tabs[id]).toBeDefined();
    expect(state.tabOrder).toContain(id);
    expect(state.activeTabId).toBe(id);
    expect(state.tabs[id].folderPath).toBe("/project");
  });

  it("honors the provided title", () => {
    const id = useAgentStore.getState().createTab("/project", "Custom title");
    expect(useAgentStore.getState().tabs[id].title).toBe("Custom title");
  });

  it("inherits the active tab folder when no folder is provided", () => {
    const firstId = useAgentStore.getState().createTab("/active-project");
    useAgentStore.getState().activateTab(firstId);
    const secondId = useAgentStore.getState().createTab();
    expect(useAgentStore.getState().tabs[secondId].folderPath).toBe("/active-project");
  });
});

describe("closeTab", () => {
  it("removes the tab", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().closeTab(id);
    expect(useAgentStore.getState().tabs[id]).toBeUndefined();
  });

  it("keeps the session in the archive when the tab has messages", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "hello");
    useAgentStore.getState().closeTab(id);
    expect(useAgentStore.getState().sessions.some((session) => session.id === id)).toBe(true);
  });

  it("removes the session from the archive when the tab is empty", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().closeTab(id);
    expect(useAgentStore.getState().sessions.some((session) => session.id === id)).toBe(false);
  });

  it("switches to home when the last tab is closed", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().closeTab(id);
    expect(useAgentStore.getState().ui.view).toBe("home");
  });

  it("activates the previous tab when the active tab is closed", () => {
    const firstId = useAgentStore.getState().createTab("/project");
    const secondId = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().activateTab(secondId);

    useAgentStore.getState().closeTab(secondId);

    expect(useAgentStore.getState().activeTabId).toBe(firstId);
  });

  it("activates the next tab when the first tab is closed", () => {
    const firstId = useAgentStore.getState().createTab("/project");
    const secondId = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().activateTab(firstId);

    useAgentStore.getState().closeTab(firstId);

    expect(useAgentStore.getState().activeTabId).toBe(secondId);
  });
});

describe("activateTab", () => {
  it("sets the active tab and switches to session view", () => {
    const firstId = useAgentStore.getState().createTab("/project");
    const secondId = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setView("home");
    useAgentStore.getState().activateTab(firstId);
    expect(useAgentStore.getState().activeTabId).toBe(firstId);
    expect(useAgentStore.getState().ui.view).toBe("session");
    useAgentStore.getState().activateTab(secondId);
    expect(useAgentStore.getState().activeTabId).toBe(secondId);
  });
});

describe("appendUserMessage", () => {
  it("appends a user message", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "Hello");
    const tab = useAgentStore.getState().tabs[id];

    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0]).toEqual({ id: expect.any(String), role: "user", content: "Hello" });
  });

  it("auto-titles the tab on the first message", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "First message");
    expect(useAgentStore.getState().tabs[id].title).toBe("First message");
  });

  it("does not change the title after the first message", () => {
    const id = useAgentStore.getState().createTab("/project", "Existing title");
    useAgentStore.getState().appendUserMessage(id, "First");
    useAgentStore.getState().appendUserMessage(id, "Second");
    expect(useAgentStore.getState().tabs[id].title).toBe("First");
  });
});

describe("setSessions", () => {
  it("syncs server-generated titles into open tabs", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setSessions([
      {
        id,
        title: "Server title",
        folderPath: "/project",
        projectColor: "#000000",
        createdAt: 0,
        updatedAt: 1,
      },
    ]);
    expect(useAgentStore.getState().tabs[id].title).toBe("Server title");
  });

  it("ignores empty placeholder titles from the server", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "Keep me");
    useAgentStore.getState().setSessions([
      {
        id,
        title: "Untitled session",
        folderPath: "/project",
        projectColor: "#000000",
        createdAt: 0,
        updatedAt: 1,
      },
    ]);
    expect(useAgentStore.getState().tabs[id].title).toBe("Keep me");
  });

  it("ignores blank titles from the server", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "Keep me");
    useAgentStore.getState().setSessions([
      {
        id,
        title: "   ",
        folderPath: "/project",
        projectColor: "#000000",
        createdAt: 0,
        updatedAt: 1,
      },
    ]);
    expect(useAgentStore.getState().tabs[id].title).toBe("Keep me");
  });
});

describe("isTabWorking", () => {
  function makeTab(overrides: Partial<Tab> = {}): Tab {
    return {
      id: "tab-1",
      title: "Test",
      folderPath: "/project",
      projectColor: "#000000",
      messages: [],
      isThinking: false,
      availableModels: [],
      connectionState: "idle",
      createdAt: 0,
      updatedAt: 0,
      composerValue: "",
      queuedMessages: [],
      nativeAds: [],
      ...overrides,
    };
  }

  it("returns false for an idle tab", () => {
    expect(isTabWorking(makeTab())).toBe(false);
  });

  it("returns true while thinking", () => {
    expect(isTabWorking(makeTab({ isThinking: true }))).toBe(true);
  });

  it("returns true while the last assistant message is streaming", () => {
    const tab = makeTab({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "", isStreaming: true },
      ],
    });
    expect(isTabWorking(tab)).toBe(true);
  });

  it("returns true while a tool is running", () => {
    const tab = makeTab({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "ok", isStreaming: false },
        {
          id: "m3",
          role: "tool",
          toolName: "Bash",
          toolCallId: "t1",
          status: "running",
        },
      ],
    });
    expect(isTabWorking(tab)).toBe(true);
  });

  it("stops at the most recent user message", () => {
    const tab = makeTab({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        {
          id: "m2",
          role: "tool",
          toolName: "Bash",
          toolCallId: "t1",
          status: "running",
        },
        { id: "m3", role: "user", content: "again" },
      ],
    });
    expect(isTabWorking(tab)).toBe(false);
  });
});

describe("recordAgentEvent", () => {
  it("updates the last assistant message even after tool messages", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    const messages = useAgentStore.getState().tabs[id].messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "Hello world" });
  });

  it("agent_end finalizes all streaming assistant messages, not just the last", () => {
    const id = useAgentStore.getState().createTab("/project");
    // First assistant message (already completed)
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "first" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {},
    });
    // Tool execution
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });
    // Second assistant message (still streaming)
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "second" },
    });

    // agent_end should finalize ALL streaming messages.
    useAgentStore.getState().recordAgentEvent(id, { type: "agent_end" });

    const messages = useAgentStore.getState().tabs[id].messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "assistant", isStreaming: false });
    expect(messages[2]).toMatchObject({ role: "assistant", isStreaming: false, content: "second" });
  });

  it("setConnectionState finalizes streaming messages on crash", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "working..." },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });

    // Simulate crash — agent_end never arrives.
    useAgentStore.getState().setConnectionState(id, { state: "crashed", stderr: "boom" });

    const tab = useAgentStore.getState().tabs[id];
    expect(tab.isThinking).toBe(false);
    const asst = tab.messages.find((m) => m.role === "assistant");
    expect(asst).toMatchObject({ isStreaming: false });
    const tool = tab.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ status: "error" });
  });

  it("finalizes the last assistant message even after tool messages", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {},
    });

    const messages = useAgentStore.getState().tabs[id].messages;
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "",
      isStreaming: false,
    });
  });

  it("sets connectionError and stops thinking when a message ends with an error", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setThinking(id, true);
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {
        stopReason: "error",
        errorMessage: "The socket connection was closed unexpectedly.",
      },
    });

    const tab = useAgentStore.getState().tabs[id];
    expect(tab.isThinking).toBe(false);
    expect(tab.connectionError).toBe("The socket connection was closed unexpectedly.");
    const lastMessage = tab.messages[tab.messages.length - 1];
    expect(lastMessage).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "The socket connection was closed unexpectedly.",
    });
  });

  it("stopStreaming clears isThinking, streaming messages, and running tools", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setThinking(id, true);
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "working..." },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "ls" },
    });

    useAgentStore.getState().stopStreaming(id);

    const tab = useAgentStore.getState().tabs[id];
    expect(tab.isThinking).toBe(false);
    const asst = tab.messages.find((m) => m.role === "assistant");
    expect(asst).toMatchObject({ isStreaming: false });
    const tool = tab.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ status: "error", output: "Stopped by user" });
  });

  it("stopStreaming is a no-op when nothing is streaming", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {},
    });

    const before = useAgentStore.getState().tabs[id];
    useAgentStore.getState().stopStreaming(id);
    const after = useAgentStore.getState().tabs[id];

    expect(after).toBe(before);
    expect(after.isThinking).toBe(false);
  });

  it("recordAgentEvent is a no-op when a duplicate agent_end arrives after finalization", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {},
    });
    useAgentStore.getState().recordAgentEvent(id, { type: "agent_end" });

    const before = useAgentStore.getState().tabs[id];
    useAgentStore.getState().recordAgentEvent(id, { type: "agent_end" });
    const after = useAgentStore.getState().tabs[id];

    expect(after).toBe(before);
    expect(after.messages).toBe(before.messages);
  });

  it("recordAgentEvent is a no-op when a duplicate agent_complete arrives after finalization", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {},
    });
    useAgentStore.getState().recordAgentEvent(id, { type: "agent_complete" });

    const before = useAgentStore.getState().tabs[id];
    useAgentStore.getState().recordAgentEvent(id, { type: "agent_complete" });
    const after = useAgentStore.getState().tabs[id];

    expect(after).toBe(before);
    expect(after.messages).toBe(before.messages);
  });

  it("agent_end clears isThinking when the tab has prior message history", () => {
    const id = useAgentStore.getState().createTab("/project");
    // Prior history.
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "history" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {},
    });

    // New turn.
    useAgentStore.getState().appendUserMessage(id, "next");
    useAgentStore.getState().setThinking(id, true);
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "answer" },
    });

    // agent_end carries only this turn's messages, which is a suffix of the tab.
    useAgentStore.getState().recordAgentEvent(id, {
      type: "agent_end",
      messages: [{ role: "user" }, { role: "assistant" }],
    });

    const tab = useAgentStore.getState().tabs[id];
    expect(tab.isThinking).toBe(false);
    const last = tab.messages[tab.messages.length - 1];
    expect(last).toMatchObject({ role: "assistant", content: "answer", isStreaming: false });
  });

  it("agent_end clears isThinking when the agent reports toolResult and the tab stores tool", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "read the file");
    useAgentStore.getState().setThinking(id, true);

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

    // The agent's agent_end carries toolResult messages, but the desktop
    // stores tool results as role "tool".  This must still clear isThinking.
    useAgentStore.getState().recordAgentEvent(id, {
      type: "agent_end",
      messages: [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
    });

    expect(useAgentStore.getState().tabs[id].isThinking).toBe(false);
    const tab = useAgentStore.getState().tabs[id];
    const last = tab.messages[tab.messages.length - 1];
    expect(last).toMatchObject({ role: "assistant", content: "Done", isStreaming: false });
  });

  it("agent_end does not clear isThinking for a stale event from a previous turn", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "first");
    useAgentStore.getState().setThinking(id, true);
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "old answer" },
    });

    // A new prompt arrives before the old turn ends (e.g. retry / race).
    useAgentStore.getState().appendUserMessage(id, "second");

    // Old agent_end only knew about the first turn's messages, so its suffix
    // no longer matches the tab.  isThinking should stay true for the new turn.
    useAgentStore.getState().recordAgentEvent(id, {
      type: "agent_end",
      messages: [{ role: "user" }, { role: "assistant" }],
    });

    expect(useAgentStore.getState().tabs[id].isThinking).toBe(true);
  });
});

describe("updateTab", () => {
  it("does not mutate when messages are equal by content but different references", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "Hello");
    const before = useAgentStore.getState();
    const messages = before.tabs[id].messages.map((m) => ({ ...m }));

    useAgentStore.getState().updateTab(id, { messages });

    const after = useAgentStore.getState();
    expect(after.tabs[id]).toBe(before.tabs[id]);
    expect(after.tabs).toBe(before.tabs);
  });

  it("does not mutate when availableModels are equal by content but different references", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setModels(id, "m1", ["m1", "m2"]);
    const before = useAgentStore.getState();

    useAgentStore.getState().updateTab(id, { availableModels: ["m1", "m2"] });

    const after = useAgentStore.getState();
    expect(after.tabs[id]).toBe(before.tabs[id]);
    expect(after.tabs).toBe(before.tabs);
  });

  it("does not mutate when queuedMessages are equal by content but different references", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().queueMessage(id, "follow up");
    const before = useAgentStore.getState();
    const queuedMessages = before.tabs[id].queuedMessages.map((m) => ({ ...m }));

    useAgentStore.getState().updateTab(id, { queuedMessages });

    const after = useAgentStore.getState();
    expect(after.tabs[id]).toBe(before.tabs[id]);
    expect(after.tabs).toBe(before.tabs);
  });

  it("mutates when message content actually changed", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "Hello");
    const messages = useAgentStore
      .getState()
      .tabs[id].messages.map((m) => (m.role === "user" ? { ...m, content: "Changed" } : m));

    useAgentStore.getState().updateTab(id, { messages });

    expect(useAgentStore.getState().tabs[id].messages[0]).toMatchObject({
      role: "user",
      content: "Changed",
    });
  });
});

describe("queued messages", () => {
  it("queues a follow-up message", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().queueMessage(id, "follow up 1");
    useAgentStore.getState().queueMessage(id, "follow up 2");
    expect(useAgentStore.getState().tabs[id].queuedMessages).toHaveLength(2);
    expect(useAgentStore.getState().tabs[id].queuedMessages[0]?.text).toBe("follow up 1");
    expect(useAgentStore.getState().tabs[id].queuedMessages[1]?.text).toBe("follow up 2");
  });

  it("removes a queued message by id", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().queueMessage(id, "keep");
    useAgentStore.getState().queueMessage(id, "remove");
    const removeId = useAgentStore.getState().tabs[id].queuedMessages[1]!.id;
    useAgentStore.getState().removeQueuedMessage(id, removeId);
    expect(useAgentStore.getState().tabs[id].queuedMessages).toHaveLength(1);
    expect(useAgentStore.getState().tabs[id].queuedMessages[0]?.text).toBe("keep");
  });

  it("edits a queued message by id", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().queueMessage(id, "original");
    const editId = useAgentStore.getState().tabs[id].queuedMessages[0]!.id;
    useAgentStore.getState().editQueuedMessage(id, editId, "edited");
    expect(useAgentStore.getState().tabs[id].queuedMessages[0]?.text).toBe("edited");
  });

  it("dequeues messages in FIFO order", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().queueMessage(id, "first");
    useAgentStore.getState().queueMessage(id, "second");
    const first = useAgentStore.getState().dequeueMessage(id);
    expect(first?.text).toBe("first");
    expect(useAgentStore.getState().tabs[id].queuedMessages).toHaveLength(1);
    const second = useAgentStore.getState().dequeueMessage(id);
    expect(second?.text).toBe("second");
    expect(useAgentStore.getState().tabs[id].queuedMessages).toHaveLength(0);
    expect(useAgentStore.getState().dequeueMessage(id)).toBeUndefined();
  });
});

describe("native ads", () => {
  const nativeCampaign = {
    id: "native-1",
    brandName: "Railway",
    tagline: "Deploy faster",
    destinationUrl: "https://railway.app",
    body: "By the way, Railway is running a promo for Herman users.",
    cta: "Claim 50% off",
  };

  const sidebarCampaign = {
    id: "sidebar-1",
    brandName: "Sidebar",
    tagline: "Try me",
    destinationUrl: "https://sidebar.dev",
  };

  const thinkingBannerCampaign = {
    id: "banner-1",
    brandName: "Banner",
    tagline: "Click me",
    destinationUrl: "https://banner.dev",
  };

  it("appends a native ad on ad_event when under the session cap", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    const tab = useAgentStore.getState().tabs[id];
    expect(tab.nativeAds?.length).toBe(1);
    expect(tab.nativeAds?.[0]).toEqual(nativeCampaign);
  });

  it("increments native frequency counters when the ad is delivered", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    const state = useAgentStore.getState();
    expect(state.ads.nativeInsertionsThisSession).toBe(1);
    expect(state.ads.nativeInsertionsToday).toBe(1);
    expect(state.ads.lastNativeMessageIndex).toBe(0);
  });

  it("ignores native ads once the session cap is reached", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.setState({
      ads: {
        ...useAgentStore.getState().ads,
        nativeInsertionsThisSession: 3,
      },
    });

    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    expect(nativeAdsFor(id)).toHaveLength(0);
  });

  it("ignores native ads once the daily cap is reached", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.setState({
      ads: {
        ...useAgentStore.getState().ads,
        nativeInsertionsToday: 5,
      },
    });

    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    expect(nativeAdsFor(id)).toHaveLength(0);
  });

  it("resets the daily counter on a new calendar day", () => {
    useAgentStore.setState({
      ads: {
        ...useAgentStore.getState().ads,
        nativeInsertionsToday: 5,
        nativeInsertionDate: "2020-01-01",
      },
    });

    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    expect(nativeAdsFor(id)).toHaveLength(1);
  });

  it("clears native ads when the tab is cleared", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });
    expect(nativeAdsFor(id)).toHaveLength(1);

    useAgentStore.getState().clearTab(id);
    expect(nativeAdsFor(id)).toHaveLength(0);
  });

  it("does not restore native ads from persisted tabs", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    const tab = useAgentStore.getState().tabs[id];
    useAgentStore.getState().restoreTabs(
      [
        {
          ...tab,
          nativeAds: [nativeCampaign],
        } as Tab,
      ],
      id,
    );

    expect(nativeAdsFor(id)).toHaveLength(0);
  });

  it("does not append two native ads in the same turn", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });
    expect(nativeAdsFor(id)).toHaveLength(1);

    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: { ...nativeCampaign, id: "native-2" },
    });

    expect(nativeAdsFor(id)).toHaveLength(1);
  });

  it("does not mutate ads counters when a native ad is blocked", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.setState({
      ads: {
        ...useAgentStore.getState().ads,
        nativeInsertionsThisSession: 3,
      },
    });

    const before = useAgentStore.getState().ads;
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });
    const after = useAgentStore.getState().ads;

    expect(after).toBe(before);
  });

  it("ignores native placements in setTabAd", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setTabAd(id, "native", nativeCampaign);

    expect(nativeAdsFor(id)).toHaveLength(0);
    expect(useAgentStore.getState().tabs[id].thinkingBanner).toBeUndefined();
    expect(useAgentStore.getState().tabs[id].sidebarAd).toBeUndefined();
  });

  it("sets thinking_banner and sidebar ads via setTabAd", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setTabAd(id, "thinking_banner", thinkingBannerCampaign);
    useAgentStore.getState().setTabAd(id, "sidebar", sidebarCampaign);

    expect(useAgentStore.getState().tabs[id].thinkingBanner).toEqual(thinkingBannerCampaign);
    expect(useAgentStore.getState().tabs[id].sidebarAd).toEqual(sidebarCampaign);
  });

  it("clears all ad placements when the tab is cleared", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().setTabAd(id, "thinking_banner", thinkingBannerCampaign);
    useAgentStore.getState().setTabAd(id, "sidebar", sidebarCampaign);
    useAgentStore.getState().recordAgentEvent(id, {
      type: "herman/ad_event",
      placement: "native",
      campaign: nativeCampaign,
    });

    useAgentStore.getState().clearTab(id);

    const tab = useAgentStore.getState().tabs[id];
    expect(nativeAdsFor(id)).toHaveLength(0);
    expect(tab.thinkingBanner).toBeUndefined();
    expect(tab.sidebarAd).toBeUndefined();
  });
});


describe("context stats", () => {
  it("computes context stats when messages arrive", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "hello");
    useAgentStore.getState().startAssistantMessage(id);
    useAgentStore.getState().appendAssistantDelta(id, "Hi there");
    useAgentStore.getState().finalizeAssistantMessage(id);

    const stats = useAgentStore.getState().tabs[id]?.contextStats;
    expect(stats).toBeDefined();
    expect(stats?.messageCount).toBe(2);
    expect(stats?.userMessageCount).toBe(1);
    expect(stats?.assistantMessageCount).toBe(1);
    expect(stats?.totalTokens).toBeGreaterThan(0);
  });

  it("updates context stats from message usage", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_start",
      message: { role: "assistant" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    useAgentStore.getState().recordAgentEvent(id, {
      type: "message_end",
      message: {
        stopReason: "stop",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
        },
      },
    });

    const stats = useAgentStore.getState().tabs[id]?.contextStats;
    expect(stats?.totalTokens).toBe(150);
    expect(stats?.inputTokens).toBe(100);
    expect(stats?.outputTokens).toBe(50);
  });

  it("resets context stats when the tab is cleared", () => {
    const id = useAgentStore.getState().createTab("/project");
    useAgentStore.getState().appendUserMessage(id, "hello");
    useAgentStore.getState().clearTab(id);

    const stats = useAgentStore.getState().tabs[id]?.contextStats;
    expect(stats?.totalTokens).toBe(0);
    expect(stats?.messageCount).toBe(0);
  });
});