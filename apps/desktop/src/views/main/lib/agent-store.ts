import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { AgentEvent, AdCampaign, AdPlacement } from "../../../shared/agent-protocol.js";
import {
  applyAgentEventToMessages,
  createMessageId,
  finalizeStreamingMessages,
  isAgentEndCurrent,
  syncMessageCounter,
} from "../../../shared/apply-agent-event.js";
import { computeContextStats } from "../../../shared/context-stats.js";
import type {
  AgentStatus,
  ContextStats,
  DesktopSettings,
  DiffScope,
  FileDiff,
  Message,
  ModelMetadata,
  PersistedSession,
  QueuedFollowUp,
  Session,
} from "../../../shared/rpc.js";
import {
  createTabId,
  getProjectColor,
  getProjectName,
  getProjectInitial,
  hasUserOrAssistantMessage,
  truncateTitle,
  type TabId,
} from "../../../shared/tab-utils.js";

export type Tab = {
  id: TabId;
  title: string;
  folderPath: string;
  projectColor: string;
  messages: Message[];
  isThinking: boolean;
  currentModel?: string;
  availableModels: string[];
  connectionState: AgentStatus["state"];
  connectionError?: string;
  connectionStderr?: string;
  createdAt: number;
  updatedAt: number;
  composerValue: string;
  queuedMessages: QueuedFollowUp[];
  selectedMessageId?: string;
  thinkingBanner?: AdCampaign;
  sidebarAd?: AdCampaign;
  nativeAds?: AdCampaign[];
  thinkingStartedAt?: number;
  /** If set, all messages with id >= revertMessageId are considered reverted (hidden). */
  revertMessageId?: string;
  /** Diff summary shown in the revert dock (populated by file-level rewind). */
  revertDiffSummary?: string;
  /** Estimated token / context / cost statistics for the session. */
  contextStats?: ContextStats;
  /** Auto-retry state when the agent crashes or errors during a turn. */
  retryState?: {
    attempt: number;
    message: string;
    /** Unix timestamp (ms) for the next retry attempt. */
    next: number;
  };
};

export type AgentState = {
  tabs: Record<TabId, Tab>;
  tabOrder: TabId[];
  activeTabId: TabId | undefined;
  projects: string[];
  sessions: PersistedSession[];
  ui: {
    sidebarOpen: boolean;
    sidebarWidth: number;
    composerValue: string;
    modelSelectorOpen: boolean;
    selectedMessageId?: string;
    view: "home" | "session" | "settings";
    selectedProject: string | null;
    /** Currently active sidebar tab ("changes" | "context" | "ads") */
    sidebarTab: "changes" | "context" | "ads";
    /** Selected diff scope */
    diffScope: "last-message" | "everything" | "working-tree";
    /** Current diff results, keyed by tab ID */
    diffFiles: Record<TabId, FileDiff[]>;
    /** Whether a diff fetch is in progress, keyed by tab ID */
    diffLoading: Record<TabId, boolean>;
    /** Optional per-model metadata keyed by "provider/modelId". */
    modelMetadata: Record<string, ModelMetadata>;
  };
  settings: DesktopSettings;
  ads: {
    focused: boolean;
    visible: boolean;
    nativeInsertionsThisSession: number;
    nativeInsertionsToday: number;
    nativeInsertionDate: string;
    lastNativeMessageIndex: number | null;
  };
  /** Whether the onboarding wizard is visible (Rookie mode) */
  onboardingVisible: boolean;
  // Derived views of the active tab, kept for backward compatibility with
  // existing UI components that read global session/connection state.
  session: {
    messages: Message[];
    isThinking: boolean;
    currentModel?: string;
    availableModels: string[];
  };
  connection: {
    state: AgentStatus["state"];
    error?: string;
    stderr?: string;
  };
};

export type AgentActions = {
  setMode: (mode: "rookie" | "normal") => void;
  setOnboardingVisible: (visible: boolean) => void;
  createTab: (folderPath?: string, title?: string) => TabId;
  closeTab: (id: TabId) => void;
  activateTab: (id: TabId) => void;
  reorderTabs: (order: TabId[]) => void;
  updateTab: (id: TabId, partial: Partial<Omit<Tab, "id">>) => void;
  renameTab: (id: TabId, title: string) => void;
  setProjectForTab: (id: TabId, folderPath: string) => void;
  appendUserMessage: (tabId: TabId, content: string) => void;
  startAssistantMessage: (tabId: TabId) => void;
  appendAssistantDelta: (tabId: TabId, delta: string) => void;
  finalizeAssistantMessage: (tabId: TabId) => void;
  stopStreaming: (tabId: TabId) => void;
  updateTool: (
    tabId: TabId,
    toolCallId: string,
    update: Partial<Extract<Message, { role: "tool" }>>,
  ) => void;
  setThinking: (tabId: TabId, isThinking: boolean) => void;
  setModels: (tabId: TabId, currentModel?: string, availableModels?: string[]) => void;
  clearTab: (id: TabId) => void;
  setConnectionState: (tabId: TabId, status: AgentStatus) => void;
  restoreTabs: (
    tabs: Tab[],
    activeTabId?: TabId,
    projects?: string[],
    sessions?: PersistedSession[],
  ) => void;
  addTab: (tab: Tab) => void;
  setProjects: (projects: string[]) => void;
  setSessions: (sessions: PersistedSession[]) => void;
  setView: (view: "home" | "session" | "settings") => void;
  setSelectedProject: (folderPath: string | null) => void;
  setSettings: (settings: DesktopSettings) => void;
  handleProjectOpened: (folderPath: string, projects: string[]) => void;
  setComposerValue: ((value: string) => void) & ((tabId: TabId, value: string) => void);
  revertTab: (tabId: TabId, messageId: string) => void;
  unrevertTab: (tabId: TabId) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setSidebarTab: (tab: "changes" | "context" | "ads") => void;
  setDiffScope: (scope: DiffScope) => void;
  fetchDiff: (tabId: TabId, scope: DiffScope) => Promise<void>;
  setModelSelectorOpen: (open: boolean) => void;
  setAdVisibility: (focused: boolean, visible: boolean) => void;
  setTabAd: (tabId: TabId, placement: AdPlacement, campaign?: AdCampaign) => void;
  clearTabAds: (tabId: TabId) => void;
  recordAgentEvent: (tabId: TabId, event: AgentEvent) => void;
  queueMessage: (tabId: TabId, text: string) => void;
  removeQueuedMessage: (tabId: TabId, id: string) => void;
  editQueuedMessage: (tabId: TabId, id: string, text: string) => void;
  dequeueMessage: (tabId: TabId) => QueuedFollowUp | undefined;
  clearSession: () => void;
};

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function queuedMessagesEqual(a: QueuedFollowUp[], b: QueuedFollowUp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].text !== b[i].text) return false;
  }
  return true;
}

