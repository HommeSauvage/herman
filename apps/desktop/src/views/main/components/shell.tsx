import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAgentStore } from "../lib/agent-store.js";
import { ChatView } from "./chat-view.js";
import { Composer } from "./composer.js";
import { ErrorBoundary } from "./error-boundary.js";
import { HomeView } from "./home-view.js";
import { ModelSelector } from "./model-selector.js";
import { NewSessionView } from "./new-session-view.js";
import { ProjectSidebar } from "./project-sidebar.js";
import { RightSidebar } from "./right-sidebar.js";
import { SettingsView } from "./settings-view.js";
import { StatusBar } from "./status-bar.js";
import { TabBar } from "./tab-bar.js";
import { TabSwitcher } from "./tab-switcher.js";

export function Shell() {
  // Select only the fields Shell actually reads.  Avoid `useActiveTab()`
  // which returns the entire tab reference — any store update that
  // touches `tabs` would produce a new object and force a re-render.
  const { sidebarOpen, view, activeTabId, activeTabFolder, tabMessageCount } = useAgentStore(
    useShallow((s) => ({
      sidebarOpen: s.ui.sidebarOpen,
      view: s.ui.view,
      activeTabId: s.activeTabId,
      activeTabFolder: s.activeTabId ? s.tabs[s.activeTabId]?.folderPath : undefined,
      tabMessageCount: s.activeTabId ? (s.tabs[s.activeTabId]?.messages.length ?? 0) : 0,
    })),
  );
  const hasActiveTab = activeTabId != null && activeTabFolder;
  const isEmptySession = tabMessageCount === 0;

  // Safety net: if view is "session" but there's no valid active tab with a
  // project, force-redirect to home. This catches edge cases like the wizard
  // cancel leaving the view in an invalid state.
  const setView = useAgentStore((s) => s.setView);
  useEffect(() => {
    if (view === "session" && !hasActiveTab) {
      setView("home");
    }
  }, [view, hasActiveTab, setView]);

  return (
    <div className="bg-ridge flex h-full w-full flex-col">
      <TabBar />
      <TabSwitcher />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {(view === "home" || view === "settings") && <ProjectSidebar />}

        <div className="flex min-w-0 flex-1 overflow-hidden">
          {view === "home" ? (
            <HomeView />
          ) : view === "settings" ? (
            <ErrorBoundary>
              <SettingsView />
            </ErrorBoundary>
          ) : !hasActiveTab ? (
            <HomeView />
          ) : isEmptySession ? (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex-1 overflow-hidden">
                <NewSessionView />
              </div>
              <StatusBar />
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex-1 overflow-hidden">
                <ChatView />
              </div>

              <div className="bg-surface/50 border-t border-white/[0.06] px-5 pt-3 pb-5">
                <ErrorBoundary>
                  <Composer key={activeTabId} />
                </ErrorBoundary>
              </div>

              <StatusBar />
            </div>
          )}

          {sidebarOpen && view === "session" && <RightSidebar />}
        </div>
      </div>

      <ModelSelector />
    </div>
  );
}

if (import.meta.env.DEV) (Shell as unknown as Record<string, unknown>).whyDidYouRender = true;
