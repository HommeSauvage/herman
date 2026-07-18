import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { getLogger } from "@logtape/logtape";
import { BrowserView, Utils } from "electrobun/bun";
import { HERMAN_REFRESH_MODELS_MESSAGE } from "@herman/rpc/agent";

import type { AgentCommand, AgentEvent, AgentResponse } from "../shared/agent-protocol.js";
import {
  applyAgentEventToMessages,
  createMessageId,
  finalizeStreamingMessages,
  isAgentEndCurrent,
  syncMessageCounter,
} from "../shared/apply-agent-event.js";
import type { AgentStatus, ContextStats, Message, ModelMetadata, SessionWorktree, Tab, TabId, TabMessagesHydrated, TabMessageHydrationStatus } from "../shared/rpc.js";
import {
  modelApplyFingerprint,
  normalizeModelId,
  parseModelRef,
  shouldApplyDesiredModel,
} from "../shared/model-selection.js";
import {
  createTabId,
  getProjectColor,
  getProjectName,
  hasUserOrAssistantMessage,
  truncateTitle,
} from "../shared/tab-utils.js";
import { AgentBridge, type AgentBridgeState } from "./agent-bridge.js";
import { AgentRuntime } from "./agent-runtime.js";
import { deleteComposerDraft, loadComposerDraft, saveComposerDraft } from "./composer-drafts.js";
import {
  extractMessagesFromAgentPayload,
} from "./pi-messages.js";
import { contextStatsFromContextReport, readPiSessionModel as readPiSessionModelFromFile } from "./session-snapshot.js";
import { getDevServerStatus, stopDevServer } from "./preview-server.js";
import { rewindManager, getUserMessageIds, readPiSessionId, RevertConflictError } from "./rewind-manager.js";
import { resolveSessionInfoHostReply } from "./session-info-host.js";
import { deleteTabHistory, saveTabHistory } from "./tab-history.js";
import { loadInstantHydration } from "./tab-message-hydration.js";
import { resolvePiSessionFile, deletePiSessionFile } from "./pi-session.js";
import {
  buildSessionSyncPrompt,
  createSessionWorktree,
  ensureSessionWorktree,
  getSessionChanges,
  removeSessionWorktree,
  resolveProjectRoot,
} from "./worktree.js";
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
const SESSION_SYNC_TIMEOUT_MS = 180_000;
/** Max set_model attempts per (desired model, registry snapshot) pair. */
const MAX_MODEL_APPLY_ATTEMPTS = 3;

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
    tabFolderChanged: (payload: { tabId: TabId; folderPath?: string; projectRoot?: string; worktree?: SessionWorktree; worktreeStatus?: "pending" | "ready" | "error"; error?: string }) => void;
    sessionsChanged: (payload: { sessions: PersistedSession[] }) => void;
    tabMessagesHydrated: (payload: TabMessagesHydrated) => void;
    tabModelChanged: (payload: { tabId: TabId; currentModel?: string }) => void;
  };
};

export type AgentProcessManagerOptions = {
  webviewRpc: WebviewSender;
  serverUrl: string;
  getToken: () => Promise<string | undefined>;
  getHermanEnabled: () => boolean;
  getMode: () => "rookie" | "normal" | undefined;
  /** Initial model for fresh tabs (validated against the catalog by the caller). */
  getNewTabModel?: () => string | undefined;
  /** Called when the user explicitly selects a model in a tab (records last-used). */
  onExplicitModelSelection?: (modelId: string) => void;
  /** Called with every agent models_sync so the shared catalog can merge custom providers. */
  onAgentModelsSync?: (models: string[], metadata?: Record<string, ModelMetadata>) => void;
};

export class AgentProcessManager {
  private store = new TabSessionStore();
  private bridges = new Map<TabId, AgentBridge>();
  private composerDraftTimers = new Map<TabId, ReturnType<typeof setTimeout>>();
  private hydrationResults = new Map<TabId, MessageHydrationResult>();
  private turnWaiters = new Map<TabId, Set<() => void>>();
  private agentRuntime: AgentRuntime;
  private webviewRpc: WebviewSender;
  private getToken: () => Promise<string | undefined>;
  private getHermanEnabled: () => boolean;
  private getMode: () => "rookie" | "normal" | undefined;
  private getNewTabModel?: () => string | undefined;
  private onExplicitModelSelection?: (modelId: string) => void;
  private onAgentModelsSync?: (models: string[], metadata?: Record<string, ModelMetadata>) => void;
  private serverUrl: string;
  /** set_model retry budget per tab, scoped by (desired model, registry snapshot). */
  private modelApplyAttempts = new Map<TabId, { fingerprint: string; attempts: number }>();
  /** Last model each agent confirmed via models_sync (or a successful set_model). */
  private agentConfirmedModels = new Map<TabId, string>();

