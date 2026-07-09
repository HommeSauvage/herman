import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { TabId } from "../../../../shared/tab-utils.js";
import { useAgentStore } from "./store.js";
import type { Tab } from "./types.js";

export function useActiveTab(): Tab | undefined {
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

export function isTabWorking(tab: { isThinking: boolean; messages: { role: string; isStreaming?: boolean; status?: string }[] } | undefined): boolean {
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

export function useTab(id: TabId): Tab | undefined {
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
