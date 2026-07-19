import { create } from "zustand";
import {
  createMessageId,
  finalizeStreamingMessages,
  syncMessageCounter,
} from "../../../../shared/apply-agent-event.js";
import type { ContextStats, Message, PersistedSession } from "../../../../shared/rpc.js";
import type { TabId } from "../../../../shared/tab-utils.js";
import {
  getProjectColor,
  getProjectName,
  hasUserOrAssistantMessage,
  truncateTitle,
} from "../../../../shared/tab-utils.js";
import { desktopRpc } from "../desktop-rpc.js";
import { applyAgentEvent } from "./apply-agent-event.js";
import {
  arraysEqual,
  contextStatsEqual,
  messagesEqualish,
  queuedMessagesEqual,
} from "./compare.js";
import {
  emptyContextStats,
  INITIAL_ADS_STATE,
  INITIAL_UI_STATE,
  makeTab,
  syncSessionFromTab,
} from "./defaults.js";
import { rebuildDerived } from "./derive.js";
import type { AgentActions, AgentState, Tab } from "./types.js";
import { INITIAL_WIZARD_STATE } from "./types.js";
import { computeRetryState, getTodayKey, MAX_RETRY_ATTEMPTS } from "./utils.js";

/**
 * Merge a fresh `emptyContextStats` (which always has correct message
 * counts) with token/cost data from a prior `herman/context_report`.
 *
 * `emptyContextStats` is a zero-token placeholder. Once the agent has
 * streamed real numbers via `herman/context_report`, local updates
 * (polling, user message appends, finalizations) must preserve those
 * numbers — otherwise the gauge flickers to zero on every poll and
 * resets permanently when streaming ends.
 */
function preserveLiveContextStats(
  fresh: ContextStats,
  existing: ContextStats | undefined,
): ContextStats {
  if (
    !existing ||
    (existing.contextLimit === 0 &&
      existing.totalTokens === 0 &&
      existing.inputTokens === 0 &&
      existing.outputTokens === 0)
  ) {
    return fresh;
  }
  return {
    ...fresh,
    totalTokens: existing.totalTokens,
    inputTokens: existing.inputTokens,
    outputTokens: existing.outputTokens,
    reasoningTokens: existing.reasoningTokens,
    cacheReadTokens: existing.cacheReadTokens,
    cacheWriteTokens: existing.cacheWriteTokens,
    estimatedCost: existing.estimatedCost,
    contextLimit: existing.contextLimit,
    isCompacted: existing.isCompacted,
    isStreaming: existing.isStreaming,
    currentTurnOutput: existing.currentTurnOutput,
    updatedAt: existing.updatedAt,
  };
}

