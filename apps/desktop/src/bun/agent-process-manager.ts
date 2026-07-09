import { homedir } from "node:os";

import { getLogger } from "@logtape/logtape";
import { Utils } from "electrobun/bun";

import type { AgentCommand, AgentEvent, AgentResponse } from "../shared/agent-protocol.js";
import {
  applyAgentEventToMessages,
  createMessageId,
  finalizeStreamingMessages,
  isAgentEndCurrent,
  syncMessageCounter,
} from "../shared/apply-agent-event.js";
import type { AgentStatus, ContextStats, Message, Tab, TabId, TabMessagesHydrated, TabMessageHydrationStatus } from "../shared/rpc.js";
import {
  createTabId,
  getProjectColor,
  getProjectName,
  hasUserOrAssistantMessage,
  truncateTitle,
} from "../shared/tab-utils.js";
import { AgentBridge, cleanupTabAgentDir, type AgentBridgeState } from "./agent-bridge.js";
import { AgentRuntime } from "./agent-runtime.js";
import { deleteComposerDraft, loadComposerDraft, saveComposerDraft } from "./composer-drafts.js";
import {
  extractMessagesFromAgentPayload,
} from "./pi-messages.js";
import { contextStatsFromContextReport } from "./session-snapshot.js";
import { stopDevServer } from "./preview-server.js";
import { rewindManager, getUserMessageIds, readPiSessionId } from "./rewind-manager.js";
import { deleteTabHistory, saveTabHistory } from "./tab-history.js";
import { loadInstantHydration } from "./tab-message-hydration.js";
import { resolvePiSessionFile } from "./pi-session.js";
import { createSessionWorktree, ensureSessionWorktree, removeSessionWorktree } from "./worktree.js";
import { TabSessionStore } from "./tab-session-store.js";
import { loadWindowState, saveWindowState, type PersistedSession } from "./window-state.js";
import { isGitRepo } from "./rewind-core.js";

const logger = getLogger(["herman-desktop", "agent-process-manager"]);

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const COMPOSER_DRAFT_SAVE_DEBOUNCE_MS = 1000;
const BACKGROUND_SYNC_READY_ATTEMPTS = 4;
const BACKGROUND_SYNC_RETRY_MS = 100;

