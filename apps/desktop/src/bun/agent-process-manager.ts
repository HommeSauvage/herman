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
import type { AgentStatus, ContextStats, Message, ModelMetadata, OutgoingMessages, SessionIsolation, Tab, TabId, TabMessagesHydrated, TabMessageHydrationStatus } from "../shared/rpc.js";
import type { PreviewServerLogLine } from "../shared/preview.js";
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
import { AgentBridge } from "./agent-bridge.js";
import { AgentRuntime } from "./agent-runtime.js";
import { deleteComposerDraft, loadComposerDraft, saveComposerDraft } from "./composer-drafts.js";
import {
  extractMessagesFromAgentPayload,
} from "./pi-messages.js";
import { contextStatsFromContextReport, readPiSessionModel as readPiSessionModelFromFile } from "./session-snapshot.js";
import { stopPreviewsForScope, tabScope } from "./preview-server.js";
import { previewPortRegistry } from "./preview/port-registry.js";
import { ensurePreviewStarted } from "./preview/index.js";
import { rewindManager, getUserMessageIds, readPiSessionId, RevertConflictError } from "./rewind-manager.js";
import { deleteTabHistory, saveTabHistory } from "./tab-history.js";
import { loadInstantHydration } from "./tab-message-hydration.js";
import { resolvePiSessionFile, deletePiSessionFile } from "./pi-session.js";
import { SessionBootstrapper, resolveIsolationPolicy } from "./session-bootstrap/bootstrapper.js";
import {
  buildSessionSyncPrompt,
  getSessionChanges,
  removeSessionWorktree,
  resolveProjectRoot,
  WorktreeIndex,
} from "./worktree.js";
import { TabSessionStore } from "./tab-session-store.js";
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

/** Sender shape derived from OutgoingMessages — dropped payload fields are
 *  a compile error here, not a silent runtime loss (see Bug A in the sessions
 *  refactor plan). */
type OutgoingSender = {
  [K in keyof OutgoingMessages]: (payload: OutgoingMessages[K]) => void;
};

