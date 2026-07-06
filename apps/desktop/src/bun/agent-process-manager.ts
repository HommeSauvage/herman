import { homedir } from "node:os";

import { getLogger } from "@logtape/logtape";
import { Utils } from "electrobun/bun";

import type { AgentCommand, AgentEvent, AgentResponse } from "../shared/agent-protocol.js";
import {
  applyAgentEventToMessages,
  createMessageId,
  finalizeStreamingMessages,
  isAgentEndCurrent,
} from "../shared/apply-agent-event.js";
import type { AgentStatus, Message, Tab, TabId } from "../shared/rpc.js";
import {
  createTabId,
  getProjectColor,
  getProjectName,
  hasUserOrAssistantMessage,
  truncateTitle,
} from "../shared/tab-utils.js";
import { AgentBridge, type AgentBridgeState } from "./agent-bridge.js";
import { deleteComposerDraft, loadComposerDraft, saveComposerDraft } from "./composer-drafts.js";
import { rewindManager, getUserMessageIds } from "./rewind-manager.js";
import { deleteTabHistory, loadTabHistory, saveTabHistory } from "./tab-history.js";
import { loadWindowState, saveWindowState, type PersistedSession } from "./window-state.js";

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

const HISTORY_SAVE_DEBOUNCE_MS = 5000;
const COMPOSER_DRAFT_SAVE_DEBOUNCE_MS = 1000;

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
  };
};

export type AgentProcessManagerOptions = {
  webviewRpc: WebviewSender;
  serverUrl: string;
  getToken: () => Promise<string | undefined>;
  getHermanEnabled: () => boolean;
};

export class AgentProcessManager {
  private bridges = new Map<TabId, AgentBridge>();
  private tabs = new Map<TabId, Tab>();
  private sessions = new Map<TabId, PersistedSession>();
  private webviewRpc: WebviewSender;
  private getToken: () => Promise<string | undefined>;
  private getHermanEnabled: () => boolean;
  private serverUrl: string;
  private projects: string[] = [];
  private openTabIds: TabId[] = [];
  private activeTabId?: TabId;
  private saveTimers = new Map<TabId, ReturnType<typeof setTimeout>>();
  private composerDraftTimers = new Map<TabId, ReturnType<typeof setTimeout>>();