function messagesEqualish(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  // Compare the first, middle, and last messages by identity first (common case).
  const indices = [0, Math.floor(a.length / 2), a.length - 1];
  for (const i of indices) {
    if (i < 0 || i >= a.length) continue;
    if (a[i] === b[i]) continue;
    const am = a[i];
    const bm = b[i];
    if (am.id !== bm.id || am.role !== bm.role) return false;
    if (am.role === "user") {
      const au = am as Extract<Message, { role: "user" }>;
      const bu = bm as Extract<Message, { role: "user" }>;
      if (au.content !== bu.content) return false;
    }
    if (am.role === "assistant") {
      const aa = am as Extract<Message, { role: "assistant" }>;
      const ba = bm as Extract<Message, { role: "assistant" }>;
      if (aa.content !== ba.content || aa.isStreaming !== ba.isStreaming) return false;
      if (aa.stopReason !== ba.stopReason || aa.errorMessage !== ba.errorMessage) return false;
    }
    if (am.role === "tool") {
      const at = am as Extract<Message, { role: "tool" }>;
      const bt = bm as Extract<Message, { role: "tool" }>;
      if (at.status !== bt.status || at.output !== bt.output) return false;
    }
  }
  return true;
}

function syncSessionFromTab(sessions: PersistedSession[], tab: Tab): PersistedSession[] {
  const persisted: PersistedSession = {
    id: tab.id,
    title: tab.title,
    folderPath: tab.folderPath,
    projectColor: tab.projectColor,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
  return sessions.some((session) => session.id === tab.id)
    ? sessions.map((session) => (session.id === tab.id ? persisted : session))
    : [...sessions, persisted];
}

function deriveSession(activeTab: Tab | undefined): AgentState["session"] {
  return {
    messages: activeTab?.messages ?? [],
    isThinking: activeTab?.isThinking ?? false,
    currentModel: activeTab?.currentModel,
    availableModels: activeTab?.availableModels ?? [],
  };
}

function parseCurrentModel(currentModel?: string): { providerId?: string; modelId?: string } {
  if (!currentModel) return {};
  const [providerId, modelId] = currentModel.split("/", 2);
  return { providerId, modelId: modelId ?? providerId };
}

function computeTabContextStats(
  tab: Tab,
  modelMetadata?: Record<string, ModelMetadata>,
): Tab["contextStats"] {
  const { providerId, modelId } = parseCurrentModel(tab.currentModel);
  const contextLimit = modelMetadata?.[tab.currentModel ?? ""]?.contextWindow;
  return computeContextStats(tab.messages, modelId, providerId, contextLimit);
}

function deriveConnection(activeTab: Tab | undefined): AgentState["connection"] {
  return {
    state: activeTab?.connectionState ?? "idle",
    error: activeTab?.connectionError,
    stderr: activeTab?.connectionStderr,
  };
}

function deriveUi(state: AgentState, activeTab: Tab | undefined): AgentState["ui"] {
  return {
    ...state.ui,
    composerValue: activeTab?.composerValue ?? "",
    selectedMessageId: activeTab?.selectedMessageId,
  };
}

function rebuildDerived(
  state: AgentState,
  tabs: Record<TabId, Tab>,
): Pick<AgentState, "session" | "connection" | "ui"> {
  const activeTab = state.activeTabId ? tabs[state.activeTabId] : undefined;
  const session = deriveSession(activeTab);
  const connection = deriveConnection(activeTab);
  const ui = deriveUi(state, activeTab);

  return {
    session: shallowEqual(session, state.session) ? state.session : session,
    connection: shallowEqual(connection, state.connection) ? state.connection : connection,
    ui: shallowEqual(ui, state.ui) ? state.ui : ui,
  };
}

function makeTab(folderPath: string, title?: string): Tab {
  const now = Date.now();
  return {
    id: createTabId(),
    title: title ?? "New session",
    folderPath,
    projectColor: getProjectColor(folderPath),
    messages: [],
    isThinking: false,
    availableModels: [],
    connectionState: "idle",
    createdAt: now,
    updatedAt: now,
    composerValue: "",
    queuedMessages: [],
    nativeAds: [],
  };
}

/** Maximum number of auto-retry attempts before giving up. */
const MAX_RETRY_ATTEMPTS = 5;
/** Base delay in ms for the first auto-retry (doubles each attempt). */
const RETRY_BASE_DELAY_MS = 2_000;

function computeRetryState(attempt: number, message: string): Tab["retryState"] {
  return {
    attempt,
    message,
    next: Date.now() + RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
  };
}

function applyAgentEvent(
  tab: Tab,
  event: AgentEvent,
  modelMetadata?: Record<string, ModelMetadata>,
): Tab {
  const now = Date.now();
  let next: Tab = tab;
  let changed = false;

  const withPatch = (patch: Partial<Tab>) => {
    const hasChange = Object.keys(patch).some((key) => {
      const k = key as keyof Tab;
      const a = patch[k];
      const b = next[k];
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return true;
        // For messages, compare identity of last few items (cheap heuristic).
        for (let i = Math.max(0, a.length - 3); i < a.length; i++) {
          if (a[i] !== b[i]) return true;
        }
        return false;
      }
      return a !== b;
    });
    if (hasChange) {
      next = { ...next, ...patch, updatedAt: now };
      changed = true;
    }
  };

  const updatedMessages = applyAgentEventToMessages(next.messages, event);
  if (updatedMessages !== next.messages) {
    withPatch({ messages: updatedMessages });
  }

  switch (event.type) {
    case "agent_start": {
      if (!next.isThinking) {
        withPatch({ isThinking: true, thinkingStartedAt: now });
      }
      // Clear transient connection errors and retry state — the
      // agent has recovered and is starting a new turn.
      if (next.connectionError || next.retryState) {
        withPatch({ connectionError: undefined, retryState: undefined });
      }
      break;
    }
    case "agent_end":
    case "agent_complete": {
      // Only clear isThinking when this event still describes the current turn.
      // If the agent has moved on (e.g. auto-retry), the event is stale and
      // must not downgrade the working state.
      if (next.isThinking && isAgentEndCurrent(event, next.messages)) {
        withPatch({ isThinking: false });
      }
      // Clear any lingering retry state on successful completion.
      if (next.retryState) {
        withPatch({ retryState: undefined });
      }
      break;
    }
    case "agent_error": {
      if (next.isThinking) {
        withPatch({ isThinking: false });
      }
      if (next.connectionError !== event.error) {
        withPatch({ connectionError: event.error });
      }
      // Start auto-retry if we haven't exceeded max attempts.
      if (!next.retryState || next.retryState.attempt < MAX_RETRY_ATTEMPTS) {
        const attempt = (next.retryState?.attempt ?? 0) + 1;
        withPatch({ retryState: computeRetryState(attempt, event.error) });
      }
      break;
    }
    case "message_end": {
      const lastAssistant = [...updatedMessages]
        .reverse()
        .find((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant");
      if (lastAssistant) {
        const isError =
          lastAssistant.stopReason === "error" ||
          lastAssistant.stopReason === "aborted" ||
          typeof lastAssistant.errorMessage === "string";
        if (isError) {
          if (next.isThinking) {
            withPatch({ isThinking: false });
          }
          const errorText =
            lastAssistant.errorMessage ||
            `The assistant stopped unexpectedly (${lastAssistant.stopReason ?? "error"}).`;
          if (next.connectionError !== errorText) {
            withPatch({ connectionError: errorText });
          }
          if (next.thinkingBanner) {
            withPatch({ thinkingBanner: undefined });
          }
        }
      }
      break;
    }
    case "herman/models_sync":
    case "models_sync": {
      withPatch({
        currentModel: event.currentModel ?? tab.currentModel,
        availableModels: event.models,
      });
      break;
    }
    case "herman/agent_proxy_error": {
      // Never clear isThinking here — proxy errors are advisory, not lifecycle
      // events.  The agent may have already recovered via auto-retry before
      // this event reaches the renderer (IPC reordering, async extension
      // handler delay).  Let agent_start / agent_end own the working state.
      withPatch({ connectionError: event.error });
      break;
    }
    case "extension_error": {
      withPatch({ connectionError: event.error });
      break;
    }
  }

  // Recompute context stats whenever the conversation or active model changes
  // so the UI always reflects the latest token / context / cost estimate.
  if (
    next.messages !== tab.messages ||
    next.currentModel !== tab.currentModel ||
    next.contextStats === undefined
  ) {
    const nextContextStats = computeTabContextStats(next, modelMetadata);
    if (nextContextStats !== next.contextStats) {
      withPatch({ contextStats: nextContextStats });
    }
  }

  if (!changed) return tab;
  return next;
}

export const useAgentStore = create<AgentState & AgentActions>((set, get) => ({
  tabs: {},
  tabOrder: [],
  activeTabId: undefined,
  projects: [],
  sessions: [],
  ui: {
    sidebarOpen: true,
    sidebarWidth: 288,
    composerValue: "",
    modelSelectorOpen: false,
    view: "home",
    selectedProject: null,
    sidebarTab: "changes",
    diffScope: "last-message",
    diffFiles: {},
    diffLoading: {},
    modelMetadata: {},
  },
  settings: {
    providers: { herman: { enabled: false }, custom: {} },
    models: {},
  },
  ads: {
    focused: true,
    visible: true,
    nativeInsertionsThisSession: 0,
    nativeInsertionsToday: 0,
    nativeInsertionDate: getTodayKey(),
    lastNativeMessageIndex: null,
  },
  onboardingVisible: false,
  session: deriveSession(undefined),
  connection: deriveConnection(undefined),

  createTab: (folderPath, title) => {
    const state = get();
    const inheritedFolder = state.activeTabId ? state.tabs[state.activeTabId].folderPath : "";
    const path = folderPath ?? inheritedFolder;
    const tab = makeTab(path, title);

    set((state) => {
      const tabs = { ...state.tabs, [tab.id]: { ...tab, contextStats: computeTabContextStats(tab, state.ui.modelMetadata) } };
      const tabOrder = [...state.tabOrder, tab.id];
      const nextState: AgentState = { ...state, tabs, tabOrder, activeTabId: tab.id };
      return { ...nextState, ...rebuildDerived(nextState, tabs) };
    });

    return tab.id;
  },

  closeTab: (id) => {
    set((state) => {
      if (!state.tabs[id]) return state;
      const closedTab = state.tabs[id];
      const { [id]: _removed, ...rest } = state.tabs;
      const tabOrder = state.tabOrder.filter((tabId) => tabId !== id);
      let activeTabId = state.activeTabId;

      if (activeTabId === id) {
        const index = state.tabOrder.indexOf(id);
        activeTabId =
          state.tabOrder[index - 1] ?? state.tabOrder[index + 1] ?? tabOrder[0] ?? undefined;
      }

      const hasMessages = hasUserOrAssistantMessage(closedTab.messages);
      const sessions = hasMessages
        ? state.sessions.some((session) => session.id === id)
          ? state.sessions.map((session) =>
              session.id === id
                ? {
                    id: closedTab.id,
                    title: closedTab.title,
                    folderPath: closedTab.folderPath,
                    projectColor: closedTab.projectColor,
                    createdAt: closedTab.createdAt,
                    updatedAt: closedTab.updatedAt,
                  }
                : session,
            )
          : [
              ...state.sessions,
              {
                id: closedTab.id,
                title: closedTab.title,
                folderPath: closedTab.folderPath,
                projectColor: closedTab.projectColor,
                createdAt: closedTab.createdAt,
                updatedAt: closedTab.updatedAt,
              },
            ]
        : state.sessions.filter((session) => session.id !== id);

      const nextState: AgentState = {
        ...state,
        tabs: rest,
        tabOrder,
        activeTabId,
        sessions,
        ui: {
          ...state.ui,
          view: activeTabId ? state.ui.view : "home",
        },
      };
      return { ...nextState, ...rebuildDerived(nextState, rest) };
    });
  },

  addTab: (tab) => {
    syncMessageCounter([tab.messages]);
    set((state) => {
      const tabs = state.tabs[tab.id]
        ? state.tabs
        : { ...state.tabs, [tab.id]: { ...tab, nativeAds: tab.nativeAds ?? [], contextStats: computeTabContextStats(tab, state.ui.modelMetadata) } };
      const tabOrder = state.tabs[tab.id] ? state.tabOrder : [...state.tabOrder, tab.id];
      const persistedSession: PersistedSession = {
        id: tab.id,
        title: tab.title,
        folderPath: tab.folderPath,
        projectColor: tab.projectColor,
        createdAt: tab.createdAt,
        updatedAt: tab.updatedAt,
      };
      const sessions = state.sessions.some((session) => session.id === tab.id)
        ? state.sessions.map((session) => (session.id === tab.id ? persistedSession : session))
        : [...state.sessions, persistedSession];
      const projects =
        tab.folderPath && !state.projects.includes(tab.folderPath)
          ? [...state.projects, tab.folderPath]
          : state.projects;
      const nextState: AgentState = {
        ...state,
        tabs,
        tabOrder,
        activeTabId: tab.id,
        sessions,
        projects,
        ui: { ...state.ui, view: "session" },
      };
      return { ...nextState, ...rebuildDerived(nextState, tabs) };
    });
  },

  activateTab: (id) => {
    set((state) => {
      if (!state.tabs[id]) return state;
      const nextState: AgentState = {
        ...state,
        activeTabId: id,
        ui: { ...state.ui, view: "session" },
      };
      return { ...nextState, ...rebuildDerived(nextState, state.tabs) };
    });
  },

  reorderTabs: (order) => {
    set((state) => {
      if (order.length !== state.tabOrder.length) return state;
      if (!order.every((id) => state.tabs[id])) return state;
      return { tabOrder: order };
    });
  },

  updateTab: (id, partial) => {
    // Skip store update when nothing material changed.  `updatedAt` is
    // metadata that would otherwise produce a new object reference on
    // every call, causing unnecessary re-renders in subscribers that
    // select the entire tab (e.g. `useActiveTab`).
    const state = get();
    const tab = state.tabs[id];
    if (!tab) return;

    // When external messages are provided (e.g. from a full state sync
    // with the main process), advance the local message ID counter so
    // future createMessageId() calls don't collide with IDs that were
    // generated by the main process's independent counter.
    if (partial.messages) {
      syncMessageCounter([partial.messages]);
    }

    const changed = Object.keys(partial).some((key) => {
      const k = key as keyof typeof partial;
      const a = partial[k];
      const b = tab[k];
      if (Array.isArray(a) && Array.isArray(b)) {
        if (k === "availableModels") return !arraysEqual(a as string[], b as string[]);
        if (k === "queuedMessages")
          return !queuedMessagesEqual(a as QueuedFollowUp[], b as QueuedFollowUp[]);
        if (k === "messages") return !messagesEqualish(a as Message[], b as Message[]);
        if (a.length !== b.length) return true;
        // Compare identity of a sample of items (head, tail, middle).
        const indices = [0, Math.floor(a.length / 2), a.length - 1];
        for (const i of indices) {
          if (i >= 0 && i < a.length && a[i] !== b[i]) return true;
        }
        return false;
      }
      return a !== b;
    });
    if (!changed) return;

    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const updated = { ...tab, ...partial, updatedAt: Date.now() };
      // Recompute context stats when messages or the active model change.
      if (partial.messages !== undefined || partial.currentModel !== undefined) {
        const nextStats = computeTabContextStats(updated, state.ui.modelMetadata);
        if (nextStats !== updated.contextStats) {
          updated.contextStats = nextStats;
        }
      }
      const tabs = { ...state.tabs, [id]: updated };
      return {
        tabs,
        sessions: syncSessionFromTab(state.sessions, updated),
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
    });
  },

  renameTab: (id, title) => {
    get().updateTab(id, { title });
  },

  setProjectForTab: (id, folderPath) => {
    get().updateTab(id, {
      folderPath,
      projectColor: getProjectColor(folderPath),
    });
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const persistedSession = {
        id: tab.id,
        title: tab.title,
        folderPath,
        projectColor: getProjectColor(folderPath),
        createdAt: tab.createdAt,
        updatedAt: Date.now(),
      };
      const sessions = state.sessions.map((session) =>
        session.id === id ? persistedSession : session,
      );
      const projects =
        folderPath && !state.projects.includes(folderPath)
          ? [...state.projects, folderPath]
          : state.projects;
      return { sessions, projects };
    });
  },

  appendUserMessage: (tabId, content) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const title = tab.messages.length === 0 ? truncateTitle(content) : tab.title;
      const updated = {
        ...tab,
        messages: [...tab.messages, { id: createMessageId(), role: "user", content } as Message],
        title,
        updatedAt: Date.now(),
      };
      updated.contextStats = computeTabContextStats(updated, state.ui.modelMetadata);
      const tabs = { ...state.tabs, [tabId]: updated };
      return {
        tabs,
        sessions: syncSessionFromTab(state.sessions, updated),
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
    });
  },


  startAssistantMessage: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const updated = {
        ...tab,
        messages: [
          ...tab.messages,
          { id: createMessageId(), role: "assistant", content: "", isStreaming: true } as Message,
        ],
        isThinking: false,
        updatedAt: Date.now(),
      };
      updated.contextStats = computeTabContextStats(updated, state.ui.modelMetadata);
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  appendAssistantDelta: (tabId, delta) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const messages = [...tab.messages];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        last.content += delta;
      }
      const updated = { ...tab, messages, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  finalizeAssistantMessage: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const messages = [...tab.messages];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        last.isStreaming = false;
      }
      const updated = { ...tab, messages, isThinking: false, updatedAt: Date.now() };
      updated.contextStats = computeTabContextStats(updated, state.ui.modelMetadata);
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  stopStreaming: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;

      const messages = finalizeStreamingMessages(tab.messages);
      const needsClear = tab.isThinking || tab.thinkingBanner !== undefined;
      if (messages === tab.messages && !needsClear) return state;

      const updated = {
        ...tab,
        messages,
        isThinking: false,
        thinkingStartedAt: undefined,
        thinkingBanner: undefined,
        updatedAt: Date.now(),
      };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  updateTool: (tabId, toolCallId, update) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const messages = tab.messages.map((m) =>
        m.role === "tool" && m.toolCallId === toolCallId ? { ...m, ...update } : m,
      );
      const updated = { ...tab, messages, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  setThinking: (tabId, isThinking) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const updated: Tab = { ...tab, isThinking, updatedAt: Date.now() };

      if (isThinking && !tab.isThinking) {
        updated.thinkingStartedAt = Date.now();
      }
      if (!isThinking) {
        updated.thinkingBanner = undefined;
      }

      const tabs = { ...state.tabs, [tabId]: updated };
      return {
        tabs,
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
    });
  },

  setModels: (tabId, currentModel, availableModels) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const updated = {
        ...tab,
        currentModel: currentModel ?? tab.currentModel,
        availableModels: availableModels ?? tab.availableModels,
        updatedAt: Date.now(),
      };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  clearTab: (id) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const updated = {
        ...tab,
        messages: [],
        isThinking: false,
        nativeAds: [],
        thinkingBanner: undefined,
        sidebarAd: undefined,
        contextStats: computeTabContextStats({ ...tab, messages: [] }, state.ui.modelMetadata),
        updatedAt: Date.now(),
      };
      const tabs = { ...state.tabs, [id]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  setConnectionState: (tabId, status) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;

      // When the agent process stops or crashes, finalize any open streaming
      // messages so the UI doesn't leave them stuck in a loading state.
      const messages =
        status.state !== "running"
          ? tab.messages.map((m) =>
              m.role === "assistant" && m.isStreaming
                ? { ...m, isStreaming: false }
                : m.role === "tool" && m.status === "running"
                  ? {
                      ...m,
                      status: "error" as const,
                      output: m.output ?? "Agent process stopped unexpectedly",
                    }
                  : m,
            )
          : tab.messages;

      // Start auto-retry on crash if we haven't exceeded max attempts and the
      // tab was actively working (has isThinking or streaming messages).
      const wasWorking = tab.isThinking || tab.messages.some(
        (m) => (m.role === "assistant" && m.isStreaming) || (m.role === "tool" && m.status === "running"),
      );
      let retryState = tab.retryState;
      if (status.state === "crashed" && wasWorking) {
        if (!retryState || retryState.attempt < MAX_RETRY_ATTEMPTS) {
          const attempt = (retryState?.attempt ?? 0) + 1;
          const message = status.stderr
            ? `Agent crashed: ${status.stderr.slice(0, 120)}`
            : "Agent process stopped unexpectedly";
          retryState = computeRetryState(attempt, message);
        }
      } else if (status.state === "running") {
        // Agent recovered — clear transient error state.
        retryState = undefined;
      }

      const updated = {
        ...tab,
        messages,
        connectionState: status.state,
        connectionStderr: status.state === "crashed" ? status.stderr : undefined,
        connectionError: status.state === "crashed" ? status.stderr : undefined,
        // When the agent process stops or crashes, it can't be thinking.
        isThinking: status.state === "running" ? tab.isThinking : false,
        retryState,
        updatedAt: Date.now(),
      };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  setComposerValue: ((tabIdOrValue: string, value?: string) => {
    const hasTabId = typeof tabIdOrValue === "string" && value !== undefined;
    const tabId = hasTabId ? (tabIdOrValue as TabId) : get().activeTabId;
    const nextValue = hasTabId ? value! : (tabIdOrValue as string);
    if (!tabId) return;

    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const updated = { ...tab, composerValue: nextValue, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  }) as AgentActions["setComposerValue"],

  revertTab: (tabId, messageId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      // Verify the message exists and is a user message.
      const revertIdx = tab.messages.findIndex((m) => m.id === messageId);
      if (revertIdx === -1) return state;

      // The revert point is the clicked user message itself.
      // Messages with id >= revertMessageId are hidden.
      // Don't re-revert the same point.
      if (tab.revertMessageId === messageId) return state;

      const updated = { ...tab, revertMessageId: messageId, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return {
        tabs,
        sessions: syncSessionFromTab(state.sessions, updated),
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
    });
  },

  unrevertTab: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      if (!tab.revertMessageId) return state;
      const updated = { ...tab, revertMessageId: undefined, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return {
        tabs,
        sessions: syncSessionFromTab(state.sessions, updated),
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
    });
  },

  toggleSidebar: () =>
    set((state) => ({ ui: { ...state.ui, sidebarOpen: !state.ui.sidebarOpen } })),

  setSidebarWidth: (width) => set((state) => ({ ui: { ...state.ui, sidebarWidth: width } })),

  setSidebarTab: (tab: "changes" | "context" | "ads") => set((state) => ({ ui: { ...state.ui, sidebarTab: tab } })),

  setDiffScope: (scope) =>
    set((state) => ({ ui: { ...state.ui, diffScope: scope } })),

  fetchDiff: async (tabId, scope) => {
    set((state) => ({ ui: { ...state.ui, diffLoading: { ...state.ui.diffLoading, [tabId]: true } } }));
    try {
      const { desktopRpc } = await import("../lib/desktop-rpc.js");
      const { diffs } = await desktopRpc.request.getDiff({ tabId, scope });
      set((state) => ({
        ui: {
          ...state.ui,
          diffFiles: { ...state.ui.diffFiles, [tabId]: diffs },
          diffLoading: { ...state.ui.diffLoading, [tabId]: false },
        },
      }));
    } catch {
      set((state) => ({
        ui: { ...state.ui, diffLoading: { ...state.ui.diffLoading, [tabId]: false } },
      }));
    }
  },

  setModelSelectorOpen: (open) =>
    set((state) => ({ ui: { ...state.ui, modelSelectorOpen: open } })),

  setView: (view) => set((state) => ({ ui: { ...state.ui, view } })),

  setSettings: (settings) => set({ settings }),

  setMode: (mode: "rookie" | "normal") =>
    set((state) => {
      const settings = { ...state.settings, mode };
      return { settings };
    }),

  setOnboardingVisible: (visible) => set({ onboardingVisible: visible }),

  setSelectedProject: (selectedProject) =>
    set((state) => ({ ui: { ...state.ui, selectedProject } })),

  handleProjectOpened: (folderPath, projects) =>
    set((state) => ({
      projects,
      ui: {
        ...state.ui,
        view: "home",
        selectedProject: folderPath,
      },
    })),

  setProjects: (projects) =>
    set((state) => ({
      projects: [...projects],
      ui: {
        ...state.ui,
        selectedProject:
          state.ui.selectedProject && !projects.includes(state.ui.selectedProject)
            ? null
            : state.ui.selectedProject,
      },
    })),

  setSessions: (sessions) =>
    set((state) => {
      // Sync tab titles from updated sessions (e.g., server-generated titles).
      const tabs = { ...state.tabs };
      for (const session of sessions) {
        const tab = tabs[session.id];
        if (
          tab &&
          tab.title !== session.title &&
          session.title !== "New session" &&
          session.title !== "Untitled session" &&
          session.title.trim().length > 0
        ) {
          tabs[session.id] = { ...tab, title: session.title };
        }
      }
      return { sessions: [...sessions], tabs };
    }),

  setAdVisibility: (focused, visible) =>
    set((state) => ({
      ads: { ...state.ads, focused, visible },
    })),

  setTabAd: (tabId, placement, campaign) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      if (placement === "native") {
        // Native ads are only delivered by the agent extension on agent_end.
        return state;
      }
      const updated =
        placement === "thinking_banner"
          ? { ...tab, thinkingBanner: campaign, updatedAt: Date.now() }
          : { ...tab, sidebarAd: campaign, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  clearTabAds: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const updated = { ...tab, thinkingBanner: undefined, sidebarAd: undefined, nativeAds: [] };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  recordAgentEvent: (tabId, event) => {
    const tab = get().tabs[tabId];
    if (!tab) return;

    // Merge any incoming model metadata so context stats can be computed
    // against the latest known context-window limits.
    const mergedModelMetadata =
      (event.type === "models_sync" || event.type === "herman/models_sync") && event.modelMetadata
        ? { ...get().ui.modelMetadata, ...event.modelMetadata }
        : get().ui.modelMetadata;

    const updated = applyAgentEvent(tab, event, mergedModelMetadata);

    // Build the final tab with UI-side effects.
    let nextUpdated = updated;
    let hasUiSideEffects = false;

    // thinkingStartedAt is now set inside applyAgentEvent for agent_start.
    // Keep this guard as a safety net for any other code path that sets
    // isThinking without also setting thinkingStartedAt.
    if (event.type === "agent_start" && !updated.thinkingStartedAt) {
      nextUpdated = { ...updated, thinkingStartedAt: Date.now() };
      hasUiSideEffects = true;
    }

    if (event.type === "agent_end" || event.type === "agent_complete") {
      if (updated.thinkingBanner) {
        nextUpdated = { ...updated, thinkingBanner: undefined };
        hasUiSideEffects = true;
      }
    }

    if (event.type === "herman/ad_event") {
      if (event.placement === "thinking_banner") {
        nextUpdated = { ...updated, thinkingBanner: event.campaign };
        hasUiSideEffects = true;
      } else if (event.placement === "sidebar") {
        nextUpdated = { ...updated, sidebarAd: event.campaign };
        hasUiSideEffects = true;
      } else if (event.placement === "native") {
        // Respect the client-side native frequency cap before showing the ad.
        const state = get();
        const today = getTodayKey();
        const isNewDay = state.ads.nativeInsertionDate !== today;
        const sessionCount = isNewDay ? 0 : state.ads.nativeInsertionsThisSession;
        const todayCount = isNewDay ? 0 : state.ads.nativeInsertionsToday;
        const isSameTurn = state.ads.lastNativeMessageIndex === updated.messages.length;
        if (sessionCount < 3 && todayCount < 5 && !isSameTurn) {
          nextUpdated = {
            ...updated,
            nativeAds: [...(updated.nativeAds ?? []), event.campaign],
          };
          hasUiSideEffects = true;
        }
      }
    }

    const shouldAutoOpen =
      (event.type === "agent_end" || event.type === "agent_complete") &&
      tabId === get().activeTabId &&
      get().ui.view === "session" &&
      !get().ui.sidebarOpen;

    // If nothing changed (idempotent handler) and no side effects needed, skip.
    if (nextUpdated === tab && !hasUiSideEffects && !shouldAutoOpen) return;

    set((state) => {
      const tabs = { ...state.tabs, [tabId]: nextUpdated };
      let nextAds = state.ads;

      if (event.type === "herman/ad_event" && event.placement === "native" && nextUpdated !== tab) {
        const today = getTodayKey();
        const isNewDay = state.ads.nativeInsertionDate !== today;
        nextAds = isNewDay
          ? {
              ...state.ads,
              nativeInsertionsThisSession: 1,
              nativeInsertionsToday: 1,
              nativeInsertionDate: today,
              lastNativeMessageIndex: nextUpdated.messages.length,
            }
          : {
              ...state.ads,
              nativeInsertionsThisSession: state.ads.nativeInsertionsThisSession + 1,
              nativeInsertionsToday: state.ads.nativeInsertionsToday + 1,
              lastNativeMessageIndex: nextUpdated.messages.length,
            };
      }

      let ui = state.ui;
      if (shouldAutoOpen) {
        ui = { ...state.ui, sidebarOpen: true };
      }
      if ((event.type === "models_sync" || event.type === "herman/models_sync") && event.modelMetadata) {
        ui = { ...ui, modelMetadata: { ...ui.modelMetadata, ...event.modelMetadata } };
      }

      // Auto-refresh diffs when a turn completes and the sidebar is showing changes.
      // Defer to avoid calling set() inside a set() callback.
      const turnCompleted = event.type === "agent_end" || event.type === "agent_complete";
      if (turnCompleted && tabId === state.activeTabId && state.ui.sidebarTab === "changes") {
        const diffScope = state.ui.diffScope;
        setTimeout(() => {
          void useAgentStore.getState().fetchDiff(tabId, diffScope);
        }, 0);
      }

      return {
        tabs,
        ...rebuildDerived({ ...state, tabs, ui }, tabs),
        ads: nextAds,
      };
    });
  },

  queueMessage: (tabId, text) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const queuedMessages: QueuedFollowUp[] = [
        ...tab.queuedMessages,
        { id: crypto.randomUUID(), text },
      ];
      const updated = { ...tab, queuedMessages, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  removeQueuedMessage: (tabId, id) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const queuedMessages = tab.queuedMessages.filter((m) => m.id !== id);
      if (queuedMessages.length === tab.queuedMessages.length) return state;
      const updated = { ...tab, queuedMessages, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  editQueuedMessage: (tabId, id, text) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const queuedMessages = tab.queuedMessages.map((m) => (m.id === id ? { ...m, text } : m));
      const updated = { ...tab, queuedMessages, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  dequeueMessage: (tabId) => {
    const tab = get().tabs[tabId];
    if (!tab?.queuedMessages?.length) return undefined;
    const [next, ...rest] = tab.queuedMessages;
    const updated = { ...tab, queuedMessages: rest, updatedAt: Date.now() };
    const tabs = { ...get().tabs, [tabId]: updated };
    set({ tabs, ...rebuildDerived({ ...get(), tabs }, tabs) });
    return next;
  },

  clearSession: () => {
    const tabId = get().activeTabId;
    if (tabId) {
      get().clearTab(tabId);
    }
  },

  restoreTabs: (tabs, activeTabId, projects, sessions) => {
    set((state) => {
      const record: Record<TabId, Tab> = {};
      for (const tab of tabs) {
        // Backfill IDs on any persisted messages that predate the id field.
        const messages = tab.messages.map((m) => (m.id ? m : { ...m, id: createMessageId() }));
        // Backfill queuedMessages for sessions saved before that field existed.
        const queuedMessages = tab.queuedMessages ?? [];
        // Native ads and retry state are ephemeral and must not be restored from disk.
        const { providerId, modelId } = parseCurrentModel(tab.currentModel);
        const contextLimit = state.ui.modelMetadata[tab.currentModel ?? ""]?.contextWindow;
        const contextStats = computeContextStats(tab.messages, modelId, providerId, contextLimit);
        record[tab.id] = { ...tab, messages, queuedMessages, nativeAds: [], retryState: undefined, contextStats };
      }
      // Sync the local counter past the maximum ID from restored messages so
      // new streaming events don't produce colliding ids.
      syncMessageCounter(Object.values(record).map((t) => t.messages));
      const tabOrder = tabs.map((tab) => tab.id);
      const nextState: AgentState = {
        ...state,
        tabs: record,
        tabOrder,
        activeTabId,
        projects: projects ?? state.projects,
        sessions: sessions ?? state.sessions,
        ui: {
          ...state.ui,
          view: activeTabId ? "session" : "home",
        },
      };
      return { ...nextState, ...rebuildDerived(nextState, record) };
    });
  },
}));

// Dev-only: log every store mutation so we can trace what's causing
// periodic re-renders after streaming ends.
// Tree-shaken at production build time (import.meta.env.DEV → false).
if (import.meta.env.DEV) {
  useAgentStore.subscribe((state, prevState) => {
    const changed: string[] = [];
    if (state.activeTabId !== prevState.activeTabId) changed.push("activeTabId");
    if (state.tabs !== prevState.tabs) changed.push("tabs");
    if (state.ui !== prevState.ui) changed.push("ui");
    if (state.session !== prevState.session) changed.push("session");
    if (state.connection !== prevState.connection) changed.push("connection");
    if (state.tabOrder !== prevState.tabOrder) changed.push("tabOrder");
    if (state.projects !== prevState.projects) changed.push("projects");
    if (state.sessions !== prevState.sessions) changed.push("sessions");
    if (changed.length === 0) return;

    const tabDiffs: string[] = [];
    if (state.tabs !== prevState.tabs) {
      for (const id of Object.keys(state.tabs)) {
        const prevTab = prevState.tabs[id];
        const nextTab = state.tabs[id];
        if (!prevTab || !nextTab || prevTab === nextTab) continue;
        const fields: string[] = [];
        for (const key of Object.keys(nextTab) as (keyof Tab)[]) {
          if (key === "updatedAt") continue;
          if (nextTab[key] !== prevTab[key]) fields.push(key);
        }
        if (fields.length > 0) tabDiffs.push(`${id}: ${fields.join(",")}`);
      }
    }

    console.log(
      "[store] mutation:",
      changed.join(", "),
      tabDiffs.length > 0 ? `| ${tabDiffs.join(" | ")}` : "",
      new Date().toISOString(),
    );
  });
}

export function useActiveTab() {
  return useAgentStore((state) => (state.activeTabId ? state.tabs[state.activeTabId] : undefined));
}

/** Returns the active tab with only stable fields — excludes composerValue and updatedAt
 *  which change on every keystroke and cause unnecessary re-renders.
 *  @deprecated Prefer granular selectors or useActiveTabStable for most cases. */
export function useActiveTabStable(): Omit<Tab, "composerValue" | "updatedAt"> | undefined {
  return useAgentStore(
    useShallow((state) => {
      const tab = state.activeTabId ? state.tabs[state.activeTabId] : undefined;
      if (!tab) return undefined;
      const { composerValue: _, updatedAt: __, ...rest } = tab;
      return rest;
    }),
  );
}

/** Returns just the composer value for the active tab, isolated from other tab changes. */
export function useComposerValue(): string {
  return useAgentStore((state) =>
    state.activeTabId ? (state.tabs[state.activeTabId]?.composerValue ?? "") : "",
  );
}

export function isTabWorking(tab: Tab | undefined): boolean {
  if (!tab) return false;
  if (tab.isThinking) return true;

  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const message = tab.messages[i];
    if (!message) continue;
    if (message.role === "assistant" && message.isStreaming) return true;
    if (message.role === "tool" && message.status === "running") return true;
    if (message.role === "user") break;
  }

  return false;
}

/** Returns true when the agent process for the tab is currently running. */
export function isTabAgentRunning(tabId: TabId): boolean {
  return useAgentStore.getState().tabs[tabId]?.connectionState === "running";
}
export function useTab(id: TabId) {
  return useAgentStore((state) => state.tabs[id]);
}

export function useTabs() {
  return useAgentStore(useShallow((state) => state.tabOrder.map((id) => state.tabs[id])));
}

/** Returns minimal stable data for rendering tab bar items. */
export function useTabSummaries() {
  // Derive a version hash from tab metadata (order, titles, paths).
  // This only changes when tabs are created/closed/renamed/reordered —
  // never during text streaming, so the downstream component stays stable.
  const version = useAgentStore(
    useShallow((state) =>
      state.tabOrder
        .map((id) => {
          const tab = state.tabs[id];
          return tab ? `${id}\x00${tab.title}\x00${tab.folderPath}` : "";
        })
        .join("\x01"),
    ),
  );

  return useMemo(() => {
    const state = useAgentStore.getState();
    return state.tabOrder
      .map((id) => {
        const tab = state.tabs[id];
        return tab ? { id: tab.id, title: tab.title, folderPath: tab.folderPath } : null;
      })
      .filter(Boolean) as { id: TabId; title: string; folderPath: string }[];
    // Rebuild only when the version changes (i.e., tab metadata changed).
  }, [version]);
}

/** Returns true when the active tab has an in-progress agent operation. */
export function useIsActiveTabWorking(): boolean {
  return useAgentStore((state) => {
    const tab = state.activeTabId ? state.tabs[state.activeTabId] : undefined;
    if (!tab) return false;
    if (tab.isThinking) return true;
    const messages = tab.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      if (message.role === "assistant" && message.isStreaming) return true;
      if (message.role === "tool" && message.status === "running") return true;
      if (message.role === "user") return false;
    }
    return false;
  });
}

export type AppSession = {
  session?: Session;
};

export const useAppStore = create<
  AppSession & {
    setSession: (session?: Session) => void;
  }
>((set) => ({
  setSession: (session) => set({ session }),
}));