export type WebviewSender = {
  send: Pick<
    OutgoingSender,
    | "agentEvent"
    | "agentStatusChanged"
    | "sessionStateChanged"
    | "sessionsChanged"
    | "tabMessagesHydrated"
    | "tabModelChanged"
  >;
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
  /** Called after a tab is fully closed (preview context cleanup, etc.). */
  onTabClosed?: (tabId: TabId) => void;
  /** Setup/server log lines (setup steps, preview servers) for the preview-context ring. */
  emitServerLine?: (line: PreviewServerLogLine) => void;
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
  private onTabClosed?: (tabId: TabId) => void;
  private emitServerLine?: (line: PreviewServerLogLine) => void;
  private serverUrl: string;
  /** set_model retry budget per tab, scoped by (desired model, registry snapshot). */
  private modelApplyAttempts = new Map<TabId, { fingerprint: string; attempts: number }>();
  /** Last model each agent confirmed via models_sync (or a successful set_model). */
  private agentConfirmedModels = new Map<TabId, string>();
  /** Single owner of the tab → ready pipeline (worktree, setup, agent, preview). */
  private readonly bootstrapper: SessionBootstrapper;

  constructor(options: AgentProcessManagerOptions) {
    this.webviewRpc = options.webviewRpc;
    this.serverUrl = options.serverUrl;
    this.getToken = options.getToken;
    this.getHermanEnabled = options.getHermanEnabled;
    this.getMode = options.getMode;
    this.getNewTabModel = options.getNewTabModel;
    this.onExplicitModelSelection = options.onExplicitModelSelection;
    this.onAgentModelsSync = options.onAgentModelsSync;
    this.onTabClosed = options.onTabClosed;
    this.emitServerLine = options.emitServerLine;
    this.agentRuntime = new AgentRuntime((tabId) => this.ensureAgentForTab(tabId));
    this.bootstrapper = new SessionBootstrapper({
      getTab: (tabId) => this.store.tabs.get(tabId),
      patchTab: (tabId, patch) => {
        const tab = this.store.tabs.get(tabId);
        if (!tab) return;
        this.store.tabs.set(tabId, this.patchTab(tab, patch));
      },
      getPersisted: (tabId) => this.store.sessions.get(tabId),
      patchPersisted: (tabId, patch) => {
        const session = this.store.sessions.get(tabId);
        if (session) {
          this.store.sessions.set(tabId, { ...session, ...patch });
        }
      },
      isTabOpen: (tabId) => this.store.openTabIds.includes(tabId),
      getMode: () => this.getMode(),
      scheduleAgent: (tabId) => this.agentRuntime.schedule(tabId),
      emitState: (payload) => this.webviewRpc.send.sessionStateChanged(payload),
      emitServerLine: (line) => this.emitServerLine?.(line),
      persist: () => this.persist(),
      portRegistry: previewPortRegistry,
      ensurePreviewStarted: (scope, folderPath, opts) =>
        ensurePreviewStarted(scope, folderPath, opts),
    });
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
      const repairTabIds: TabId[] = [];
      for (const tabId of openTabIds) {
        const persisted = this.store.sessions.get(tabId);
        if (!persisted) continue;
        const composerValue = await loadComposerDraft(tabId);
        const instant = await loadInstantHydration(tabId, persisted);
        const tab = this.materializeTabFromHydration(persisted, instant, composerValue);
        syncMessageCounter([tab.messages]);
        this.store.tabs.set(tabId, tab);
        if (!tab.folderPath) continue;
        const isolation = persisted.isolation ?? (persisted.worktree ? "worktree" : "direct");
        if (isolation === "worktree") {
          // Repair mode: the bootstrapper re-creates a missing worktree,
          // resumes any interrupted setup, then starts agent + preview.
          repairTabIds.push(tabId);
          continue;
        }
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
      for (const tabId of repairTabIds) {
        void this.bootstrapper.bootstrap(tabId, { kind: "repair" });
      }

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
    // The one isolation policy (rookie + git → worktree). The worktree and
    // workspace setup happen in the background via the bootstrapper.
    const isolation = projectRoot ? await resolveIsolationPolicy(mode, projectRoot) : "direct";
    if (isolation === "worktree") {
      // Return the tab immediately with the project root as a temporary
      // folder so the UI feels instant; the real workspace follows.
      tab.folderPath = projectRoot;
      tab.setup = { phase: "pending", label: "Preparing your session…" };
    }

    await this.registerAndOpenTab(tab, this.toPersistedSession(tab, isolation), projectRoot);
    this.bootstrapForTab(tab.id, "create");
    logger.debug("Created tab", { tabId: tab.id, folderPath: tab.folderPath, projectRoot, isolation });
    return tab;
  }

  /**
   * Open a finished wizard project as a real tab with a **fresh** pi session.
   * The wizard's `setupProjectRepo()` already committed everything, so the
   * first session goes through the same bootstrap pipeline as any rookie tab
   * (worktree + full setup + agent + preview) — no special no-worktree path.
   *
   * When the repo setup failed (no git repo), the session falls back to
   * direct isolation per the policy table and the failure is surfaced in the
   * tab's setup state.
   */
  async adoptWizardSession(
    projectPath: string,
    wizardSessionId: string,
    opts?: { repoSetupError?: string },
  ): Promise<Tab> {
    const tab = await this.createTab(projectPath);
    if (opts?.repoSetupError) {
      const repoSetupError = opts.repoSetupError;
      // After the bootstrap completes (direct fallback → phase "none"),
      // surface why this session could not be isolated.
      void this.bootstrapper.bootstrap(tab.id, { kind: "create" }).then(() => {
        const current = this.store.tabs.get(tab.id);
        if (!current || current.setup.phase !== "none") return;
        const updated = this.patchTab(current, {
          setup: {
            phase: "error",
            step: "provision",
            error: `The project's git repository could not be set up, so this session is not isolated: ${repoSetupError}`,
            retryable: false,
          },
        });
        this.store.tabs.set(tab.id, updated);
        this.emitSessionState(tab.id);
      });
    }
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
    const tab = { ...this.materializeTabFromHydration(persisted, instant, composerValue), updatedAt: now };
    // The persisted isolation policy is final — reopening never upgrades
    // direct → worktree (no silent migration).
    const isolation = persisted.isolation ?? (persisted.worktree ? "worktree" : "direct");

    await this.registerAndOpenTab(tab, { ...persisted, isolation, updatedAt: now }, tab.projectRoot);
    this.bootstrapForTab(sessionId, "open");
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

    const isolation = await resolveIsolationPolicy(mode, projectRoot);
    if (isolation === "worktree") {
      tab.folderPath = projectRoot;
      tab.setup = { phase: "pending", label: "Preparing your session…" };
    }

    const persisted = { ...this.toPersistedSession(tab, isolation), piSessionId, updatedAt: Date.now() };
    await this.registerAndOpenTab(tab, persisted, projectRoot);
    this.bootstrapForTab(tab.id, "create");
    logger.info("Opened pi session as tab", { tabId: tab.id, folderPath, projectRoot, piSessionId, isolation });
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
    // Defer preview server shutdown so the renderer receives tabClosed
    // and unmounts the webview (hiding the native overlay) before the
    // server is killed.  Otherwise the webview flashes an error page.
    // Preview ownership is per-tab — no folder-sharing checks needed.
    void stopPreviewsForScope(tabScope(tabId)).catch((err) =>
      logger.warning("Failed to stop preview servers during tab close", {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    void this.bootstrapper.dispose(tabId).catch(() => undefined);

    if (this.store.activeTabId === tabId) {
      this.store.activeTabId = this.store.openTabIds[openIndex - 1] ?? this.store.openTabIds[openIndex] ?? undefined;
    }

    await this.persist();
    this.onTabClosed?.(tabId);
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
    const mode = this.getMode();
    const isolation = await resolveIsolationPolicy(mode, projectRoot);

    // Rookie + git project: the tab becomes a fresh isolated session on the
    // new project — worktree + full setup via the bootstrap pipeline.
    if (isolation === "worktree") {
      await stopPreviewsForScope(tabScope(tabId)).catch(() => undefined);
      await this.bootstrapper.dispose(tabId).catch(() => undefined);
      const bridge = this.bridges.get(tabId);
      if (bridge) {
        await bridge.stop();
        this.bridges.delete(tabId);
      }
      const updated = this.patchTab(tab, {
        folderPath: projectRoot,
        projectRoot,
        projectColor: getProjectColor(projectRoot),
        worktree: undefined,
        setup: { phase: "pending", label: "Preparing your session…" },
      });
      this.store.tabs.set(tabId, updated);
      this.store.sessions.set(tabId, this.toPersistedSession(updated, "worktree"));
      if (projectRoot && !this.store.projects.includes(projectRoot)) {
        this.store.projects.push(projectRoot);
      }
      await this.persist();
      this.bootstrapForTab(tabId, "create");
      return;
    }

    const updated = this.patchTab(tab, {
      folderPath: path,
      projectRoot,
      projectColor: getProjectColor(projectRoot),
      worktree: undefined,
      setup: { phase: "none" },
    });
    this.store.tabs.set(tabId, updated);
    this.store.sessions.set(tabId, this.toPersistedSession(updated, "direct"));

    if (projectRoot && !this.store.projects.includes(projectRoot)) {
      this.store.projects.push(projectRoot);
    }

    const bridge = this.bridges.get(tabId);
    if (bridge) {
      await bridge.restart(path, { piSessionId: this.resolvePiSessionId(tabId), mode: this.getMode() });
    } else {
      this.agentRuntime.schedule(tabId);
    }

    this.emitSessionState(tabId);
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
      await this.capturePiSessionId(tabId);
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

    await rewindManager.reload(tabId, this.resolvePiSessionId(tabId));
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

    // Reload checkpoints (herman-rewind may have created new ones).
    await rewindManager.reload(tabId, this.resolvePiSessionId(tabId));

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

  private toPersistedSession(tab: Tab, isolation?: SessionIsolation): PersistedSession {
    return this.store.toPersistedSession(tab, isolation);
  }

  private async startBridge(tabId: TabId, folderPath?: string) {
    // Initialize git-based rewind for file-level undo support.
    if (folderPath) {
      void rewindManager.init(tabId, folderPath, this.resolvePiSessionId(tabId));
    }

    const bridge = new AgentBridge(
      tabId,
      (id, event) => {
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
      setup: { phase: "none" },
      createdAt: now,
      updatedAt: now,
      composerValue: "",
      queuedMessages: [],
      ...(currentModel ? { currentModel } : {}),
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
   * Register a tab in the store, set it as active, and persist.
   * The shared tail of createTab / openSession / openPiSession /
   * adoptWizardSession — the bootstrapper takes it from there (worktree,
   * setup, agent, preview).
   */
  private async registerAndOpenTab(
    tab: Tab,
    persisted: PersistedSession,
    projectRoot: string,
  ): Promise<Tab> {
    this.store.sessions.set(tab.id, persisted);
    this.store.tabs.set(tab.id, tab);
    this.store.openTabIds.push(tab.id);
    this.store.activeTabId = tab.id;

    if (projectRoot && !this.store.projects.includes(projectRoot)) {
      this.store.projects.push(projectRoot);
    }

    await this.persist();
    return tab;
  }

  /** Kick off the bootstrap pipeline (fire-and-forget; errors land on Tab.setup). */
  private bootstrapForTab(tabId: TabId, kind: "create" | "open" | "repair" | "retry"): void {
    void this.bootstrapper.bootstrap(tabId, { kind }).catch((error) => {
      logger.error("Session bootstrap failed", {
        tabId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Re-run the workspace setup pipeline after a setup failure. */
  async retrySessionSetup(tabId: TabId): Promise<{ ok: boolean; error?: string }> {
    return this.bootstrapper.retry(tabId);
  }

  /** Persist the per-session "user stopped the preview manually" flag. */
  async setPreviewManuallyStopped(tabId: TabId, stopped: boolean): Promise<void> {
    const session = this.store.sessions.get(tabId);
    if (!session || session.previewManuallyStopped === stopped) return;
    this.store.sessions.set(tabId, { ...session, previewManuallyStopped: stopped });
    await this.persist();
  }

  /** Worktree → owning-project mapping for pi session listing (D5). */
  getWorktreeIndex(): WorktreeIndex {
    return new WorktreeIndex(this.store.sessions.values());
  }

  /** Push the tab's full setup/folder state to the renderer. */
  private emitSessionState(tabId: TabId): void {
    const tab = this.store.tabs.get(tabId);
    if (!tab) return;
    this.webviewRpc.send.sessionStateChanged({
      tabId,
      setup: tab.setup,
      folderPath: tab.folderPath,
      projectRoot: tab.projectRoot,
      ...(tab.worktree ? { worktree: tab.worktree } : {}),
    });
  }

  private async ensureAgentForTab(tabId: TabId): Promise<void> {
    const tab = this.store.tabs.get(tabId);
    if (!tab?.folderPath) return;

    // Don't start the agent while workspace setup is still running.
    // The bootstrapper schedules the agent once setup completes (or fails
    // retryably — the agent is the best fixer and shares the workspace).
    if (tab.setup.phase === "pending") return;

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