export const useAgentStore = create<AgentState & AgentActions>((set, get) => ({
  tabs: {},
  tabOrder: [],
  activeTabId: undefined,
  projects: [],
  sessions: [],
  ui: INITIAL_UI_STATE,
  settings: {
    providers: { herman: { enabled: false }, custom: {} },
    models: {},
  },
  ads: INITIAL_ADS_STATE,
  onboardingVisible: false,
  modelCatalog: { availableModels: [] },
  wizard: { ...INITIAL_WIZARD_STATE },
  session: { messages: [], isThinking: false, availableModels: [] },
  connection: { state: "idle" },

  // -----------------------------------------------------------------------
  // Tab lifecycle
  // -----------------------------------------------------------------------

  createTab: (folderPath, title) => {
    const state = get();
    const inheritedFolder = state.activeTabId ? state.tabs[state.activeTabId].folderPath : "";
    const path = folderPath ?? inheritedFolder;
    const tab = makeTab(path, title);
    // The renderer does not resolve git roots; projectRoot is set by the main
    // process when the tab is created. Use folderPath as a fallback here.
    tab.projectRoot = path;
    tab.projectColor = getProjectColor(path);
    // Inherit the user's last-used model for new tabs (the main process
    // does the same for real tab creation).
    if (state.settings.models.lastUsedModel) {
      tab.currentModel = state.settings.models.lastUsedModel;
    }
    if (!title && path) {
      tab.title = getProjectName(path);
    }

    set((state) => {
      const tabs = {
        ...state.tabs,
        [tab.id]: { ...tab, contextStats: emptyContextStats(tab.messages, tab.currentModel) },
      };
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
                    projectRoot: closedTab.projectRoot,
                    projectColor: closedTab.projectColor,
                    createdAt: closedTab.createdAt,
                    updatedAt: closedTab.updatedAt,
                    currentModel: closedTab.currentModel,
                  }
                : session,
            )
          : [
              ...state.sessions,
              {
                id: closedTab.id,
                title: closedTab.title,
                folderPath: closedTab.folderPath,
                projectRoot: closedTab.projectRoot,
                projectColor: closedTab.projectColor,
                createdAt: closedTab.createdAt,
                updatedAt: closedTab.updatedAt,
                currentModel: closedTab.currentModel,
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
      const hydratedTab: Tab = {
        ...tab,
        setup: tab.setup ?? { phase: "none" },
        nativeAds: tab.nativeAds ?? [],
        contextStats: tab.contextStats ?? emptyContextStats(tab.messages, tab.currentModel),
        messagesHydrationStatus:
          tab.messages.length > 0 ? "success" : tab.folderPath ? "pending" : undefined,
      };
      const tabs = state.tabs[tab.id]
        ? { ...state.tabs, [tab.id]: { ...state.tabs[tab.id], ...hydratedTab } }
        : { ...state.tabs, [tab.id]: hydratedTab };
      const tabOrder = state.tabs[tab.id] ? state.tabOrder : [...state.tabOrder, tab.id];
      const persistedSession: PersistedSession = {
        id: tab.id,
        title: tab.title,
        folderPath: tab.folderPath,
        projectRoot: tab.projectRoot,
        projectColor: tab.projectColor,
        createdAt: tab.createdAt,
        updatedAt: tab.updatedAt,
        currentModel: tab.currentModel,
      };
      const sessions = state.sessions.some((session) => session.id === tab.id)
        ? state.sessions.map((session) => (session.id === tab.id ? persistedSession : session))
        : [...state.sessions, persistedSession];
      const projects =
        tab.projectRoot && !state.projects.includes(tab.projectRoot)
          ? [...state.projects, tab.projectRoot]
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

  // -----------------------------------------------------------------------
  // Tab mutations
  // -----------------------------------------------------------------------

  updateTab: (id, partial) => {
    const state = get();
    const tab = state.tabs[id];
    if (!tab) return false;

    if (partial.messages) {
      syncMessageCounter([partial.messages]);
    }

    const changed = Object.keys(partial).some((key) => {
      const k = key as keyof typeof partial;
      const a = partial[k];
      const b = tab[k];
      if (k === "contextStats")
        return !contextStatsEqual(a as ContextStats | undefined, b as ContextStats | undefined);
      if (Array.isArray(a) && Array.isArray(b)) {
        if (k === "availableModels") return !arraysEqual(a as string[], b as string[]);
        if (k === "queuedMessages")
          return !queuedMessagesEqual(
            a as typeof tab.queuedMessages,
            b as typeof tab.queuedMessages,
          );
        if (k === "messages") return !messagesEqualish(a as Message[], b as Message[]);
        if (a.length !== b.length) return true;
        const indices = [0, Math.floor(a.length / 2), a.length - 1];
        for (const i of indices) {
          if (i >= 0 && i < a.length && a[i] !== b[i]) return true;
        }
        return false;
      }
      return a !== b;
    });
    if (!changed) return false;

    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const updated = { ...tab, ...partial, updatedAt: Date.now() };
      if (partial.messages !== undefined || partial.currentModel !== undefined) {
        const nextStats = preserveLiveContextStats(
          emptyContextStats(updated.messages, updated.currentModel),
          updated.contextStats,
        );
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
    return true;
  },

  renameTab: (id, title) => {
    get().updateTab(id, { title });
  },

  setProjectForTab: (id, project) => {
    const folderPath = project.folderPath;
    const projectRoot = project.projectRoot ?? folderPath;
    get().updateTab(id, {
      folderPath,
      projectRoot,
      projectColor: getProjectColor(projectRoot),
    });
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const persistedSession = {
        id: tab.id,
        title: tab.title,
        folderPath,
        projectRoot,
        projectColor: getProjectColor(projectRoot),
        createdAt: tab.createdAt,
        updatedAt: Date.now(),
        currentModel: tab.currentModel,
      };
      const sessions = state.sessions.map((session) =>
        session.id === id ? persistedSession : session,
      );
      const projects =
        projectRoot && !state.projects.includes(projectRoot)
          ? [...state.projects, projectRoot]
          : state.projects;
      return { sessions, projects };
    });
  },

  // -----------------------------------------------------------------------
  // Message streaming
  // -----------------------------------------------------------------------

  appendUserMessage: (tabId, content, messageId) => {
    const nextMessageId = messageId ?? createMessageId();
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const title = tab.messages.length === 0 ? truncateTitle(content) : tab.title;
      const updated = {
        ...tab,
        messages: [...tab.messages, { id: nextMessageId, role: "user", content } as Message],
        title,
        updatedAt: Date.now(),
      };
      updated.contextStats = preserveLiveContextStats(
        emptyContextStats(updated.messages, updated.currentModel),
        tab.contextStats,
      );
      const tabs = { ...state.tabs, [tabId]: updated };
      return {
        tabs,
        sessions: syncSessionFromTab(state.sessions, updated),
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
    });
    return nextMessageId;
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
      updated.contextStats = preserveLiveContextStats(
        emptyContextStats(updated.messages, updated.currentModel),
        tab.contextStats,
      );
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
      updated.contextStats = preserveLiveContextStats(
        emptyContextStats(updated.messages, updated.currentModel),
        tab.contextStats,
      );
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

  setShowThinking: (tabId, enabled) => {
    const state = get();
    const tab = state.tabs[tabId];
    if (!tab || tab.showThinking === enabled) return;
    state.updateTab(tabId, { showThinking: enabled });
  },

  // -----------------------------------------------------------------------
  // Models & connection
  // -----------------------------------------------------------------------

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
      return {
        tabs,
        ...rebuildDerived({ ...state, tabs }, tabs),
      };
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
        contextStats: emptyContextStats([], tab.currentModel),
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
      const wasWorking =
        tab.isThinking ||
        tab.messages.some(
          (m) =>
            (m.role === "assistant" && m.isStreaming) ||
            (m.role === "tool" && m.status === "running"),
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
        retryState = undefined;
      }

      const updated = {
        ...tab,
        messages,
        connectionState: status.state,
        connectionStderr: status.state === "crashed" ? status.stderr : undefined,
        connectionError:
          status.state === "crashed"
            ? (status.stderr ?? "Agent process stopped unexpectedly")
            : undefined,
        isThinking: status.state === "running" ? tab.isThinking : false,
        retryState,
        updatedAt: Date.now(),
      };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  // -----------------------------------------------------------------------
  // Agent events (the core turn handler)
  // -----------------------------------------------------------------------

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
      if (
        (event.type === "models_sync" || event.type === "herman/models_sync") &&
        event.modelMetadata
      ) {
        ui = { ...ui, modelMetadata: { ...ui.modelMetadata, ...event.modelMetadata } };
      }

      // Auto-refresh diffs when a turn completes and the sidebar is showing changes.
      const turnCompleted = event.type === "agent_end" || event.type === "agent_complete";
      if (turnCompleted && tabId === state.activeTabId && state.ui.sidebarTab === "changes") {
        const diffScope = state.ui.diffScope;
        setTimeout(() => {
          void useAgentStore.getState().fetchDiff(tabId, diffScope);
        }, 0);
      }

      // NOTE: the shared model catalog is intentionally NOT updated from
      // models_sync events — the main-process ModelCatalogService owns it
      // and pushes authoritative snapshots via modelCatalogChanged.

      return {
        tabs,
        ...rebuildDerived({ ...state, tabs, ui }, tabs),
        ads: nextAds,
      };
    });
  },

  // -----------------------------------------------------------------------
  // UI actions
  // -----------------------------------------------------------------------

  setComposerValue: ((tabIdOrValue: string, value?: string) => {
    const hasTabId = typeof tabIdOrValue === "string" && value !== undefined;
    const tabId = hasTabId ? (tabIdOrValue as TabId) : get().activeTabId;
    const nextValue = hasTabId ? (value as string) : (tabIdOrValue as string);
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
      const revertIdx = tab.messages.findIndex((m) => m.id === messageId);
      if (revertIdx === -1) return state;
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

  setSidebarTab: (tab: "changes" | "context" | "ads") =>
    set((state) => ({ ui: { ...state.ui, sidebarTab: tab } })),

  setDiffScope: (scope) => set((state) => ({ ui: { ...state.ui, diffScope: scope } })),

  fetchDiff: async (tabId, scope) => {
    set((state) => ({
      ui: { ...state.ui, diffLoading: { ...state.ui.diffLoading, [tabId]: true } },
    }));
    try {
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

  setModelCatalog: (models, opts) =>
    set((state) => {
      // Never wipe a populated catalog with an empty payload.
      if (models.length === 0 && state.modelCatalog.availableModels.length > 0) {
        return state;
      }
      const next = opts?.merge
        ? [...new Set([...state.modelCatalog.availableModels, ...models])]
        : [...new Set(models)];
      if (arraysEqual(state.modelCatalog.availableModels, next)) return state;
      return { modelCatalog: { availableModels: next } };
    }),

  /** Apply an authoritative catalog snapshot from the main process. */
  applyModelCatalog: (snapshot) =>
    set((state) => {
      const models = [...new Set(snapshot.models)];
      const catalogUnchanged = arraysEqual(state.modelCatalog.availableModels, models);
      const metadata = snapshot.modelMetadata ?? {};
      const hasNewMetadata = Object.keys(metadata).some(
        (key) => state.ui.modelMetadata[key] !== metadata[key],
      );
      if (catalogUnchanged && !hasNewMetadata) return state;
      return {
        ...(catalogUnchanged ? {} : { modelCatalog: { availableModels: models } }),
        ui: hasNewMetadata
          ? { ...state.ui, modelMetadata: { ...state.ui.modelMetadata, ...metadata } }
          : state.ui,
      };
    }),

  setWizardCurrentModel: (modelId) =>
    set((state) => ({
      wizard: { ...state.wizard, currentModel: modelId },
    })),

  setWizardSessionId: (sessionId) =>
    set((state) => ({
      wizard: { ...state.wizard, sessionId },
    })),

  setWizardActive: (active) =>
    set((state) => ({
      wizard: { ...state.wizard, active },
    })),

  setWizardStep: (step) =>
    set((state) => ({
      wizard: { ...state.wizard, step },
    })),

  setWizardDescription: (description) =>
    set((state) => ({
      wizard: { ...state.wizard, description },
    })),

  setWizardSelectedTemplateId: (templateId) =>
    set((state) => ({
      wizard: { ...state.wizard, selectedTemplateId: templateId },
    })),

  setWizardProgressLines: (lines) =>
    set((state) => ({
      wizard: {
        ...state.wizard,
        progressLines: typeof lines === "function" ? lines(state.wizard.progressLines) : lines,
      },
    })),

  setWizardEnvelope: (envelope) =>
    set((state) => ({
      wizard: { ...state.wizard, envelope },
    })),

  setWizardPendingRequestId: (requestId) =>
    set((state) => ({
      wizard: { ...state.wizard, pendingRequestId: requestId },
    })),

  setWizardProjectPath: (projectPath) =>
    set((state) => ({
      wizard: { ...state.wizard, projectPath },
    })),

  setWizardError: (error) =>
    set((state) => ({
      wizard: { ...state.wizard, wizardError: error },
    })),

  setWizardRetry: (attempt, max) =>
    set((state) => ({
      wizard: {
        ...state.wizard,
        retryAttempt: attempt,
        ...(typeof max === "number" ? { retryMax: max } : {}),
      },
    })),

  patchWizard: (partial) =>
    set((state) => ({
      wizard: { ...state.wizard, ...partial },
    })),

  hydrateWizardFromRecovery: (payload) =>
    set((state) => ({
      wizard: {
        ...state.wizard,
        active: true,
        sessionId: payload.sessionId,
        selectedTemplateId: payload.templateId ?? state.wizard.selectedTemplateId,
        description: payload.description ?? state.wizard.description,
        progressLines: payload.progressLines ?? state.wizard.progressLines,
        projectPath: payload.projectPath ?? state.wizard.projectPath ?? null,
        wizardError: payload.wizardError ?? null,
        recoveryMode: "continue",
        recoveryBlocked: Boolean(payload.recoveryBlocked),
        step: "recovery",
        phase: payload.phase ?? "planning",
        ...(payload.preferredModel ? { currentModel: payload.preferredModel } : {}),
        envelope: null,
        pendingRequestId: null,
        retryAttempt: 0,
      },
    })),

  clearWizardState: () =>
    set((state) => ({
      wizard: {
        ...INITIAL_WIZARD_STATE,
        currentModel: state.wizard.currentModel,
      },
    })),

  deactivateWizard: () =>
    set((state) => ({
      wizard: { ...state.wizard, active: false },
    })),
  setView: (view) =>
    set((state) => {
      // Guard: "session" and "publishing" views require a valid active tab
      // with a project folder. If no project is associated, redirect to home.
      if (view === "session" || view === "publishing") {
        const activeTab = state.activeTabId ? state.tabs[state.activeTabId] : undefined;
        if (!activeTab?.folderPath) {
          return { ui: { ...state.ui, view: "home" } };
        }
      }
      return { ui: { ...state.ui, view } };
    }),

  setSettings: (settings) => set({ settings }),

  setMode: (mode: "rookie" | "normal") =>
    set((state) => {
      const settings = { ...state.settings, mode };
      return { settings };
    }),

  setOnboardingVisible: (visible) => set({ onboardingVisible: visible }),

  setSelectedProject: (selectedProject) =>
    set((state) => ({ ui: { ...state.ui, selectedProject } })),

  handleProjectOpened: (projectRoot, projects) =>
    set((state) => ({
      projects,
      ui: {
        ...state.ui,
        view: "home",
        selectedProject: projectRoot,
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

  // -----------------------------------------------------------------------
  // Ads
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Queued messages & attachments
  // -----------------------------------------------------------------------

  queueMessage: (tabId, text) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const queuedMessages = [...tab.queuedMessages, { id: crypto.randomUUID(), text }];
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

  addAttachment: (tabId, attachment) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const current = tab.pendingAttachments ?? [];
      if (current.some((a) => a.path === attachment.path)) {
        return state;
      }
      const pendingAttachments = [...current, attachment];
      const updated = { ...tab, pendingAttachments, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  removeAttachment: (tabId, id) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const current = tab.pendingAttachments ?? [];
      const pendingAttachments = current.filter((a) => a.id !== id);
      if (pendingAttachments.length === current.length) return state;
      const updated = { ...tab, pendingAttachments, updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  clearAttachments: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const current = tab.pendingAttachments ?? [];
      if (current.length === 0) return state;
      const updated = { ...tab, pendingAttachments: [], updatedAt: Date.now() };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },

  clearSession: () => {
    const tabId = get().activeTabId;
    if (tabId) {
      get().clearTab(tabId);
    }
  },

  // -----------------------------------------------------------------------
  // Restore
  // -----------------------------------------------------------------------

  restoreTabs: (tabs, activeTabId, projects, sessions) => {
    set((state) => {
      const record: Record<TabId, Tab> = {};
      for (const tab of tabs) {
        const messages = tab.messages.map((m) => (m.id ? m : { ...m, id: createMessageId() }));
        const queuedMessages = tab.queuedMessages ?? [];
        const contextStats = tab.contextStats ?? emptyContextStats(messages, tab.currentModel);
        record[tab.id] = {
          ...tab,
          setup: tab.setup ?? { phase: "none" },
          messages,
          queuedMessages,
          pendingAttachments: tab.pendingAttachments ?? [],
          nativeAds: [],
          retryState: undefined,
          showThinking: tab.showThinking ?? false,
          thinkingMessages: tab.thinkingMessages ?? [],
          contextStats,
          messagesHydrationStatus:
            messages.length > 0 ? "success" : tab.folderPath ? "pending" : undefined,
        };
      }
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

  applyMessagesHydration: (tabId, status, messages, error, contextStats) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      syncMessageCounter([messages]);
      const updated: Tab = {
        ...tab,
        messages,
        thinkingMessages: [],
        messagesHydrationStatus: status,
        messagesHydrationError: error,
        ...(contextStats ? { contextStats } : {}),
        updatedAt: Date.now(),
      };
      const tabs = { ...state.tabs, [tabId]: updated };
      return { tabs, ...rebuildDerived({ ...state, tabs }, tabs) };
    });
  },
}));
