import { useEffect } from "react";

import { activateTab, closeTab, createTab, openProject } from "./agent-actions.js";
import { useAgentStore } from "./agent-store.js";
import { resolveShortcutCommand, type CommandId } from "./commands.js";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
    return true;
  }
  return target.closest("input, textarea, [contenteditable=true]") !== null;
}

function resolveTabIndexFromCommand(command: CommandId): number | null {
  const match = command.match(/^tab\.activate\.(\d)$/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) - 1;
}

function activateTabByIndex(index: number): void {
  const store = useAgentStore.getState();
  const tabId = store.tabOrder[index];
  if (tabId) {
    void activateTab(tabId);
  }
}

export function dispatchCommand(command: CommandId): void {
  const store = useAgentStore.getState();

  switch (command) {
    case "view.home": {
      store.setSelectedProject(null);
      store.setView("home");
      break;
    }
    case "view.settings": {
      store.setView("settings");
      break;
    }
    case "tab.new": {
      const activeTab = store.activeTabId ? store.tabs[store.activeTabId] : undefined;
      const folderPath = activeTab?.folderPath ?? store.ui.selectedProject ?? undefined;
      void createTab(folderPath);
      break;
    }
    case "tab.close": {
      if (store.activeTabId) {
        void closeTab(store.activeTabId);
      }
      break;
    }
    case "tab.activate.previous": {
      if (!store.activeTabId || store.tabOrder.length === 0) return;
      const index = store.tabOrder.indexOf(store.activeTabId);
      const previousIndex = index <= 0 ? store.tabOrder.length - 1 : index - 1;
      activateTabByIndex(previousIndex);
      break;
    }
    case "tab.activate.next": {
      if (!store.activeTabId || store.tabOrder.length === 0) return;
      const index = store.tabOrder.indexOf(store.activeTabId);
      const nextIndex = index >= store.tabOrder.length - 1 ? 0 : index + 1;
      activateTabByIndex(nextIndex);
      break;
    }
    case "project.open": {
      void openProject();
      break;
    }
    case "sidebar.toggle": {
      store.toggleSidebar();
      break;
    }
    case "model.selector.toggle": {
      store.setModelSelectorOpen(!store.ui.modelSelectorOpen);
      break;
    }
    default: {
      const index = resolveTabIndexFromCommand(command);
      if (index !== null) {
        activateTabByIndex(index);
      }
    }
  }
}

export function useCommandShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;

      const command = resolveShortcutCommand(event);
      if (!command) return;

      event.preventDefault();
      event.stopPropagation();
      dispatchCommand(command);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
