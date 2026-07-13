import { getLogger } from "@logtape/logtape";
import type { AgentCommand, AgentEvent } from "../../../shared/agent-protocol.js";
import type {
  AgentStatus,
  DesktopRpc,
  DesktopSettings,
  OutgoingMessages,
  PersistedSession,
  ProviderCredential,
  ProviderMetadata,
  Session,
  Tab,
  TabId,
} from "../../../shared/rpc.js";
import { useAgentStore } from "./agent-store.js";

const logger = getLogger(["herman-desktop", "view", "browser-rpc"]);

type MessageListenerMap = {
  [K in keyof OutgoingMessages]: Array<(payload: OutgoingMessages[K]) => void>;
};

const TAB_ID = "browser-tab";

export const desktopRpc = createBrowserRpc();

function createBrowserRpc(): DesktopRpc {
  const wsUrl = `ws://${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  let sessionId: string | undefined;
  let agentStarted = false;
  let reconnectAttempt = 0;

  ws.addEventListener("error", (event) => {
    logger.warning("Browser RPC WebSocket error", { url: wsUrl, event: String(event) });
  });

  ws.addEventListener("close", () => {
    logger.info("Browser RPC WebSocket closed", { reconnectAttempt });
  });

  const listeners: MessageListenerMap = {
    sessionChanged: [],
    tabsRestored: [],
    tabCreated: [],
    tabMessagesHydrated: [],
    tabClosed: [],
    tabActivated: [],
    tabFolderChanged: [],
    projectsChanged: [],
    sessionsChanged: [],
    projectOpened: [],
    agentEvent: [],
    agentStatusChanged: [],
    adEvent: [],
    adVisibilityChanged: [],
    activationComplete: [],
    previewStatusChanged: [],
    updateStatus: [],
  };

  ws.addEventListener("open", async () => {
    reconnectAttempt = 0;
    logger.info("Browser RPC WebSocket connected", { url: wsUrl });
    const res = await fetch("/api/session");
    const data = (await res.json()) as { sessionId: string; serverUrl: string };
    sessionId = data.sessionId;

    ws.send(JSON.stringify({ type: "start_agent", sessionId }));
    agentStarted = true;

    listeners.tabsRestored.forEach((handler) =>
      handler({
        tabs: [createTab()],
        activeTabId: TAB_ID,
        projects: [],
        sessions: [toPersistedSession(createTab())],
      }),
    );
    listeners.tabActivated.forEach((handler) => handler({ tabId: TAB_ID }));
  });

  ws.addEventListener("message", (event) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (data.type === "agent_event") {
      const agentEvent = (data.event ?? {}) as AgentEvent;
      listeners.agentEvent.forEach((handler) => handler({ tabId: TAB_ID, event: agentEvent }));
    }

    if (data.type === "agent_stderr") {
      listeners.agentStatusChanged.forEach((handler) =>
        handler({ tabId: TAB_ID, state: "running", stderr: String(data.text ?? "") }),
      );
    }

    if (data.type === "agent_exit") {
      listeners.agentStatusChanged.forEach((handler) =>
        handler({
          tabId: TAB_ID,
          state: "crashed",
          stderr: `Agent exited with code ${String(data.code)}`,
        }),
      );
    }
  });

  async function sendAgentCommand(command: AgentCommand) {
    ws.send(JSON.stringify({ type: "agent_command", command: JSON.stringify(command) }));
  }

  return {
    request: {
      startDeviceActivation: async () => ({
        deviceCode: "",
        userCode: "",
        verificationUri: "",
        expiresIn: 0,
        interval: 0,
      }),
      checkDeviceActivation: async () => ({
        status: "authorized" as const,
        accessToken: "browser",
      }),
      getSession: async () => ({ token: sessionId ?? "browser" }),
      signOut: async () => {},
      copyToClipboard: async () => {},
      openExternal: async ({ url }: { url: string }) => {
        window.open(url, "_blank");
      },
      getVersion: async () => ({ version: "0.0.1", hash: "dev", channel: "browser" }),
      getDevMode: async () => Boolean(import.meta.env.DEV),
      checkForUpdate: async () => ({ updateAvailable: false, version: "0.0.1", error: "" }),
      downloadUpdate: async () => {},
      applyUpdate: async () => {},
      createTab: async ({ folderPath }: { folderPath?: string }) => createTab(folderPath),
      closeTab: async () => {},
      activateTab: async () => {},
      setTabFolder: async (_params?: { tabId: string; folderPath?: string }) => ({
        folderPath: "",
      }),
      selectTabProject: async ({ folderPath }: { tabId: string; folderPath: string }) => ({
        folderPath,
      }),
      getTabs: async () => ({ tabs: [createTab()], activeTabId: TAB_ID }),
      getProjectsAndSessions: async () => ({
        projects: [],
        sessions: [toPersistedSession(createTab())],
      }),
      openProject: async () => ({ folderPath: "" }),
      closeProject: async () => {},
      openSession: async () => createTab(),
      retryTabMessageHydration: async ({ tabId }: { tabId: TabId }) => {
        const tab = useAgentStore.getState().tabs[tabId];
        return {
          tabId,
          status: "empty" as const,
          messages: tab?.messages ?? [],
        };
      },
      setComposerDraft: async () => {},
      findProjectFiles: async () => ({ paths: [] }),
      openFilePicker: async () => ({ files: [] }),
      agentRequest: async ({ command }: { tabId: TabId; command: AgentCommand }) => {
        await sendAgentCommand(command);
        return { type: "response", command: command.type, success: true } as const;
      },
      abortAgent: async () => {
        ws.send(JSON.stringify({ type: "abort" }));
      },
      restartAgent: async () => {
        // Browser mock: restart the agent connection.
        ws.send(JSON.stringify({ type: "restart_agent", sessionId }));
      },
      previewRevertTab: async ({ tabId, messageIndex }: { tabId: TabId; messageIndex: number }) => {
        const tab = useAgentStore.getState().tabs[tabId];
        if (!tab) return { messageCount: 0 };
        const boundary = tab.messages[messageIndex];
        if (!boundary) return { messageCount: 0 };
        const userMessages = tab.messages.filter((m) => m.role === "user");
        const boundaryIdx = userMessages.findIndex((m) => m.id === boundary.id);
        const messageCount = boundaryIdx >= 0 ? userMessages.length - boundaryIdx : 0;
        return { messageCount, diffSummary: undefined };
      },
      revertTab: async ({ tabId, messageIndex }: { tabId: TabId; messageIndex: number }) => {
        const tab = useAgentStore.getState().tabs[tabId];
        if (!tab) return { tab: createTab() };
        const message = tab.messages[messageIndex];
        if (!message) return { tab };
        useAgentStore.getState().revertTab(tabId, message.id);
        return { tab: { ...tab, revertMessageId: message.id }, diffSummary: undefined };
      },
      unrevertTab: async ({ tabId }: { tabId: TabId }) => {
        useAgentStore.getState().unrevertTab(tabId);
        const tab = useAgentStore.getState().tabs[tabId];
        return { tab: tab ?? createTab() };
      },
      commitRevertTab: async ({ tabId, messageIndex }: { tabId: TabId; messageIndex: number }) => {
        const state = useAgentStore.getState();
        const tab = state.tabs[tabId];
        if (!tab) return { tab: createTab() };
        const messages = tab.messages.slice(0, messageIndex);
        state.updateTab(tabId, { messages, revertMessageId: undefined });
        return { tab: { ...tab, messages, revertMessageId: undefined } };
      },
      getDiff: async () => ({ diffs: [] }),
      getAgentStatus: async () => ({ state: agentStarted ? "running" : "idle" }) as AgentStatus,
      getRecentAgentEvents: async () => [],
      reportImpression: async () => {},
      reportAdClick: async () => ({ destinationUrl: undefined }),
      getSettings: async () =>
        ({
          providers: { herman: { enabled: true }, custom: {} },
          models: {},
        }) satisfies DesktopSettings,
      saveSettings: async () => {},
      getProviderCredentials: async () => undefined,
      saveProviderCredentials: async () => {},
      removeProviderCredentials: async () => {},
      startOAuthLogin: async ({ providerId }: { providerId: string }) => ({
        authUrl: `https://example.com/oauth?provider=${providerId}`,
        state: "browser",
      }),
      pollOAuthLogin: async () => ({ status: "pending" as const }),
      cancelOAuthLogin: async () => {},
      getAvailableProviders: async () => [] as ProviderMetadata[],
      refreshHermanModels: async () => {},
      getTemplates: async () => [],
      createProjectFromTemplate: async ({ templateId, projectName }: { templateId: string; projectName: string }) => ({
        folderPath: `/tmp/herman/${projectName}`,
      }),
      getSessionChanges: async () => ({ isWorktree: false, changedFiles: 0, canApply: false }),
      applySession: async () => ({ status: "error" as const, error: "Unavailable in browser mock" }),
      discardSession: async () => {},
      startPreview: async ({ folderPath }: { folderPath: string }) => ({
        url: `http://localhost:4321`,
        port: 4321,
      }),
      stopPreview: async () => {},
      restartPreview: async () => ({ url: `http://localhost:4321`, port: 4321 }),
      getPreviewStatus: async () => ({ running: false }),
      getProjectManifest: async () => undefined,
      getSkills: async () => ({ skills: [] }),
      installSkill: async ({ name }: { name: string; content: string }) => ({
        path: `/tmp/herman/skills/${name}/SKILL.md`,
      }),
      searchSkills: async () => ({ results: [] }),
      installSkillFromCommand: async () => ({ path: "/tmp/herman/skills/skill/SKILL.md", name: "skill" }),
      removeSkill: async () => {},
      setSkillEnabled: async () => {},
      focusWindow: async () => {},
      showNativeNotification: async () => {},
    },
    addMessageListener: <K extends keyof OutgoingMessages>(
      name: K,
      handler: (payload: OutgoingMessages[K]) => void,
    ) => {
      (listeners as Record<string, Array<(payload: unknown) => void>>)[name]?.push(
        handler as (payload: unknown) => void,
      );
    },
    removeMessageListener: <K extends keyof OutgoingMessages>(
      name: K,
      handler: (payload: OutgoingMessages[K]) => void,
    ) => {
      const list = (listeners as Record<string, Array<(payload: unknown) => void>>)[name];
      if (!list) return;
      const index = list.indexOf(handler as (payload: unknown) => void);
      if (index !== -1) list.splice(index, 1);
    },
    send: {
      requestActivation: () => {},
      cancelActivation: () => {},
      copyUserCode: () => {},
      openVerificationUrl: () => {},
      signOut: () => {},
      checkForUpdate: () => {},
      downloadUpdate: () => {},
      applyUpdate: () => {},
      openProject: () => {},
    },
  };
}

function toPersistedSession(tab: Tab): PersistedSession {
  return {
    id: tab.id,
    title: tab.title,
    folderPath: tab.folderPath,
    projectColor: tab.projectColor,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
}

function createTab(folderPath = ""): Tab {
  const now = Date.now();
  return {
    id: TAB_ID,
    title: "Browser session",
    folderPath,
    projectColor: "#22c55e",
    messages: [],
    isThinking: false,
    showThinking: false,
    thinkingMessages: [],
    availableModels: [],
    connectionState: "idle",
    createdAt: now,
    updatedAt: now,
    composerValue: "",
    queuedMessages: [],
  };
}