  constructor(options: AgentProcessManagerOptions) {
    this.webviewRpc = options.webviewRpc;
    this.serverUrl = options.serverUrl;
    this.getToken = options.getToken;
    this.getHermanEnabled = options.getHermanEnabled;
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
      this.projects = state.projects ?? [];
      this.openTabIds = openTabIds;
      this.activeTabId = state.activeTabId;

      for (const persisted of persistedSessions) {
        this.sessions.set(persisted.id, persisted);
        if (!persisted.folderPath || this.projects.includes(persisted.folderPath)) continue;
        if (openTabIds.includes(persisted.id)) {
          this.projects.push(persisted.folderPath);
        }
      }

      for (const tabId of openTabIds) {
        const persisted = this.sessions.get(tabId);
        if (!persisted) continue;
        const [messages, composerValue] = await Promise.all([
          loadTabHistory(tabId),
          loadComposerDraft(tabId),
        ]);
        const tab = this.hydrateTab(persisted, messages, composerValue);
        this.tabs.set(tabId, tab);
        if (tab.folderPath) {
          await this.startBridge(tabId, tab.folderPath);
        }
      }

      if (this.activeTabId && !this.tabs.has(this.activeTabId)) {
        this.activeTabId = this.openTabIds[0];
      }

      await this.persist();

      return {
        tabs: this.getOpenTabs(),
        activeTabId: this.activeTabId,
        projects: [...this.projects],
        sessions: [...this.sessions.values()],
      };
    } finally {
      nextRestore.resolve();
      previousRestore.resolve();
    }
  }

  async createTab(folderPath?: string, title?: string): Promise<Tab> {
    const inheritedFolder = this.activeTabId
      ? this.tabs.get(this.activeTabId)?.folderPath
      : undefined;
    const state = await loadWindowState();
    const lastFolder = state.lastFolderPath;
    const path = folderPath ?? inheritedFolder ?? lastFolder ?? "";
    const tab = this.makeTab(path, title);
    this.sessions.set(tab.id, this.toPersistedSession(tab));
    this.tabs.set(tab.id, tab);
    this.openTabIds.push(tab.id);
    this.activeTabId = tab.id;

    if (path && !this.projects.includes(path)) {
      this.projects.push(path);
    }

    if (path) {
      await this.startBridge(tab.id, tab.folderPath);
    }
    await this.persist();
    return tab;
  }

  async openSession(sessionId: TabId): Promise<Tab | undefined> {
    const persisted = this.sessions.get(sessionId);
    if (!persisted) return undefined;

    if (this.tabs.has(sessionId)) {
      this.activeTabId = sessionId;
      await this.persist();
      return this.tabs.get(sessionId);
    }

    const [messages, composerValue] = await Promise.all([
      loadTabHistory(sessionId),
      loadComposerDraft(sessionId),
    ]);
    const now = Date.now();
    const tab = { ...this.hydrateTab(persisted, messages, composerValue), updatedAt: now };
    this.tabs.set(sessionId, tab);
    this.openTabIds.push(sessionId);
    this.activeTabId = sessionId;

    // Mark as recently active so it sorts to the top in the home view
    this.sessions.set(sessionId, { ...persisted, updatedAt: now });

    if (persisted.folderPath && !this.projects.includes(persisted.folderPath)) {
      this.projects.push(persisted.folderPath);
    }

    if (tab.folderPath) {
      await this.startBridge(sessionId, tab.folderPath);
    }
    await this.persist();
    return tab;
  }

  async closeTab(tabId: TabId): Promise<TabId | undefined> {
    const tab = this.tabs.get(tabId);

    this.clearSaveTimer(tabId);
    this.clearComposerDraftTimer(tabId);

    if (tab && hasUserOrAssistantMessage(tab.messages)) {
      await saveTabHistory(tabId, tab.messages);
      await saveComposerDraft(tabId, tab.composerValue);
      this.sessions.set(tabId, this.toPersistedSession(tab));
    } else {
      await deleteTabHistory(tabId);
      await deleteComposerDraft(tabId);
      this.sessions.delete(tabId);
    }

    const openIndex = this.openTabIds.indexOf(tabId);
    if (openIndex !== -1) {
      this.openTabIds.splice(openIndex, 1);
    }

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.stop();
      this.bridges.delete(tabId);
    }
    rewindManager.dispose(tabId);
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      this.activeTabId = this.openTabIds[openIndex - 1] ?? this.openTabIds[openIndex] ?? undefined;
    }

    await this.persist();
    return this.activeTabId;
  }

  async activateTab(tabId: TabId): Promise<void> {
    if (!this.tabs.has(tabId)) return;
    this.activeTabId = tabId;
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

    if (!this.projects.includes(path)) {
      this.projects.push(path);
    }

    // Always mark this as the last active folder, even without an active tab
    await saveWindowState({ lastFolderPath: path });
    await this.persist();

    return { folderPath: path };
  }

  async closeProject(folderPath: string): Promise<void> {
    this.projects = this.projects.filter((project) => project !== folderPath);

    const openTabIdsForProject = this.openTabIds.filter(
      (tabId) => this.sessions.get(tabId)?.folderPath === folderPath,
    );
    for (const tabId of openTabIdsForProject) {
      await this.closeTab(tabId);
    }

    if (this.activeTabId && !this.tabs.has(this.activeTabId)) {
      this.activeTabId = this.openTabIds[0];
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
    if (path && this.tabs.has(tabId)) {
      await this.applyFolderToTab(tabId, path);
    }
    return { folderPath: path };
  }

  async selectTabProject(tabId: TabId, folderPath: string): Promise<{ folderPath: string }> {
    if (this.tabs.has(tabId)) {
      await this.applyFolderToTab(tabId, folderPath);
    }
    return { folderPath };
  }

  private async applyFolderToTab(tabId: TabId, path: string) {
    const tab = this.tabs.get(tabId)!;
    const updated = this.patchTab(tab, {
      folderPath: path,
      projectColor: getProjectColor(path),
    });
    this.tabs.set(tabId, updated);
    this.sessions.set(tabId, this.toPersistedSession(updated));

    if (!this.projects.includes(path)) {
      this.projects.push(path);
    }

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.restart(path);
    } else {
      await this.startBridge(tabId, path);
    }

    this.webviewRpc.send.tabFolderChanged({ tabId, folderPath: path });
    await this.persist();
  }

  getTabs(): { tabs: Tab[]; activeTabId?: TabId } {
    return { tabs: this.getOpenTabs(), activeTabId: this.activeTabId };
  }

  getProjectsAndSessions(): { projects: string[]; sessions: PersistedSession[] } {
    return {
      projects: [...this.projects],
      sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  getActiveTabId(): TabId | undefined {
    return this.activeTabId;
  }

  getOrderedTabIds(): TabId[] {
    return [...this.openTabIds];
  }

  async activateNextTab(): Promise<TabId | undefined> {
    const ids = this.getOrderedTabIds();
    if (ids.length === 0) return undefined;
    const currentIndex = this.activeTabId ? ids.indexOf(this.activeTabId) : -1;
    const nextId = ids[Math.min(currentIndex + 1, ids.length - 1)] ?? ids[0];
    await this.activateTab(nextId);
    return nextId;
  }

  async activatePreviousTab(): Promise<TabId | undefined> {
    const ids = this.getOrderedTabIds();
    if (ids.length === 0) return undefined;
    const currentIndex = this.activeTabId ? ids.indexOf(this.activeTabId) : 1;
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
      const folderPath = this.tabs.get(tabId)?.folderPath;
      await bridge.restart(folderPath);
    }
  }

  async sendCommand(tabId: TabId, command: AgentCommand): Promise<AgentResponse> {
    const bridge = this.bridges.get(tabId);
    if (!bridge) {
      throw new Error("Agent is not running for this tab");
    }
    if (command.type === "prompt") {
      this.appendUserMessage(tabId, command.message);
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
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.restart(tab.folderPath);
    } else {
      await this.startBridge(tabId, tab.folderPath);
    }

    // The agent has restarted successfully — clear the crashed state.
    this.webviewRpc.send.agentStatusChanged({ tabId, state: "running" });

    // Re-sync the model state after restart.
    const updated = this.tabs.get(tabId);
    if (updated) {
      this.tabs.set(tabId, this.patchTab(updated, {
        connectionState: "running",
        connectionError: undefined,
        connectionStderr: undefined,
      }));
      this.scheduleHistorySave(tabId);
    }
  }

  async revertTab(tabId: TabId, messageIndex: number): Promise<Tab> {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });

    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    // Use index rather than ID — renderer and main process have separate
    // message ID counters so IDs may not match across the RPC boundary.
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
    this.tabs.set(tabId, updated);
    this.scheduleHistorySave(tabId);
    return updated;
  }

  unrevertTab(tabId: TabId): Tab {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });

    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    if (!tab.revertMessageId) return tab;

    const updated = this.patchTab(tab, { revertMessageId: undefined });
    this.tabs.set(tabId, updated);
    this.scheduleHistorySave(tabId);
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

    const tab = this.tabs.get(tabId);
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
    this.tabs.set(tabId, updated);
    this.scheduleHistorySave(tabId);
    return updated;
  }

  private stopWorking(tabId: TabId): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const messages = finalizeStreamingMessages(tab.messages);
    if (messages === tab.messages && !tab.isThinking) return;
    this.tabs.set(tabId, this.patchTab(tab, { messages, isThinking: false }));
    this.scheduleHistorySave(tabId);
  }

  getRecentEvents(tabId: TabId): AgentEvent[] {
    // Only return buffered events when the agent is actively working.
    // After a turn completes, the bridge buffer still holds stale events
    // from the finished turn.  If the webview reloads, the polling fallback
    // would replay them and create duplicate messages (the restored tab
    // already contains the final state from a prior save or sync).
    const tab = this.tabs.get(tabId);
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
    await this.saveAllTabHistory();
    for (const bridge of this.bridges.values()) {
      await bridge.stop();
    }
    this.bridges.clear();
  }

  async clearAllTabs(): Promise<void> {
    await this.closeAll();
    for (const tabId of this.saveTimers.keys()) {
      this.clearSaveTimer(tabId);
    }
    for (const tabId of this.composerDraftTimers.keys()) {
      this.clearComposerDraftTimer(tabId);
    }
    this.tabs.clear();
    this.openTabIds = [];
    this.activeTabId = undefined;
    await this.persist();
  }

  private getOpenTabs(): Tab[] {
    return this.openTabIds
      .map((tabId) => this.tabs.get(tabId))
      .filter((tab): tab is Tab => tab !== undefined);
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
      await bridge.start(folderPath);
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
      availableModels: [],
      connectionState: "idle",
      createdAt: now,
      updatedAt: now,
      composerValue: "",
      queuedMessages: [],
    };
  }

  private hydrateTab(
    persisted: PersistedSession,
    messages: Tab["messages"],
    composerValue = "",
  ): Tab {
    return {
      ...persisted,
      // Recalculate the project color on restore so existing sessions pick up
      // new colors when the palette changes.
      projectColor: getProjectColor(persisted.folderPath),
      // A history file may have been saved mid-stream (crash, force-quit, or
      // a stop that raced the debounced save). Always reload in a settled
      // state so the UI doesn't show a stuck Working indicator.
      messages: finalizeStreamingMessages(messages),
      isThinking: false,
      availableModels: [],
      connectionState: "idle",
      composerValue,
      queuedMessages: [],
      revertMessageId: persisted.revertMessageId,
    };
  }

  private patchTab(tab: Tab, patch: Partial<Omit<Tab, "id" | "createdAt">>): Tab {
    const updated = { ...tab, ...patch, updatedAt: Date.now() };
    this.sessions.set(tab.id, this.toPersistedSession(updated));
    return updated;
  }

  private handleAgentEvent(tabId: TabId, event: AgentEvent) {
    const tab = this.tabs.get(tabId);
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

    if (event.type === "herman/provider_pinned" && this.getHermanEnabled()) {
      void import("./persistence.js").then(({ setPinnedProvider }) => {
        setPinnedProvider(tabId, event.modelName, event.providerId);
      });
    }

    this.tabs.set(tabId, this.patchTab(tab, patch));
    this.scheduleHistorySave(tabId);
  }

  private async generateTitle(tabId: TabId, userMessage: string) {
    if (!this.getHermanEnabled()) return;

    const tab = this.tabs.get(tabId);
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

      const current = this.tabs.get(tabId);
      if (!current) return;
      this.tabs.set(tabId, this.patchTab(current, { title }));
      this.webviewRpc.send.sessionsChanged({
        sessions: Array.from(this.sessions.values()),
      });
      this.persist();
    } catch {
      // Best-effort; ignore failures.
    }
  }

  private appendUserMessage(tabId: TabId, content: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const isFirstUserMessage = tab.messages.length === 0;
    const messages: Message[] = [...tab.messages, { id: createMessageId(), role: "user", content }];
    const patch: Partial<Omit<Tab, "id" | "createdAt">> = { messages, composerValue: "" };
    if (isFirstUserMessage) {
      patch.title = truncateTitle(content);
    }
    this.tabs.set(tabId, this.patchTab(tab, patch));
    this.scheduleHistorySave(tabId);
    void this.clearComposerDraft(tabId);

    // Fire off title generation in parallel with the agent's work; the tab keeps
    // its placeholder title until the server response arrives.
    if (isFirstUserMessage) {
      void this.persist();
      void this.generateTitle(tabId, content);
    }
  }

  private scheduleHistorySave(tabId: TabId) {
    const existing = this.saveTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.saveTabHistoryNow(tabId);
    }, HISTORY_SAVE_DEBOUNCE_MS);
    this.saveTimers.set(tabId, timer);
  }

  private clearSaveTimer(tabId: TabId) {
    const existing = this.saveTimers.get(tabId);
    if (existing) {
      clearTimeout(existing);
      this.saveTimers.delete(tabId);
    }
  }

  async saveTabHistoryNow(tabId: TabId) {
    this.clearSaveTimer(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    await saveTabHistory(tabId, tab.messages);
  }

  async saveAllTabHistory() {
    for (const tabId of this.tabs.keys()) {
      await this.saveTabHistoryNow(tabId);
    }
  }

  async setComposerDraft(tabId: TabId, value: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.set(tabId, { ...tab, composerValue: value });
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
    const draft = value ?? this.tabs.get(tabId)?.composerValue ?? "";
    await saveComposerDraft(tabId, draft);
  }

  async clearComposerDraft(tabId: TabId) {
    this.clearComposerDraftTimer(tabId);
    const tab = this.tabs.get(tabId);
    if (tab) {
      this.tabs.set(tabId, { ...tab, composerValue: "" });
    }
    await deleteComposerDraft(tabId);
  }

  async saveAllComposerDrafts() {
    for (const [tabId, timer] of this.composerDraftTimers) {
      clearTimeout(timer);
      const tab = this.tabs.get(tabId);
      if (tab) {
        await saveComposerDraft(tabId, tab.composerValue);
      }
    }
    this.composerDraftTimers.clear();
  }

  private async persist() {
    const sessions = Array.from(this.sessions.values()).map((session) => {
      const openTab = this.tabs.get(session.id);
      return openTab ? this.toPersistedSession(openTab) : session;
    });
    const activeFolder = this.activeTabId
      ? (this.tabs.get(this.activeTabId)?.folderPath ??
        this.sessions.get(this.activeTabId)?.folderPath)
      : undefined;

    // Only update lastFolderPath when we have a valid folder — never clear it
    const state: Parameters<typeof saveWindowState>[0] = {
      projects: this.projects,
      sessions,
      openTabIds: this.openTabIds,
      activeTabId: this.activeTabId,
    };
    if (activeFolder) {
      state.lastFolderPath = activeFolder;
    }
    await saveWindowState(state);
  }

  private toPersistedSession(tab: Tab): PersistedSession {
    return {
      id: tab.id,
      title: tab.title,
      folderPath: tab.folderPath,
      projectColor: tab.projectColor,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      revertMessageId: tab.revertMessageId,
    };
  }
}
