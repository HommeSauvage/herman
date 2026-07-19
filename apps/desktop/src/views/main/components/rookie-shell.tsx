import { useShallow } from "zustand/react/shallow";
import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@herman/ui/lib/utils";
import { LayoutGrid, Settings, Plus, Sparkles, GripVertical } from "lucide-react";

import { useAgentStore } from "../lib/agent-store.js";
import { ChatView } from "./chat-view.js";
import { Composer } from "./composer.js";
import { ErrorBoundary } from "./error-boundary.js";
import { HomeView } from "./home-view.js";
import { RookieHomeView } from "./rookie-home-view.js";
import { ModelSelector } from "./model-selector.js";
import { NewSessionView } from "./new-session-view.js";
import { OnboardingWizard } from "./onboarding-wizard.js";
import { PreviewPane } from "./preview-pane.js";
import { PublishDialog } from "./publish-dialog.js";
import { SettingsView } from "./settings-view.js";
import { StatusBar } from "./status-bar.js";
import { TabBar } from "./tab-bar.js";
import { TabSwitcher } from "./tab-switcher.js";

export function RookieShell() {
  const { view, activeTabId, tabMessageCount, activeTabFolder, activeTabProjectRoot, activeTabWorktree, activeTabSetup, onboardingVisible } = useAgentStore(
    useShallow((s) => ({
      view: s.ui.view,
      activeTabId: s.activeTabId,
      tabMessageCount: s.activeTabId ? (s.tabs[s.activeTabId]?.messages.length ?? 0) : 0,
      activeTabFolder: s.activeTabId ? s.tabs[s.activeTabId]?.folderPath : undefined,
      activeTabProjectRoot: s.activeTabId ? s.tabs[s.activeTabId]?.projectRoot : undefined,
      activeTabWorktree: s.activeTabId ? s.tabs[s.activeTabId]?.worktree : undefined,
      activeTabSetup: s.activeTabId ? s.tabs[s.activeTabId]?.setup : undefined,
      onboardingVisible: s.onboardingVisible,
    })),
  );
  const setOnboardingVisible = useAgentStore((s) => s.setOnboardingVisible);
  const setView = useAgentStore((s) => s.setView);

  // Safety net: if view is "session" but there's no valid active tab with a
  // project, force-redirect to home.
  const hasValidTab = activeTabId != null && activeTabFolder;
  useEffect(() => {
    if (view === "session" && !hasValidTab) {
      setView("home");
    }
  }, [view, hasValidTab, setView]);

  const [publishOpen, setPublishOpen] = useState(false);
  const handleOpenPublish = useCallback(() => setPublishOpen(true), []);
  const handleClosePublish = useCallback(() => setPublishOpen(false), []);

  // Resizable split between chat and preview pane.
  // Ratio is persisted per tab via a ref-based map so switching tabs
  // restores the user's preferred split.
  const DEFAULT_SPLIT_RATIO = 40; // percentage for chat side
  const MIN_CHAT_PCT = 25;
  const MAX_CHAT_PCT = 60;
  const [chatRatio, setChatRatio] = useState(DEFAULT_SPLIT_RATIO);
  const [isDragging, setIsDragging] = useState(false);
  const chatRatioRef = useRef(DEFAULT_SPLIT_RATIO);
  const savedRatios = useRef<Map<string, number>>(new Map());
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startRatio: number } | null>(null);

  // Keep ref in sync so pointer handlers always read the latest value.
  useEffect(() => {
    chatRatioRef.current = chatRatio;
  }, [chatRatio]);

  // Restore saved ratio when switching tabs.
  useEffect(() => {
    if (activeTabId) {
      const saved = savedRatios.current.get(activeTabId);
      setChatRatio(saved ?? DEFAULT_SPLIT_RATIO);
    }
  }, [activeTabId]);

  const handleSplitPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startRatio: chatRatioRef.current };
    setIsDragging(true);
  }, []);

  const handleSplitPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current || !splitContainerRef.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dpct = (dx / splitContainerRef.current.getBoundingClientRect().width) * 100;
    const clamped = Math.min(MAX_CHAT_PCT, Math.max(MIN_CHAT_PCT, dragState.current.startRatio + dpct));
    chatRatioRef.current = clamped;
    setChatRatio(clamped);
  }, []);

  const handleSplitPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (activeTabId) {
      savedRatios.current.set(activeTabId, chatRatioRef.current);
    }
    dragState.current = null;
    setIsDragging(false);
  }, [activeTabId]);

  const hasActiveTab = activeTabId != null && activeTabFolder;
  const isEmptySession = tabMessageCount === 0;

  // If onboarding is visible, show wizard instead
  if (onboardingVisible) {
    return (
      <OnboardingWizard
        onComplete={() => {
          setOnboardingVisible(false);
        }}
        onCancel={() => {
          setOnboardingVisible(false);
          setView("home");
        }}
      />
    );
  }

  return (
    <div className="bg-ridge flex h-full w-full flex-col">
      <TabBar />
      <TabSwitcher />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Settings takes full width, no sidebar */}
        {view === "settings" ? (
          <div className="flex min-w-0 flex-1 overflow-hidden">
            <ErrorBoundary>
              <SettingsView />
            </ErrorBoundary>
          </div>
        ) : (
          <>
            {/* Thin navigation sidebar */}
            <nav className="bg-surface/40 flex w-14 shrink-0 flex-col items-center border-r border-white/[0.06] py-3 gap-1">
              <button
                onClick={() => setView("home")}
                aria-label="Home"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg transition",
                  view === "home"
                    ? "text-text bg-white/[0.08]"
                    : "text-dim hover:text-text hover:bg-white/[0.04]",
                )}
              >
                <LayoutGrid size={16} />
              </button>

              <button
                onClick={() => setOnboardingVisible(true)}
                aria-label="New project"
                className="text-dim hover:text-text flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
                title="New project"
              >
                <Sparkles size={16} />
              </button>

              <div className="mt-auto" />
              <button
                onClick={() => setView("settings")}
                aria-label="Settings"
                className="text-dim hover:text-text flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
                title="Settings"
              >
                <Settings size={16} />
              </button>
            </nav>

            {/* Content area */}
            {view === "home" || !hasActiveTab ? (
              <div className="flex min-w-0 flex-1 flex-col items-stretch overflow-hidden">
                <RookieHomeView />
              </div>
            ) : (
              /* Split layout: chat | preview */
              <div ref={splitContainerRef} className="flex min-w-0 flex-1">
                {/* Chat side */}
                <div
                  className="flex shrink-0 flex-col border-r border-white/[0.06]"
                  style={{ width: `${chatRatio}%` }}
                >
                  {isEmptySession ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="flex-1 overflow-hidden">
                        <NewSessionView />
                      </div>
                      <StatusBar />
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="flex-1 overflow-hidden">
                        <ChatView />
                      </div>

                      <div className="bg-surface/50 border-t border-white/[0.06] px-4 pt-3 pb-4">
                        <ErrorBoundary>
                          <Composer key={activeTabId} />
                        </ErrorBoundary>
                      </div>

                      <StatusBar />
                    </div>
                  )}
                </div>

                {/* Drag handle */}
                <div
                  role="separator"
                  tabIndex={-1}
                  aria-label="Resize panels"
                  aria-orientation="vertical"
                  onPointerDown={handleSplitPointerDown}
                  onPointerMove={handleSplitPointerMove}
                  onPointerUp={handleSplitPointerUp}
                  onPointerCancel={handleSplitPointerUp}
                  className={cn(
                    "group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center",
                    "before:absolute before:inset-x-[-4px] before:inset-y-0",
                    "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-white/[0.06] after:transition-colors",
                    "hover:after:bg-white/[0.14]",
                    isDragging && "after:bg-white/[0.2]",
                  )}
                >
                  <GripVertical
                    size={12}
                    className="text-ghost relative z-10 opacity-0 transition-opacity group-hover:opacity-60"
                  />
                </div>

                {/* Preview side */}
                <div className="flex flex-1 flex-col overflow-hidden">
                  <PreviewPane
                    folderPath={activeTabFolder ?? ""}
                    projectRoot={activeTabProjectRoot}
                    tabId={activeTabId}
                    isWorktree={Boolean(activeTabWorktree)}
                    setup={activeTabSetup}
                    onPublish={handleOpenPublish}
                    splitDragging={isDragging}
                    publishOpen={publishOpen}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Model selector — available in all modes */}
      <ModelSelector />

      <PublishDialog
        open={publishOpen}
        onClose={handleClosePublish}
        folderPath={activeTabFolder ?? ""}
        projectName={activeTabFolder ? activeTabFolder.split("/").pop() : undefined}
      />
    </div>
  );
}
