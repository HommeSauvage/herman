import { finalizeStreamingMessages } from "../shared/apply-agent-event.js";
import type { SessionIsolation, Tab, TabId } from "../shared/rpc.js";
import { getProjectColor } from "../shared/tab-utils.js";
import { readPiSessionId } from "./rewind-manager.js";
import { loadWindowState, type PersistedSession, saveWindowState } from "./window-state.js";

/** In-memory tab/session chrome + window-state persistence. No subprocess knowledge. */
export class TabSessionStore {
  readonly tabs = new Map<TabId, Tab>();
  readonly sessions = new Map<TabId, PersistedSession>();
  openTabIds: TabId[] = [];
  activeTabId?: TabId;
  projects: string[] = [];

  getOpenTabs(): Tab[] {
    return this.openTabIds
      .map((tabId) => this.tabs.get(tabId))
      .filter((tab): tab is Tab => tab !== undefined);
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

  getTab(tabId: TabId): Tab | undefined {
    return this.tabs.get(tabId);
  }

  getOrderedTabIds(): TabId[] {
    return [...this.openTabIds];
  }

  toPersistedSession(tab: Tab, isolation?: SessionIsolation): PersistedSession {
    const previous = this.sessions.get(tab.id);
    const persistedId = previous?.piSessionId;
    return {
      id: tab.id,
      title: tab.title,
      folderPath: tab.folderPath,
      projectRoot: tab.projectRoot,
      projectColor: tab.projectColor,
      piSessionId: readPiSessionId(persistedId) ?? persistedId,
      worktree: tab.worktree,
      // Isolation is fixed at creation: explicit on first persist, preserved
      // from the store afterwards (a pending worktree tab has no worktree
      // object yet, so tab state alone can't be the source of truth).
      isolation: isolation ?? previous?.isolation ?? (tab.worktree ? "worktree" : "direct"),
      setupCompletedAt: previous?.setupCompletedAt,
      setupPlanHash: previous?.setupPlanHash,
      previewManuallyStopped: previous?.previewManuallyStopped,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      revertMessageId: tab.revertMessageId,
      currentModel: tab.currentModel,
    };
  }

  patchTab(tab: Tab, patch: Partial<Omit<Tab, "id" | "createdAt">>): Tab {
    const updated = { ...tab, ...patch, updatedAt: Date.now() };
    this.sessions.set(tab.id, this.toPersistedSession(updated));
    return updated;
  }

  hydrateTab(persisted: PersistedSession, messages: Tab["messages"], composerValue = ""): Tab {
    const isolation = persisted.isolation ?? (persisted.worktree ? "worktree" : "direct");
    return {
      ...persisted,
      projectRoot: persisted.projectRoot ?? persisted.folderPath,
      projectColor: getProjectColor(persisted.projectRoot ?? persisted.folderPath),
      // Restored worktree sessions start in the pending state until the
      // bootstrapper's repair run verifies the workspace and marks it ready.
      setup:
        isolation === "worktree"
          ? { phase: "pending", label: "Checking your workspace…" }
          : { phase: "none" },
      messages: finalizeStreamingMessages(messages),
      isThinking: false,
      showThinking: false,
      thinkingMessages: [],
      availableModels: [],
      connectionState: "idle",
      composerValue,
      queuedMessages: [],
      revertMessageId: persisted.revertMessageId,
      currentModel: persisted.currentModel,
    };
  }

  async persist(): Promise<void> {
    const sessions = Array.from(this.sessions.values()).map((session) => {
      const openTab = this.tabs.get(session.id);
      return openTab ? this.toPersistedSession(openTab) : session;
    });
    const activeFolder = this.activeTabId
      ? (this.tabs.get(this.activeTabId)?.folderPath ??
        this.sessions.get(this.activeTabId)?.folderPath)
      : undefined;

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

  async loadWindowStateProjects(): Promise<{ lastFolderPath?: string }> {
    const state = await loadWindowState();
    return { lastFolderPath: state.lastFolderPath };
  }

  applyRestoreState(state: {
    projects: string[];
    openTabIds: TabId[];
    activeTabId?: TabId;
    persistedSessions: PersistedSession[];
  }): void {
    this.projects = state.projects;
    this.openTabIds = state.openTabIds;
    this.activeTabId = state.activeTabId;
    this.sessions.clear();
    for (const persisted of state.persistedSessions) {
      this.sessions.set(persisted.id, persisted);
    }
  }

  clearAll(): void {
    this.tabs.clear();
    this.openTabIds = [];
    this.activeTabId = undefined;
  }
}