export type MessageHydrationResult = {
  status: TabMessageHydrationStatus;
  messages: Message[];
  contextStats?: ContextStats;
  error?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WebviewSender = {
  send: {
    agentEvent: (payload: { tabId: TabId; event: AgentEvent }) => void;
    agentStatusChanged: (payload: {
      tabId: TabId;
      state: AgentBridgeState;
      stderr?: string;
    }) => void;
    tabFolderChanged: (payload: { tabId: TabId; folderPath?: string }) => void;
    sessionsChanged: (payload: { sessions: PersistedSession[] }) => void;
    tabMessagesHydrated: (payload: TabMessagesHydrated) => void;
  };
};

export type AgentProcessManagerOptions = {
  webviewRpc: WebviewSender;
  serverUrl: string;
  getToken: () => Promise<string | undefined>;
  getHermanEnabled: () => boolean;
  getMode: () => "rookie" | "normal" | undefined;
};

export class AgentProcessManager {
  private store = new TabSessionStore();
  private bridges = new Map<TabId, AgentBridge>();
  private composerDraftTimers = new Map<TabId, ReturnType<typeof setTimeout>>();
  private hydrationResults = new Map<TabId, MessageHydrationResult>();
  private agentRuntime: AgentRuntime;
  private webviewRpc: WebviewSender;
  private getToken: () => Promise<string | undefined>;
  private getHermanEnabled: () => boolean;
  private getMode: () => "rookie" | "normal" | undefined;
  private serverUrl: string;

  constructor(options: AgentProcessManagerOptions) {
    this.webviewRpc = options.webviewRpc;
    this.serverUrl = options.serverUrl;
    this.getToken = options.getToken;
    this.getHermanEnabled = options.getHermanEnabled;
    this.getMode = options.getMode;
    this.agentRuntime = new AgentRuntime((tabId) => this.ensureAgentForTab(tabId));
  }

  private restoreDeferred = createDeferred<void>();

  /** Returns a promise that resolves once the initial restore (or a reset) completes.
   *  RPC handlers should await this so they never return empty state before restore finishes. */
  waitForRestore(): Promise<void> {
    return this.restoreDeferred.promise;
  }

  async restore(): Promise<{
    tabs: Tab[];
    activeTabId?: TabId;
    projects: string[];
    sessions: PersistedSession[];
  }> {
    const previousRestore = this.restoreDeferred;
    const nextRestore = createDeferred<void>();
    this.restoreDeferred = nextRestore;

    try {
      const { cleanStalePins } = await import("./persistence.js");
      try {
        cleanStalePins();
      } catch (error) {
        logger.warning("Failed to clean stale provider pins", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const state = await loadWindowState();
      const persistedSessions = state.sessions ?? [];
      const openTabIds = state.openTabIds ?? [];
      this.store.projects = state.projects ?? [];
      this.store.openTabIds = openTabIds;
      this.store.activeTabId = state.activeTabId;

      for (const persisted of persistedSessions) {
        this.store.sessions.set(persisted.id, persisted);
        if (!persisted.folderPath || this.store.projects.includes(persisted.folderPath)) continue;
        if (openTabIds.includes(persisted.id)) {
          this.store.projects.push(persisted.folderPath);
        }
      }

      const agentTabIds: TabId[] = [];
      for (const tabId of openTabIds) {
        const persisted = this.store.sessions.get(tabId);
        if (!persisted) continue;
        const composerValue = await loadComposerDraft(tabId);
        const instant = await loadInstantHydration(tabId, persisted);
        const tab = this.materializeTabFromHydration(persisted, instant, composerValue);
        syncMessageCounter([tab.messages]);
        this.store.tabs.set(tabId, tab);
        if (tab.folderPath) {
          agentTabIds.push(tabId);
        }
      }

      this.agentRuntime.scheduleMany(agentTabIds);

      if (this.store.activeTabId && !this.store.tabs.has(this.store.activeTabId)) {
        this.store.activeTabId = this.store.openTabIds[0];
      }

      await this.persist();

      return {
        tabs: this.getOpenTabs(),
        activeTabId: this.store.activeTabId,
        projects: [...this.store.projects],
        sessions: [...this.store.sessions.values()],
      };
    } finally {
      nextRestore.resolve();
      previousRestore.resolve();
    }
  }

  async createTab(folderPath?: string, title?: string): Promise<Tab> {
    const inheritedFolder = this.store.activeTabId
      ? this.store.tabs.get(this.store.activeTabId)?.folderPath
      : undefined;
    const state = await loadWindowState();
    const lastFolder = state.lastFolderPath;
    const path = folderPath ?? inheritedFolder ?? lastFolder ?? "";
    const tab = this.makeTab(path, title);
    const mode = this.getMode();
    if (mode === "rookie" && path && (await isGitRepo(path))) {
      const hasConcurrentProject = this.store.openTabIds.some((id) => {
        const existing = this.store.tabs.get(id);
        if (!existing) return false;
        if (existing.folderPath === path) return true;
        return existing.worktree?.mainFolderPath === path;
      });
      if (hasConcurrentProject) {
        const created = await createSessionWorktree(path, tab.id);
        tab.folderPath = created.folderPath;
        tab.worktree = created.worktree;
      }
    }
    this.store.sessions.set(tab.id, this.toPersistedSession(tab));
    this.store.tabs.set(tab.id, tab);
    this.store.openTabIds.push(tab.id);
    this.store.activeTabId = tab.id;

    if (path && !this.store.projects.includes(path)) {
      this.store.projects.push(path);
    }

    if (path) {
      this.agentRuntime.schedule(tab.id);
    }
    await this.persist();
    return tab;
  }

  async openSession(sessionId: TabId): Promise<Tab | undefined> {
    const persisted = this.store.sessions.get(sessionId);
    if (!persisted) return undefined;

    if (this.store.tabs.has(sessionId)) {
      this.store.activeTabId = sessionId;
      await this.persist();
      const existing = this.store.tabs.get(sessionId);
      if (existing?.folderPath && existing.messages.length === 0) {
        const instant = await loadInstantHydration(sessionId, persisted);
        if (instant.messages.length > 0) {
          this.materializeTabFromHydration(persisted, instant, existing.composerValue);
        }
      }
      this.agentRuntime.schedule(sessionId);
      return this.store.tabs.get(sessionId);
    }

    const composerValue = await loadComposerDraft(sessionId);
    const now = Date.now();
    const instant = await loadInstantHydration(sessionId, persisted);
    let tab = { ...this.materializeTabFromHydration(persisted, instant, composerValue), updatedAt: now };
    if (tab.worktree) {
      tab.folderPath = await ensureSessionWorktree(tab);
    }
    this.store.tabs.set(sessionId, tab);
    this.store.openTabIds.push(sessionId);
    this.store.activeTabId = sessionId;

    // Mark as recently active so it sorts to the top in the home view
    this.store.sessions.set(sessionId, { ...persisted, updatedAt: now });

    if (persisted.folderPath && !this.store.projects.includes(persisted.folderPath)) {
      this.store.projects.push(persisted.folderPath);
    }

    if (tab.folderPath) {
      this.agentRuntime.schedule(sessionId);
    }
    await this.persist();
    return this.store.tabs.get(sessionId);
  }

  async closeTab(tabId: TabId): Promise<TabId | undefined> {
    const tab = this.store.tabs.get(tabId);

    this.clearComposerDraftTimer(tabId);

    const hasConversation = tab ? hasUserOrAssistantMessage(tab.messages) : false;
    if (tab && hasConversation) {
      await saveTabHistory(tabId, tab.messages, {
        contextStats: tab.contextStats,
        piSessionId: this.resolvePiSessionId(tabId),
      });
      await saveComposerDraft(tabId, tab.composerValue);
      this.store.sessions.set(tabId, this.toPersistedSession(tab));
    } else {
      await deleteTabHistory(tabId);
      await deleteComposerDraft(tabId);
      this.store.sessions.delete(tabId);
      if (tab?.worktree) {
        await removeSessionWorktree(tab);
      }
    }

    const openIndex = this.store.openTabIds.indexOf(tabId);
    if (openIndex !== -1) {
      this.store.openTabIds.splice(openIndex, 1);
    }

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.stop();
      if (!hasConversation) {
        // Session deleted: remove durable PI session artifacts too.
        bridge.cleanupPersistentState();
      }
      this.bridges.delete(tabId);
    } else if (!hasConversation) {
      cleanupTabAgentDir(tabId);
    }
    rewindManager.dispose(tabId);
    this.store.tabs.delete(tabId);
    if (tab?.folderPath) {
      const stillUsed = this.store.openTabIds.some((id) => this.store.tabs.get(id)?.folderPath === tab.folderPath);
      if (!stillUsed) {
        await stopDevServer(tab.folderPath);
      }
    }

    if (this.store.activeTabId === tabId) {
      this.store.activeTabId = this.store.openTabIds[openIndex - 1] ?? this.store.openTabIds[openIndex] ?? undefined;
    }

    await this.persist();
    return this.store.activeTabId;
  }

  async activateTab(tabId: TabId): Promise<void> {
    if (!this.store.tabs.has(tabId)) return;
    this.store.activeTabId = tabId;
    await this.persist();
  }

  private async resolveStartingFolder(): Promise<string> {
    const state = await loadWindowState();
    return state.lastFolderPath ?? homedir();
  }

  async openProject(folderPath?: string): Promise<{ folderPath?: string }> {
    const path =
      folderPath ??
      (
        await Utils.openFileDialog({
          canChooseDirectory: true,
          canChooseFiles: false,
          startingFolder: await this.resolveStartingFolder(),
        })
      )[0];

    if (!path) return {};

    if (!this.store.projects.includes(path)) {
      this.store.projects.push(path);
    }

    // Always mark this as the last active folder, even without an active tab
    await saveWindowState({ lastFolderPath: path });
    await this.persist();

    return { folderPath: path };
  }

  async closeProject(folderPath: string): Promise<void> {
    this.store.projects = this.store.projects.filter((project) => project !== folderPath);

    const openTabIdsForProject = this.store.openTabIds.filter(
      (tabId) => this.store.sessions.get(tabId)?.folderPath === folderPath,
    );
    for (const tabId of openTabIdsForProject) {
      await this.closeTab(tabId);
    }

    if (this.store.activeTabId && !this.store.tabs.has(this.store.activeTabId)) {
      this.store.activeTabId = this.store.openTabIds[0];
    }

    await this.persist();
  }

  async setTabFolder(tabId: TabId, folderPath?: string): Promise<{ folderPath?: string }> {
    const path =
      folderPath ??
      (
        await Utils.openFileDialog({
          canChooseDirectory: true,
          canChooseFiles: false,
          startingFolder: await this.resolveStartingFolder(),
        })
      )[0];
    if (path && this.store.tabs.has(tabId)) {
      await this.applyFolderToTab(tabId, path);
    }
    return { folderPath: path };
  }

  async selectTabProject(tabId: TabId, folderPath: string): Promise<{ folderPath: string }> {
    if (this.store.tabs.has(tabId)) {
      await this.applyFolderToTab(tabId, folderPath);
    }
    return { folderPath };
  }

  private async applyFolderToTab(tabId: TabId, path: string) {
    const tab = this.store.tabs.get(tabId)!;
    const updated = this.patchTab(tab, {
      folderPath: path,
      projectColor: getProjectColor(path),
    });
    this.store.tabs.set(tabId, updated);
    this.store.sessions.set(tabId, this.toPersistedSession(updated));

    if (!this.store.projects.includes(path)) {
      this.store.projects.push(path);
    }

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.restart(path, { piSessionId: this.resolvePiSessionId(tabId) });
    } else {
      this.agentRuntime.schedule(tabId);
    }

    this.webviewRpc.send.tabFolderChanged({ tabId, folderPath: path });
    await this.persist();
  }

  getTabs(): { tabs: Tab[]; activeTabId?: TabId } {
    return this.store.getTabs();
  }

  getProjectsAndSessions(): { projects: string[]; sessions: PersistedSession[] } {
    return this.store.getProjectsAndSessions();
  }

  getActiveTabId(): TabId | undefined {
    return this.store.getActiveTabId();
  }

  getTab(tabId: TabId): Tab | undefined {
    return this.store.getTab(tabId);
  }

  getOrderedTabIds(): TabId[] {
    return this.store.getOrderedTabIds();
  }

  async activateNextTab(): Promise<TabId | undefined> {
    const ids = this.getOrderedTabIds();
    if (ids.length === 0) return undefined;
    const currentIndex = this.store.activeTabId ? ids.indexOf(this.store.activeTabId) : -1;
    const nextId = ids[Math.min(currentIndex + 1, ids.length - 1)] ?? ids[0];
    await this.activateTab(nextId);
    return nextId;
  }

  async activatePreviousTab(): Promise<TabId | undefined> {
    const ids = this.getOrderedTabIds();
    if (ids.length === 0) return undefined;
    const currentIndex = this.store.activeTabId ? ids.indexOf(this.store.activeTabId) : 1;
    const prevId = ids[Math.max(currentIndex - 1, 0)] ?? ids[0];
    await this.activateTab(prevId);
    return prevId;
  }

  async activateTabAtIndex(index: number): Promise<TabId | undefined> {
    const ids = this.getOrderedTabIds();
    const tabId = ids[index];
    if (!tabId) return undefined;
    await this.activateTab(tabId);
    return tabId;
  }

  async refreshSession(): Promise<void> {
    for (const [tabId, bridge] of this.bridges) {
      const folderPath = this.store.tabs.get(tabId)?.folderPath;
      await bridge.restart(folderPath, { piSessionId: this.resolvePiSessionId(tabId) });
    }
  }

  async sendCommand(tabId: TabId, command: AgentCommand): Promise<AgentResponse> {
    const bridge = this.bridges.get(tabId);
    if (!bridge) {
      throw new Error("Agent is not running for this tab");
    }
    if (command.type === "prompt") {
      this.appendUserMessage(tabId, command.message, command.messageId);
    }
    return bridge.sendCommand(command);
  }

  sendRaw(tabId: TabId, command: AgentCommand): void {
    this.bridges.get(tabId)?.sendRaw(command);
  }

  abortTab(tabId: TabId): void {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });
  }

  async restartTabAgent(tabId: TabId): Promise<void> {
    const tab = this.store.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.restart(tab.folderPath, { piSessionId: this.resolvePiSessionId(tabId) });
    } else {
      await this.startBridge(tabId, tab.folderPath);
    }

    // The agent has restarted successfully — clear the crashed state.
    this.webviewRpc.send.agentStatusChanged({ tabId, state: "running" });

    // Re-sync the model state after restart.
    const updated = this.store.tabs.get(tabId);
    if (updated) {
      this.store.tabs.set(tabId, this.patchTab(updated, {
        connectionState: "running",
        connectionError: undefined,
        connectionStderr: undefined,
      }));
    }
  }

  async revertTab(tabId: TabId, messageIndex: number): Promise<Tab> {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });

    const tab = this.store.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    // Prefer index lookup to preserve compatibility with legacy sessions
    // created before message IDs were synchronized across processes.
    const message = tab.messages[messageIndex];
    if (!message) return tab;

    // Don't re-revert the same point.
    if (tab.revertMessageId === message.id) return tab;

    // Reload checkpoints (pi-rewind in the agent process may have created new ones).
    await rewindManager.reload(tabId);

    // Restore files to the state before this message's changes.
    const userMessageIds = getUserMessageIds(tab.messages);
    const cp = rewindManager.findCheckpointBefore(tabId, message.id, userMessageIds);
    if (cp) {
      void rewindManager.restoreToCheckpoint(tabId, cp).catch((err) => {
        logger.warning("File restore failed during revert", {
          tabId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const updated = this.patchTab(tab, { revertMessageId: message.id });
    this.store.tabs.set(tabId, updated);
    return updated;
  }

  unrevertTab(tabId: TabId): Tab {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });

    const tab = this.store.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    if (!tab.revertMessageId) return tab;

    const updated = this.patchTab(tab, { revertMessageId: undefined });
    this.store.tabs.set(tabId, updated);
    return updated;
  }

  /**
   * Commit a revert by permanently removing all messages at or after the
   * boundary point, then clearing the revert marker.  This matches
   * OpenCode's SessionRevert.commit behaviour.
   */
  commitRevertTab(tabId: TabId, messageIndex: number): Tab {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });

    const tab = this.store.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    // Find the boundary message ID and prune rewind checkpoints after it.
    const boundaryMessage = tab.messages[messageIndex];
    if (boundaryMessage) {
      const userMessageIds = getUserMessageIds(tab.messages);
      void rewindManager.pruneAfterMessage(tabId, boundaryMessage.id, userMessageIds).catch((err) => {
        logger.warning("Failed to prune rewind checkpoints", {
          tabId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Keep only messages before the boundary.
    const messages = tab.messages.slice(0, messageIndex);
    const updated = this.patchTab(tab, { messages, revertMessageId: undefined });
    this.store.tabs.set(tabId, updated);
    return updated;
  }

  private stopWorking(tabId: TabId): void {
    const tab = this.store.tabs.get(tabId);
    if (!tab) return;
    const messages = finalizeStreamingMessages(tab.messages);
    if (messages === tab.messages && !tab.isThinking) return;
    this.store.tabs.set(tabId, this.patchTab(tab, { messages, isThinking: false }));
  }

  getRecentEvents(tabId: TabId): AgentEvent[] {
    // Only return buffered events when the agent is actively working.
    // After a turn completes, the bridge buffer still holds stale events
    // from the finished turn.  If the webview reloads, the polling fallback
    // would replay them and create duplicate messages (the restored tab
    // already contains the final state from a prior save or sync).
    const tab = this.store.tabs.get(tabId);
    if (!tab?.isThinking) return [];
    return this.bridges.get(tabId)?.getRecentEvents() ?? [];
  }

  getStatus(tabId: TabId): AgentStatus {
    const bridge = this.bridges.get(tabId);
    return {
      state: bridge?.state ?? "idle",
      stderr: bridge?.getStderr(),
    };
  }

  async closeAll(): Promise<void> {
    await this.saveAllComposerDrafts();
    for (const bridge of this.bridges.values()) {
      await bridge.stop();
    }
    this.bridges.clear();
  }

  async clearAllTabs(): Promise<void> {
    await this.closeAll();
    for (const tabId of this.composerDraftTimers.keys()) {
      this.clearComposerDraftTimer(tabId);
    }
    this.store.clearAll();
    await this.persist();
  }

  private getOpenTabs(): Tab[] {
    return this.store.getOpenTabs();
  }

  private patchTab(tab: Tab, patch: Partial<Omit<Tab, "id" | "createdAt">>): Tab {
    return this.store.patchTab(tab, patch);
  }

  private hydrateTab(
    persisted: PersistedSession,
    messages: Tab["messages"],
    composerValue = "",
  ): Tab {
    return this.store.hydrateTab(persisted, messages, composerValue);
  }

  private async persist(): Promise<void> {
    await this.store.persist();
  }

  private toPersistedSession(tab: Tab): PersistedSession {
    return this.store.toPersistedSession(tab);
  }

  private async startBridge(tabId: TabId, folderPath?: string) {
    // Initialize git-based rewind for file-level undo support.
    if (folderPath) {
      void rewindManager.init(tabId, folderPath);
    }

    const bridge = new AgentBridge(
      tabId,
      (id, event) => this.webviewRpc.send.agentEvent({ tabId: id, event }),
      (id, state, stderr) => this.webviewRpc.send.agentStatusChanged({ tabId: id, state, stderr }),
      (id, event) => this.handleAgentEvent(id, event),
    );
    this.bridges.set(tabId, bridge);
    try {
      await bridge.start(folderPath, { piSessionId: this.resolvePiSessionId(tabId) });
      await this.capturePiSessionId(tabId);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      this.webviewRpc.send.agentStatusChanged({ tabId, state: "crashed", stderr });
    }
  }

  private makeTab(folderPath: string, title?: string): Tab {
    const now = Date.now();
    const id = createTabId();
    return {
      id,
      title: title ?? (folderPath ? getProjectName(folderPath) : "New session"),
      folderPath,
      projectColor: getProjectColor(folderPath),
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

  private handleAgentEvent(tabId: TabId, event: AgentEvent) {
    const tab = this.store.tabs.get(tabId);
    if (!tab) return;
    const messages = applyAgentEventToMessages(tab.messages, event);
    const patch: Partial<Omit<Tab, "id" | "createdAt">> = { messages };

    if (event.type === "agent_start") {
      patch.isThinking = true;
      // Clear transient connection errors from earlier proxy failures.
      if (tab.connectionError) {
        patch.connectionError = undefined;
      }
    } else if (event.type === "message_end") {
      const eventMessage = event.message as Record<string, unknown> | undefined;
      const stopReason =
        typeof eventMessage?.stopReason === "string" ? eventMessage.stopReason : undefined;
      const errorMessage =
        typeof eventMessage?.errorMessage === "string" ? eventMessage.errorMessage : undefined;
      const isError =
        stopReason === "error" || stopReason === "aborted" || typeof errorMessage === "string";
      if (isError) {
        patch.isThinking = false;
        patch.connectionError =
          errorMessage || `The assistant stopped unexpectedly (${stopReason ?? "error"}).`;
      }
    } else if (event.type === "agent_end" || event.type === "agent_complete") {
      // Only clear isThinking when this event still describes the current turn.
      // If the agent has moved on (e.g. auto-retry), the event is stale and
      // must not downgrade the working state.
      if (isAgentEndCurrent(event, tab.messages)) {
        patch.isThinking = false;
      } else {
        const eventMsgs = (event as { messages?: unknown[] }).messages;
        logger.debug("Ignoring stale agent_end event", {
          tabId,
          eventType: event.type,
          eventMessageCount: Array.isArray(eventMsgs) ? eventMsgs.length : 0,
          tabMessageCount: tab.messages.length,
        });
      }
    } else if (event.type === "agent_error") {
      patch.isThinking = false;
      if (event.error) {
        patch.connectionError = event.error;
      }
    }

    // Track model info on the bun side so the renderer's full sync can
    // restore it even when the herman/models_sync IPC event is lost.
    if (event.type === "herman/models_sync" || event.type === "models_sync") {
      patch.availableModels = event.models;
      patch.currentModel = event.currentModel ?? tab.currentModel;
    }

    if (event.type === "herman/context_report") {
      patch.contextStats = contextStatsFromContextReport(event, messages);
    }

    if (event.type === "herman/provider_pinned" && this.getHermanEnabled()) {
      void import("./persistence.js").then(({ setPinnedProvider }) => {
        setPinnedProvider(tabId, event.modelName, event.providerId);
      });
    }

    this.store.tabs.set(tabId, this.patchTab(tab, patch));
  }

  private async generateTitle(tabId: TabId, userMessage: string) {
    if (!this.getHermanEnabled()) return;

    const tab = this.store.tabs.get(tabId);
    if (!tab) return;

    const token = await this.getToken();
    if (!token) return;

    try {
      const response = await fetch(`${this.serverUrl.replace(/\/$/, "")}/api/agent/title`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userMessage }),
      });

      if (!response.ok) return;

      const data = (await response.json()) as { title?: string };
      const title = data.title?.trim();
      // Ignore empty responses and the server's placeholder fallback so we keep
      // the more useful local placeholder (project name or truncated message).
      if (!title || title === "Untitled session") return;

      const current = this.store.tabs.get(tabId);
      if (!current) return;
      this.store.tabs.set(tabId, this.patchTab(current, { title }));
      this.webviewRpc.send.sessionsChanged({
        sessions: Array.from(this.store.sessions.values()),
      });
      this.persist();
    } catch {
      // Best-effort; ignore failures.
    }
  }

  private appendUserMessage(tabId: TabId, content: string, messageId?: string) {
    const tab = this.store.tabs.get(tabId);
    if (!tab) return;
    const isFirstUserMessage = tab.messages.length === 0;
    const messages: Message[] = [
      ...tab.messages,
      { id: messageId ?? createMessageId(), role: "user", content },
    ];
    const patch: Partial<Omit<Tab, "id" | "createdAt">> = { messages, composerValue: "" };
    if (isFirstUserMessage) {
      patch.title = truncateTitle(content);
    }
    this.store.tabs.set(tabId, this.patchTab(tab, patch));
    void this.clearComposerDraft(tabId);

    // Fire off title generation in parallel with the agent's work; the tab keeps
    // its placeholder title until the server response arrives.
    if (isFirstUserMessage) {
      void this.persist();
      void this.generateTitle(tabId, content);
    }
  }

  async setComposerDraft(tabId: TabId, value: string) {
    const tab = this.store.tabs.get(tabId);
    if (!tab) return;
    this.store.tabs.set(tabId, { ...tab, composerValue: value });
    this.scheduleComposerDraftSave(tabId, value);
  }

  private scheduleComposerDraftSave(tabId: TabId, value: string) {
    const existing = this.composerDraftTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.saveComposerDraftNow(tabId, value);
    }, COMPOSER_DRAFT_SAVE_DEBOUNCE_MS);
    this.composerDraftTimers.set(tabId, timer);
  }

  private clearComposerDraftTimer(tabId: TabId) {
    const existing = this.composerDraftTimers.get(tabId);
    if (existing) {
      clearTimeout(existing);
      this.composerDraftTimers.delete(tabId);
    }
  }

  async saveComposerDraftNow(tabId: TabId, value?: string) {
    this.clearComposerDraftTimer(tabId);
    const draft = value ?? this.store.tabs.get(tabId)?.composerValue ?? "";
    await saveComposerDraft(tabId, draft);
  }

  async clearComposerDraft(tabId: TabId) {
    this.clearComposerDraftTimer(tabId);
    const tab = this.store.tabs.get(tabId);
    if (tab) {
      this.store.tabs.set(tabId, { ...tab, composerValue: "" });
    }
    await deleteComposerDraft(tabId);
  }

  async saveAllComposerDrafts() {
    for (const [tabId, timer] of this.composerDraftTimers) {
      clearTimeout(timer);
      const tab = this.store.tabs.get(tabId);
      if (tab) {
        await saveComposerDraft(tabId, tab.composerValue);
      }
    }
    this.composerDraftTimers.clear();
  }

  async retryTabMessageHydration(tabId: TabId): Promise<TabMessagesHydrated> {
    await this.syncTabFromAgent(tabId);
    const result = this.hydrationResults.get(tabId) ?? {
      status: "failed" as const,
      messages: this.store.tabs.get(tabId)?.messages ?? [],
      error: "Tab snapshot unavailable",
    };
    const payload: TabMessagesHydrated = { tabId, ...result };
    this.webviewRpc.send.tabMessagesHydrated(payload);
    return payload;
  }

  getMessageHydrationResult(tabId: TabId): MessageHydrationResult | undefined {
    return this.hydrationResults.get(tabId);
  }

  emitMessageHydrationForOpenTabs(): void {
    for (const tabId of this.store.openTabIds) {
      this.emitTabSnapshot(tabId);
    }
  }

  private materializeTabFromHydration(
    persisted: PersistedSession,
    instant: Awaited<ReturnType<typeof loadInstantHydration>>,
    composerValue = "",
  ): Tab {
    const tab = this.hydrateTab(persisted, instant.messages, composerValue);
    const patch: Partial<Tab> = {};
    if (instant.contextStats) {
      patch.contextStats = instant.contextStats;
    }
    const updated = Object.keys(patch).length > 0 ? { ...tab, ...patch } : tab;
    this.hydrationResults.set(persisted.id, {
      status: instant.hydrationStatus,
      messages: updated.messages,
      contextStats: updated.contextStats,
    });
    this.store.tabs.set(persisted.id, updated);
    void this.persistTabHistoryCache(persisted.id, updated, instant.piSessionId);
    return updated;
  }

  private async persistTabHistoryCache(
    tabId: TabId,
    tab: Tab,
    piSessionId?: string,
  ): Promise<void> {
    if (tab.messages.length === 0) return;
    await saveTabHistory(tabId, tab.messages, {
      contextStats: tab.contextStats,
      piSessionId: piSessionId ?? this.resolvePiSessionId(tabId),
    });
  }

  private async ensureAgentForTab(tabId: TabId): Promise<void> {
    const tab = this.store.tabs.get(tabId);
    if (!tab?.folderPath) return;

    if (!this.bridges.has(tabId)) {
      await this.startBridge(tabId, tab.folderPath);
    }

    const bridge = this.bridges.get(tabId);
    bridge?.setRendererAttached(true);
    bridge?.flushPendingAttachEvents();

    await this.syncTabFromAgent(tabId);
    this.emitTabSnapshot(tabId);
  }

  private emitTabSnapshot(tabId: TabId): void {
    const tab = this.store.tabs.get(tabId);
    const result = this.hydrationResults.get(tabId);
    if (!tab || !result) return;
    this.webviewRpc.send.tabMessagesHydrated({
      tabId,
      status: result.status,
      messages: tab.messages,
      contextStats: tab.contextStats ?? result.contextStats,
      error: result.error,
    });
  }

  private resolvePiSessionId(tabId: TabId): string | undefined {
    const persisted = this.store.sessions.get(tabId)?.piSessionId;
    return readPiSessionId(tabId, persisted) ?? persisted;
  }

  private async waitForAgentReady(
    bridge: AgentBridge,
    maxAttempts = BACKGROUND_SYNC_READY_ATTEMPTS,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await bridge.sendCommand({ type: "get_state" });
        if (response.success) return true;
      } catch {
        // Agent RPC may not be ready yet.
      }
      if (attempt < maxAttempts) {
        await delay(BACKGROUND_SYNC_RETRY_MS * attempt);
      }
    }
    return false;
  }

  private applyAgentSnapshot(
    tabId: TabId,
    tab: Tab,
    messages: Message[],
    contextStats?: ContextStats,
  ): MessageHydrationResult {
    const status: TabMessageHydrationStatus = messages.length > 0 ? "success" : "empty";
    const updated = this.patchTab(tab, {
      messages,
      ...(contextStats ? { contextStats } : {}),
    });
    this.store.tabs.set(tabId, updated);
    const result: MessageHydrationResult = {
      status,
      messages,
      contextStats: updated.contextStats,
    };
    this.hydrationResults.set(tabId, result);
    void this.persistTabHistoryCache(tabId, updated);
    return result;
  }

  /** Background sync from live agent — UI already painted from pi JSONL. */
  private async syncTabFromAgent(tabId: TabId): Promise<MessageHydrationResult> {
    const bridge = this.bridges.get(tabId);
    const tab = this.store.tabs.get(tabId);
    if (!bridge || !tab) {
      const result: MessageHydrationResult = {
        status: "failed",
        messages: tab?.messages ?? [],
        error: "Tab or agent bridge is not available",
      };
      this.hydrationResults.set(tabId, result);
      return result;
    }

    if (!(await this.waitForAgentReady(bridge))) {
      const result: MessageHydrationResult = {
        status: tab.messages.length > 0 ? "success" : "empty",
        messages: tab.messages,
        contextStats: tab.contextStats,
        error: "Agent not ready for sync",
      };
      this.hydrationResults.set(tabId, result);
      return result;
    }

    try {
      const response = await bridge.sendCommand({ type: "get_messages" });
      if (response.success) {
        const data = response.data as Record<string, unknown> | undefined;
        const agentMessages = data ? extractMessagesFromAgentPayload(data) : undefined;
        if (
          agentMessages &&
          agentMessages.length > 0 &&
          agentMessages.length >= tab.messages.length
        ) {
          const nextMessages = finalizeStreamingMessages(agentMessages);
          return this.applyAgentSnapshot(tabId, tab, nextMessages, tab.contextStats);
        }
      }
    } catch (error) {
      logger.debug("Background agent sync failed", {
        tabId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const result: MessageHydrationResult = {
      status: tab.messages.length > 0 ? "success" : "empty",
      messages: tab.messages,
      contextStats: tab.contextStats,
    };
    this.hydrationResults.set(tabId, result);
    if (tab.messages.length > 0) {
      void this.persistTabHistoryCache(tabId, tab);
    }
    return result;
  }

  async waitForAgentRuntime(): Promise<void> {
    await this.agentRuntime.waitForIdle();
  }

  private async capturePiSessionId(tabId: TabId): Promise<void> {
    const session = this.store.sessions.get(tabId);
    if (!session) return;

    const bridge = this.bridges.get(tabId);
    if (!bridge) return;

    let observed: string | undefined;
    try {
      const response = await bridge.sendCommand({ type: "get_state" });
      if (response.success) {
        const data = response.data as Record<string, unknown> | undefined;
        if (data && typeof data.sessionId === "string") {
          observed = data.sessionId;
        }
      }
    } catch {
      return;
    }

    if (!observed) {
      if (!session.piSessionId) {
        observed = readPiSessionId(tabId);
      } else {
        return;
      }
    }

    const observedFile = resolvePiSessionFile(tabId, observed);
    if (!observedFile) {
      return;
    }

    if (session.piSessionId && session.piSessionId !== observed) {
      const persistedFile = resolvePiSessionFile(tabId, session.piSessionId);
      if (persistedFile) return;
    }

    if (!observed || session.piSessionId === observed) return;

    this.store.sessions.set(tabId, { ...session, piSessionId: observed, updatedAt: Date.now() });
    await this.persist();
    this.webviewRpc.send.sessionsChanged({
      sessions: Array.from(this.store.sessions.values()),
    });
  }
}