  constructor(options: AgentProcessManagerOptions) {
    this.webviewRpc = options.webviewRpc;
    this.serverUrl = options.serverUrl;
    this.getToken = options.getToken;
    this.getHermanEnabled = options.getHermanEnabled;
    this.getMode = options.getMode;
    this.getNewTabModel = options.getNewTabModel;
    this.onExplicitModelSelection = options.onExplicitModelSelection;
    this.onAgentModelsSync = options.onAgentModelsSync;
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
      this.store.projects = [];
      this.store.openTabIds = openTabIds;
      this.store.activeTabId = state.activeTabId;

      for (const persisted of persistedSessions) {
        this.store.sessions.set(persisted.id, persisted);
      }

      // Compute project roots for all sessions: prefer worktree.mainFolderPath
      // (already normalized to git root), then resolve from folderPath.
      for (const persisted of persistedSessions) {
        if (!persisted.folderPath) continue;
        const root =
          persisted.projectRoot ??
          persisted.worktree?.mainFolderPath ??
          await resolveProjectRoot(persisted.folderPath);
        persisted.projectRoot = root;
        if (root && !this.store.projects.includes(root)) {
          this.store.projects.push(root);
        }
      }

      // Build project list from legacy state, skipping stale worktree paths.
      for (const legacyProject of (state.projects ?? [])) {
        if (legacyProject.includes("/.worktrees/")) continue;
        const root = await resolveProjectRoot(legacyProject);
        if (root && !this.store.projects.includes(root)) {
          this.store.projects.push(root);
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
        if (!tab.folderPath) continue;
        if (existsSync(tab.folderPath)) {
          agentTabIds.push(tabId);
          continue;
        }
        // The project folder was moved or deleted while the app was closed.
        // Spawning with a missing cwd fails with a misleading posix_spawn
        // ENOENT against the binary path — skip the spawn and surface the
        // tab with a clear, actionable error instead.
        logger.warning("Restored tab project folder no longer exists; skipping agent start", {
          tabId,
          folderPath: tab.folderPath,
        });
        // Ephemeral, in-memory only — re-evaluated on every restore.
        this.store.tabs.set(tabId, {
          ...tab,
          connectionError: `The project folder for this session no longer exists: ${tab.folderPath}`,
        });
      }

      this.agentRuntime.scheduleMany(agentTabIds);

      if (this.store.activeTabId && !this.store.tabs.has(this.store.activeTabId)) {
        this.store.activeTabId = this.store.openTabIds[0];
      }

      await this.persist();

      const tabs = this.getOpenTabs();
      logger.info("Restored agent sessions", {
        tabCount: tabs.length,
        activeTabId: this.store.activeTabId,
        projectCount: this.store.projects.length,
        sessionCount: this.store.sessions.size,
      });

      return {
        tabs,
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
    const state = await loadWindowState();
    const lastFolder = state.lastFolderPath;
    const inheritedTab = this.store.activeTabId
      ? this.store.tabs.get(this.store.activeTabId)
      : undefined;
    const rawPath = folderPath ?? inheritedTab?.folderPath ?? lastFolder ?? "";
    const tab = this.makeTab(rawPath, title, this.newTabModel());
    const mode = this.getMode();
    const projectRoot = rawPath ? await resolveProjectRoot(rawPath) : "";
    if (projectRoot) {
      tab.projectRoot = projectRoot;
      tab.projectColor = getProjectColor(projectRoot);
      if (!title) {
        tab.title = getProjectName(projectRoot);
      }
    }
    const needsWorktree = !!(mode === "rookie" && projectRoot && (await isGitRepo(projectRoot)));
    if (needsWorktree) {
      // Return the tab immediately with the project root as a temporary folder.
      // The worktree is created in the background so the UI feels instant.
      tab.folderPath = projectRoot;
      tab.worktreeStatus = "pending";
    }

    await this.registerAndOpenTab(tab, this.toPersistedSession(tab), projectRoot, needsWorktree);
    logger.debug("Created tab", { tabId: tab.id, folderPath: tab.folderPath, projectRoot, needsWorktree });
    return tab;
  }

  /**
   * Open a finished wizard project as a real tab with a **fresh** pi session.
   * Coding and QA already ran on the main project tree; open that path directly
   * (no session worktree) so uncommitted wizard changes remain visible.
   * Do not resume wizard history or send a post-handoff `/goal`.
   */
  async adoptWizardSession(projectPath: string, wizardSessionId: string): Promise<Tab> {
    const projectRoot = await resolveProjectRoot(projectPath);
    const tab = this.makeTab(projectRoot, undefined, this.newTabModel());
    tab.projectRoot = projectRoot;
    tab.folderPath = projectRoot;
    tab.projectColor = getProjectColor(projectRoot);
    tab.title = getProjectName(projectRoot);
    // Intentionally no createSessionWorktree: wizard coding/QA wrote into the
    // main clone; a fresh worktree from HEAD would drop those changes.
    await this.registerAndOpenTab(tab, this.toPersistedSession(tab), projectRoot, false);
    logger.info("Opened wizard project as fresh tab", {
      tabId: tab.id,
      projectPath,
      wizardSessionId,
    });
    return tab;
  }

  async openSession(sessionId: TabId): Promise<Tab | undefined> {
    const persisted = this.store.sessions.get(sessionId);
    if (!persisted) return undefined;

    // Ensure projectRoot is populated for legacy sessions.
    if (!persisted.projectRoot && persisted.folderPath) {
      persisted.projectRoot = await resolveProjectRoot(persisted.folderPath);
    }

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
    const mode = this.getMode();

    // Determine whether we need a background worktree creation.
    let needsWorktree = false;
    if (mode === "rookie" && tab.folderPath && (await isGitRepo(tab.projectRoot))) {
      if (!tab.worktree) {
        needsWorktree = true;
        tab.folderPath = tab.projectRoot;
        tab.worktreeStatus = "pending";
      } else {
        // Worktree already exists (or folder is still on disk) — fast path.
        tab.folderPath = await ensureSessionWorktree(tab);
      }
    } else if (tab.worktree) {
      tab.folderPath = await ensureSessionWorktree(tab);
    }

    await this.registerAndOpenTab(tab, { ...persisted, updatedAt: now }, tab.projectRoot, needsWorktree);
    return this.store.tabs.get(sessionId);
  }

  /**
   * Open a native pi session by UUID as a new tab, resuming that conversation.
   * The session JSONL already lives in the shared sessions dir.
   */
  async openPiSession(folderPath: string, piSessionId: string): Promise<Tab> {
    const projectRoot = await resolveProjectRoot(folderPath);
    // Prefer the model the pi session was actually using (from its JSONL) over
    // the generic new-tab model — reopening a session should keep its model.
    const sessionModel = this.readPiSessionModel(piSessionId);
    const tab = this.makeTab(projectRoot, undefined, sessionModel ?? this.newTabModel());
    tab.projectRoot = projectRoot;
    tab.projectColor = getProjectColor(projectRoot);
    tab.title = getProjectName(projectRoot);
    const mode = this.getMode();

    const needsWorktree = mode === "rookie" && (await isGitRepo(projectRoot));
    if (needsWorktree) {
      tab.folderPath = projectRoot;
      tab.worktreeStatus = "pending";
    }

    const persisted = { ...this.toPersistedSession(tab), piSessionId, updatedAt: Date.now() };
    await this.registerAndOpenTab(tab, persisted, projectRoot, needsWorktree);
    logger.info("Opened pi session as tab", { tabId: tab.id, folderPath, projectRoot, piSessionId, needsWorktree });
    return tab;
  }

  async closeTab(tabId: TabId): Promise<TabId | undefined> {
    logger.debug("Closing tab in manager", { tabId });
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
      deletePiSessionFile(this.resolvePiSessionId(tabId));
    }
    rewindManager.dispose(tabId);
    this.store.tabs.delete(tabId);
    if (tab?.folderPath) {
      const stillUsed = this.store.openTabIds.some((id) => this.store.tabs.get(id)?.folderPath === tab.folderPath);
      if (!stillUsed) {
        // Defer preview server shutdown so the renderer receives tabClosed
        // and unmounts the webview (hiding the native overlay) before the
        // server is killed.  Otherwise the webview flashes an error page.
        const folderPath = tab.folderPath;
        void stopDevServer(folderPath).catch((err) =>
          logger.warning("Failed to stop preview server during tab close", {
            folderPath,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    if (this.store.activeTabId === tabId) {
      this.store.activeTabId = this.store.openTabIds[openIndex - 1] ?? this.store.openTabIds[openIndex] ?? undefined;
    }

    await this.persist();
    return this.store.activeTabId;
  }

  async activateTab(tabId: TabId): Promise<void> {
    logger.debug("Activating tab in manager", { tabId });
    if (!this.store.tabs.has(tabId)) return;
    this.store.activeTabId = tabId;
    await this.persist();
  }

  private async resolveStartingFolder(): Promise<string> {
    const state = await loadWindowState();
    return state.lastFolderPath ?? homedir();
  }

  async openProject(folderPath?: string): Promise<{ folderPath?: string; projectRoot?: string }> {
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

    const projectRoot = await resolveProjectRoot(path);
    if (!this.store.projects.includes(projectRoot)) {
      this.store.projects.push(projectRoot);
    }

    // Always mark this as the last active folder, even without an active tab
    await saveWindowState({ lastFolderPath: path });
    await this.persist();

    return { folderPath: path, projectRoot };
  }

  async closeProject(folderPath: string): Promise<void> {
    const projectRoot = await resolveProjectRoot(folderPath);
    this.store.projects = this.store.projects.filter((project) => project !== projectRoot);

    const openTabIdsForProject = this.store.openTabIds.filter(
      (tabId) => this.store.sessions.get(tabId)?.projectRoot === projectRoot,
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
    const projectRoot = await resolveProjectRoot(path);
    const updated = this.patchTab(tab, {
      folderPath: path,
      projectRoot,
      projectColor: getProjectColor(projectRoot),
    });
    this.store.tabs.set(tabId, updated);
    this.store.sessions.set(tabId, this.toPersistedSession(updated));

    if (projectRoot && !this.store.projects.includes(projectRoot)) {
      this.store.projects.push(projectRoot);
    }

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.restart(path, { piSessionId: this.resolvePiSessionId(tabId), mode: this.getMode() });
    } else {
      this.agentRuntime.schedule(tabId);
    }

    this.webviewRpc.send.tabFolderChanged({ tabId, folderPath: path, projectRoot });
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
      await bridge.restart(folderPath, { piSessionId: this.resolvePiSessionId(tabId), mode: this.getMode() });
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

  async syncSessionToMain(
    tabId: TabId,
  ): Promise<{ status: "applied" | "error"; error?: string }> {
    const tab = this.store.tabs.get(tabId);
    if (!tab?.worktree) {
      return { status: "error", error: "No draft session found" };
    }

    const before = await getSessionChanges(tab);
    if (!before.canApply) {
      return { status: "applied" };
    }

    if (tab.isThinking) {
      return {
        status: "error",
        error: "Wait for the assistant to finish its current task first.",
      };
    }

    let bridge = this.bridges.get(tabId);
    if (!bridge || bridge.getState() !== "running") {
      await this.startBridge(tabId, tab.folderPath);
      bridge = this.bridges.get(tabId);
    }
    if (!bridge) {
      return { status: "error", error: "Could not start the assistant for this session." };
    }

    if (!(await this.waitForAgentReady(bridge))) {
      return {
        status: "error",
        error: "The assistant is not ready yet. Try again in a moment.",
      };
    }

    const prompt = buildSessionSyncPrompt({
      worktreePath: tab.folderPath,
      mainFolderPath: tab.worktree.mainFolderPath,
      baseBranch: tab.worktree.baseBranch,
      sessionBranch: tab.worktree.branch,
    });

    const turnDone = this.waitForAgentTurnComplete(tabId, SESSION_SYNC_TIMEOUT_MS);

    try {
      await this.sendCommand(tabId, { type: "prompt", message: prompt });
    } catch (error) {
      logger.warning("Session sync prompt failed", {
        tabId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "error", error: "Could not send the save request to the assistant." };
    }

    await turnDone;

    const after = await getSessionChanges(tab);
    if (!after.canApply) {
      logger.info("Session synced to main project", { tabId });
      return { status: "applied" };
    }

    return {
      status: "error",
      error: "Some changes could not be saved. Check the chat for details and try again.",
    };
  }

  private waitForAgentTurnComplete(tabId: TabId, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.turnWaiters.get(tabId);
        waiters?.delete(done);
        if (waiters && waiters.size === 0) {
          this.turnWaiters.delete(tabId);
        }
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);
      let waiters = this.turnWaiters.get(tabId);
      if (!waiters) {
        waiters = new Set();
        this.turnWaiters.set(tabId, waiters);
      }
      waiters.add(done);
    });
  }

  private resolveTurnWaiters(tabId: TabId): void {
    const waiters = this.turnWaiters.get(tabId);
    if (!waiters) return;
    for (const done of waiters) {
      done();
    }
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
      // The restarted agent re-applies the tab's model via its first models_sync.
      this.resetModelStateForFreshAgent(tabId);
      await bridge.restart(tab.folderPath, { piSessionId: this.resolvePiSessionId(tabId), mode: this.getMode() });
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

  async previewRevertTab(
    tabId: TabId,
    messageIndex: number,
  ): Promise<{ diffSummary?: string; messageCount: number }> {
    const tab = this.store.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    const message = tab.messages[messageIndex];
    if (!message) return { messageCount: 0 };

    await rewindManager.reload(tabId);
    const userMessageIds = getUserMessageIds(tab.messages);
    const preview = await rewindManager.previewRevert(tabId, message.id, userMessageIds);
    return {
      diffSummary: preview.diffSummary || undefined,
      messageCount: preview.messageCount,
    };
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

    this.assertNoSharedFolderConflict(tabId);

    // Reload checkpoints (pi-rewind in the agent process may have created new ones).
    await rewindManager.reload(tabId);

    // Restore files to the state before this message's changes.
    const userMessageIds = getUserMessageIds(tab.messages);
    const cp = rewindManager.findCheckpointBefore(tabId, message.id, userMessageIds);
    let revertSafetyCheckpointId: string | undefined;
    if (cp) {
      revertSafetyCheckpointId = await rewindManager.restoreToCheckpoint(tabId, cp);
    }

    const updated = this.patchTab(tab, {
      revertMessageId: message.id,
      revertSafetyCheckpointId,
    });
    this.store.tabs.set(tabId, updated);
    return updated;
  }

  async unrevertTab(tabId: TabId): Promise<Tab> {
    this.stopWorking(tabId);
    this.bridges.get(tabId)?.sendRaw({ type: "abort" });

    const tab = this.store.tabs.get(tabId);
    if (!tab) throw new Error("Tab not found");

    if (!tab.revertMessageId) return tab;

    if (tab.revertSafetyCheckpointId) {
      await rewindManager.restoreSafetyCheckpoint(tabId, tab.revertSafetyCheckpointId);
    }

    const updated = this.patchTab(tab, {
      revertMessageId: undefined,
      revertSafetyCheckpointId: undefined,
      revertDiffSummary: undefined,
    });
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
    const updated = this.patchTab(tab, {
      messages,
      revertMessageId: undefined,
      revertSafetyCheckpointId: undefined,
      revertDiffSummary: undefined,
    });
    this.store.tabs.set(tabId, updated);
    return updated;
  }

  private assertNoSharedFolderConflict(tabId: TabId): void {
    const tab = this.store.tabs.get(tabId);
    if (!tab?.folderPath) return;

    const conflict = this.store.openTabIds.some((id) => {
      if (id === tabId) return false;
      const other = this.store.tabs.get(id);
      return other?.folderPath === tab.folderPath;
    });

    if (conflict) {
      throw new RevertConflictError(
        "Another open tab is using the same project folder. Close the other tab first, then try undo again.",
      );
    }
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
      (id, event) => {
        // Silent host RPC: herman_get_session_info via editor sentinel.
        // Reply before forwarding so no editor UI appears and the tool cannot hang.
        if (this.tryRespondSessionInfo(id, event, bridge)) return;
        this.webviewRpc.send.agentEvent({ tabId: id, event });
      },
      (id, state, stderr) => this.webviewRpc.send.agentStatusChanged({ tabId: id, state, stderr }),
      (id, event) => this.handleAgentEvent(id, event),
    );
    this.bridges.set(tabId, bridge);
    try {
      // A fresh agent process has an empty registry and the extension default
      // model. Clear stale registry state so the tab's desired model is only
      // applied once the new agent advertises its list (models_sync).
      this.resetModelStateForFreshAgent(tabId);

      await bridge.start(folderPath, { piSessionId: this.resolvePiSessionId(tabId), mode: this.getMode() });
      await this.capturePiSessionId(tabId);
      // Enable pi's built-in auto-retry. Transient API errors (proxied
      // through the Herman server) are handled inside the agent with
      // exponential backoff, without a process restart.
      await bridge.sendCommand({ type: "set_auto_retry", enabled: true }).catch(() => undefined);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      this.webviewRpc.send.agentStatusChanged({ tabId, state: "crashed", stderr });
    }
  }

  /**
   * Reset per-tab model bookkeeping for a freshly (re)started agent process:
   * retry budget, confirmed model, and the stale registry snapshot. The
   * desired model (tab.currentModel) is untouched — it is re-applied when the
   * new agent advertises its registry via models_sync.
   */
  private resetModelStateForFreshAgent(tabId: TabId): void {
    this.modelApplyAttempts.delete(tabId);
    this.agentConfirmedModels.delete(tabId);
    const tab = this.store.tabs.get(tabId);
    if (tab && tab.availableModels.length > 0) {
      this.store.tabs.set(tabId, { ...tab, availableModels: [] });
    }
  }

  // ---------------------------------------------------------------------
  // Model selection
  // ---------------------------------------------------------------------

  /**
   * Select the model for a tab — the single entry point used by the UI.
   *
   * The selection is persisted with the session immediately (so it survives
   * restarts regardless of agent state) and applied to the agent when
   * possible; otherwise the apply happens as soon as the agent's registry
   * advertises the model (models_sync). Explicit selections are also recorded
   * as the global last-used model.
   */
  async setTabModel(
    tabId: TabId,
    modelId: string,
    opts?: { explicit?: boolean },
  ): Promise<{ ok: boolean; model?: string; applied: boolean; error?: string }> {
    const tab = this.store.tabs.get(tabId);
    if (!tab) return { ok: false, applied: false, error: "Tab not found" };

    const normalized = normalizeModelId(modelId);
    if (!normalized) return { ok: false, applied: false, error: "Invalid model id" };

    if (tab.currentModel !== normalized) {
      this.store.tabs.set(tabId, this.patchTab(tab, { currentModel: normalized }));
      this.modelApplyAttempts.delete(tabId);
      this.webviewRpc.send.tabModelChanged({ tabId, currentModel: normalized });
      await this.persist();
    }

    if (opts?.explicit) {
      this.onExplicitModelSelection?.(normalized);
    }

    const applied = await this.applyDesiredModel(tabId);
    return { ok: true, model: normalized, applied };
  }

  /**
   * Best-effort apply of the tab's desired model to its agent. Returns true
   * when the agent accepted the model. No-ops when there is nothing to do:
   * no desired model, no running bridge, or the desired model is not (yet)
   * in the agent registry's advertised list.
   *
   * Retries are bounded per (desired model, registry snapshot) fingerprint —
   * a new models_sync with a different list re-opens the budget, so a model
   * that appears later is applied without any polling.
   */
  private async applyDesiredModel(tabId: TabId): Promise<boolean> {
    const tab = this.store.tabs.get(tabId);
    const desired = normalizeModelId(tab?.currentModel);
    if (!tab || !desired) return false;

    const bridge = this.bridges.get(tabId);
    if (!bridge || bridge.getState() !== "running") return false;

    // The agent already has the desired model — nothing to do.
    if (this.agentConfirmedModels.get(tabId) === desired) return false;

    // Apply only once the agent's registry advertises the model (models_sync
    // is the registry-ready signal). A model that is not (yet) listed is left
    // alone — it may appear on the next refresh.
    if (!shouldApplyDesiredModel({ desired, available: tab.availableModels })) {
      return false;
    }

    if (!this.consumeModelApplyAttempt(tabId, desired, tab.availableModels)) return false;

    const ref = parseModelRef(desired);
    if (!ref) return false;
    try {
      const response = await bridge.sendCommand({
        type: "set_model",
        provider: ref.provider,
        modelId: ref.modelId,
      });
      if (!response.success) {
        throw new Error(response.error ?? "set_model rejected");
      }
      this.agentConfirmedModels.set(tabId, desired);
      logger.debug("Applied tab model to agent", { tabId, model: desired });
      return true;
    } catch (error) {
      logger.warning("Failed to apply tab model; will retry on next models sync", {
        tabId,
        model: desired,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private consumeModelApplyAttempt(tabId: TabId, desired: string, available: string[]): boolean {
    const fingerprint = modelApplyFingerprint(desired, available);
    const entry = this.modelApplyAttempts.get(tabId);
    if (entry && entry.fingerprint === fingerprint) {
      if (entry.attempts >= MAX_MODEL_APPLY_ATTEMPTS) return false;
      entry.attempts += 1;
      return true;
    }
    this.modelApplyAttempts.set(tabId, { fingerprint, attempts: 1 });
    return true;
  }

  /** Initial model for fresh tabs (validated against the catalog by the caller). */
  private newTabModel(): string | undefined {
    return this.getNewTabModel?.();
  }

  /** Last model used by a pi session (from its JSONL), if any. */
  private readPiSessionModel(piSessionId?: string): string | undefined {
    try {
      return normalizeModelId(readPiSessionModelFromFile(piSessionId));
    } catch {
      return undefined;
    }
  }

  /** Ask every running agent to re-sync its model list from the server. */
  refreshAgentModels(): void {
    for (const bridge of this.bridges.values()) {
      bridge.sendRaw({ type: "prompt", message: HERMAN_REFRESH_MODELS_MESSAGE });
    }
  }

  private makeTab(folderPath: string, title?: string, currentModel?: string): Tab {
    const now = Date.now();
    const id = createTabId();
    return {
      id,
      title: title ?? (folderPath ? getProjectName(folderPath) : "New session"),
      folderPath,
      projectRoot: folderPath,
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
      ...(currentModel ? { currentModel } : {}),
    };
  }

  /**
   * Intercept `herman_get_session_info` editor RPC: reply silently with live
   * preview/project/worktree details and suppress the event from the renderer.
   * Returns true when the event was handled.
   */
  private tryRespondSessionInfo(
    tabId: TabId,
    event: AgentEvent,
    bridge: AgentBridge,
  ): boolean {
    const tab = this.store.tabs.get(tabId);

    const folderPath = tab?.folderPath ?? "";
    const preview = folderPath
      ? getDevServerStatus(folderPath)
      : {
          folderPath: "",
          phase: "stopped" as const,
          servers: [],
        };

    const reply = resolveSessionInfoHostReply(
      event,
      {
        folderPath: tab?.folderPath,
        projectRoot: tab?.projectRoot,
        worktree: tab?.worktree,
        mode: this.getMode(),
      },
      preview,
    );
    if (!reply) return false;

    logger.debug("Responding to herman_get_session_info", {
      tabId,
      requestId: reply.requestId,
      folderPath: tab?.folderPath,
      previewPhase: preview.phase,
      serverCount: preview.servers.length,
    });

    bridge.sendExtensionUiResponse(reply.requestId, { value: reply.value });
    return true;
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
        this.resolveTurnWaiters(tabId);
      }
    } else if (event.type === "agent_end" || event.type === "agent_complete") {
      // Only clear isThinking when this event still describes the current turn.
      // If the agent has moved on (e.g. auto-retry), the event is stale and
      // must not downgrade the working state.
      if (isAgentEndCurrent(event, tab.messages)) {
        patch.isThinking = false;
        this.resolveTurnWaiters(tabId);
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
      this.resolveTurnWaiters(tabId);
    }

    // Track model info on the bun side so the renderer's full sync can
    // restore it even when the herman/models_sync IPC event is lost.
    // Only adopt the agent's default model if this tab doesn't already
    // have one (e.g. restored from session or inherited from settings).
    if (event.type === "herman/models_sync" || event.type === "models_sync") {
      patch.availableModels = event.models;
      patch.currentModel = tab.currentModel ?? event.currentModel;

      // Merge custom-provider models into the shared catalog.
      this.onAgentModelsSync?.(event.models, event.modelMetadata);

      // Remember what the agent actually has selected so the apply machinery
      // doesn't re-send set_model for a model the agent already uses.
      const confirmed = normalizeModelId(event.currentModel);
      if (confirmed) {
        this.agentConfirmedModels.set(tabId, confirmed);
      }
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

    // models_sync signals a populated agent registry — (re)apply the tab's
    // desired model when the agent doesn't have it yet.
    if (event.type === "herman/models_sync" || event.type === "models_sync") {
      void this.applyDesiredModel(tabId);
    }
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
    // Older sessions predate persisted.currentModel — recover the model the
    // session was actually using from the pi JSONL stats so reopening keeps
    // the session's model instead of falling back to the agent default.
    if (!persisted.currentModel && instant.contextStats?.providerId && instant.contextStats?.modelId) {
      const recovered = normalizeModelId(
        `${instant.contextStats.providerId}/${instant.contextStats.modelId}`,
      );
      if (recovered) {
        patch.currentModel = recovered;
        // Persist the recovered model with the session right away.
        this.store.sessions.set(persisted.id, { ...persisted, currentModel: recovered });
      }
    }
    const updated = Object.keys(patch).length > 0 ? { ...tab, ...patch } : tab;
    this.hydrationResults.set(persisted.id, {
      status: instant.hydrationStatus,
      messages: updated.messages,
      contextStats: updated.contextStats,
    });
    if (instant.hydrationStatus === "pending" && persisted.folderPath) {
      logger.debug("Tab message hydration pending", { tabId: persisted.id });
    }
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

  /**
   * Register a tab in the store, set it as active, optionally schedule the
   * agent, persist, and kick off background worktree creation.
   *
   * This is the shared tail of createTab / openSession / openPiSession /
   * adoptWizardSession so the tab opens instantly while worktree setup
   * happens in the background.
   */
  private async registerAndOpenTab(
    tab: Tab,
    persisted: PersistedSession,
    projectRoot: string,
    needsWorktree: boolean,
  ): Promise<Tab> {
    this.store.sessions.set(tab.id, persisted);
    this.store.tabs.set(tab.id, tab);
    this.store.openTabIds.push(tab.id);
    this.store.activeTabId = tab.id;

    if (projectRoot && !this.store.projects.includes(projectRoot)) {
      this.store.projects.push(projectRoot);
    }

    // Only schedule the agent immediately for non-worktree tabs.
    // Worktree tabs start the agent after the worktree is ready.
    if (!needsWorktree && tab.folderPath) {
      this.agentRuntime.schedule(tab.id);
    }
    await this.persist();

    // Background: create the session worktree, then update the tab and start the agent.
    if (needsWorktree) {
      void this.finalizeTabWorktree(tab.id, projectRoot);
    }

    return tab;
  }

  /**
   * Background task: create the session worktree, update the tab, and start
   * the agent once the isolated folder is ready.  Called fire-and-forget from
   * createTab / openSession / openPiSession so the tab opens instantly.
   */
  private async finalizeTabWorktree(tabId: TabId, projectRoot: string): Promise<void> {
    try {
      const created = await createSessionWorktree(projectRoot, tabId);
      const tab = this.store.tabs.get(tabId);
      // Tab may have been closed while the worktree was being created.
      if (!tab || !this.store.openTabIds.includes(tabId)) {
        // Clean up the worktree we just created since nobody needs it.
        void removeSessionWorktree({ folderPath: created.folderPath, worktree: created.worktree }).catch(() => {});
        return;
      }

      // patchTab updates the sessions store internally, so we only need to
      // update the tabs map and notify the renderer.
      const updated = this.patchTab(tab, {
        folderPath: created.folderPath,
        worktree: created.worktree,
        worktreeStatus: "ready",
      });
      this.store.tabs.set(tabId, updated);

      this.webviewRpc.send.tabFolderChanged({
        tabId,
        folderPath: created.folderPath,
        projectRoot,
        worktree: created.worktree,
        worktreeStatus: "ready",
      });

      // Now that the real worktree folder exists, start the agent.
      this.agentRuntime.schedule(tabId);
      await this.persist();

      logger.info("Session worktree ready", { tabId, folderPath: created.folderPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to create session worktree", { tabId, error: message });
      const tab = this.store.tabs.get(tabId);
      // Only update the tab if it still exists and is still open.
      if (tab && this.store.openTabIds.includes(tabId)) {
        const updated = this.patchTab(tab, {
          worktreeStatus: "error",
          connectionError: `Failed to create session workspace: ${message}`,
        });
        this.store.tabs.set(tabId, updated);

        // Notify the renderer so it can show the error state.
        this.webviewRpc.send.tabFolderChanged({
          tabId,
          worktreeStatus: "error",
          error: message,
        });
        await this.persist();
      }
    }
  }

  private async ensureAgentForTab(tabId: TabId): Promise<void> {
    const tab = this.store.tabs.get(tabId);
    if (!tab?.folderPath) return;

    // Don't start the agent while the worktree is still being created.
    // finalizeTabWorktree will schedule it once the folder is ready.
    if (tab.worktreeStatus === "pending") return;

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
    return readPiSessionId(persisted) ?? persisted;
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
        observed = readPiSessionId();
      } else {
        return;
      }
    }

    const observedFile = resolvePiSessionFile(observed);
    if (!observedFile) {
      return;
    }

    if (session.piSessionId && session.piSessionId !== observed) {
      const persistedFile = resolvePiSessionFile(session.piSessionId);
      if (persistedFile) return;
    }

    if (!observed || session.piSessionId === observed) return;

    this.store.sessions.set(tabId, { ...session, piSessionId: observed, updatedAt: Date.now() });
    await this.persist();
    this.webviewRpc.send.sessionsChanged({
      sessions: Array.from(this.store.sessions.values()),
    });
  }

  /**
   * Safety net: remove any BrowserViews that were created by preview
   * webview tags but weren't cleaned up by the renderer (e.g. due to
   * a race between DOM removal and the native webviewTagRemove message).
   *
   * Call this only when all preview servers have been stopped (app quit,
   * sign-out, reset) — otherwise it would tear down views still in use
   * by other open tabs.
   */
  removeOrphanedPreviewViews(): void {
    try {
      const allViews = BrowserView.getAll();
      for (const view of allViews) {
        // Only target OOPIF views (created by <electrobun-webview> tags),
        // not the main window's BrowserView or manually-created views.
        if (!view.hostWebviewId) continue;
        // Only clean up views using the preview partition.
        if (view.partition !== "preview") continue;

        logger.debug("Removing orphaned preview BrowserView", {
          viewId: view.id,
          hostWebviewId: view.hostWebviewId,
          partition: view.partition,
        });
        view.remove();
      }
    } catch (err) {
      logger.warning("Failed to enumerate BrowserViews for orphan cleanup", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
