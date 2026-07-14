import type { Tab, TabId } from "../shared/rpc.js";
import { getProjectColor } from "../shared/tab-utils.js";
import { finalizeStreamingMessages } from "../shared/apply-agent-event.js";
import { readPiSessionId } from "./rewind-manager.js";
import { loadWindowState, saveWindowState, type PersistedSession } from "./window-state.js";

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

  toPersistedSession(tab: Tab): PersistedSession {
    const persistedId = this.sessions.get(tab.id)?.piSessionId;
    return {
      id: tab.id,
      title: tab.title,
      folderPath: tab.folderPath,
      projectColor: tab.projectColor,
      piSessionId: readPiSessionId(persistedId) ?? persistedId,
      worktree: tab.worktree,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      revertMessageId: tab.revertMessageId,
    };
  }

  patchTab(tab: Tab, patch: Partial<Omit<Tab, "id" | "createdAt">>): Tab {
    const updated = { ...tab, ...patch, updatedAt: Date.now() };
    this.sessions.set(tab.id, this.toPersistedSession(updated));
    return updated;
  }

  hydrateTab(
    persisted: PersistedSession,
    messages: Tab["messages"],
    composerValue = "",
  ): Tab {
    return {
      ...persisted,
      projectColor: getProjectColor(persisted.folderPath),
      messages: finalizeStreamingMessages(messages),
      isThinking: false,
      showThinking: false,
      thinkingMessages: [],
      availableModels: [],
      connectionState: "idle",
      composerValue,
      queuedMessages: [],
      revertMessageId: persisted.revertMessageId,
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
