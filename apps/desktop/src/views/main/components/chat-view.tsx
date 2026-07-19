import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import type { Message } from "../../../shared/rpc.js";
import { useAutoScroll } from "../hooks/use-auto-scroll.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsHermanProvider } from "../lib/model-utils.js";
import { EmptyState, HydrationPendingState } from "./empty-state.js";
import { ErrorBanner } from "./error-banner.js";
import { MessageList } from "./message-list.js";
import { ProgressBar } from "./progress-bar.js";
import { ProjectToolsBanner } from "./project-tools-banner.js";
import { RevertDock } from "./revert-dock.js";
import { ThinkingBanner } from "./thinking-banner.js";

const EMPTY_MESSAGES: Message[] = []; // stable fallback for useShallow selector

/**
 * Auto-scrolls to the bottom while streaming, but respects when the user has
 * manually scrolled up. Based on OpenCode's `createAutoScroll`.
 */
export function ChatView() {
  // Single selector with shallow comparison — each field is compared
  // independently, so a change to `isThinking` won't re-render if
  // `messages` hasn't changed reference.
  const {
    activeTabId,
    messages,
    revertMessageId,
    revertDiffSummary,
    isThinking,
    connectionState,
    connectionError,
    connectionErrorDismissed,
    retryState,
    messagesHydrationStatus,
    revertEnabled,
  } = useAgentStore(
    useShallow((s) => {
      const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
      return {
        activeTabId: s.activeTabId,
        messages: tab?.messages ?? EMPTY_MESSAGES,
        messagesHydrationStatus: tab?.messagesHydrationStatus,
        revertMessageId: tab?.revertMessageId,
        revertDiffSummary: tab?.revertDiffSummary,
        isThinking: tab?.isThinking ?? false,
        connectionState: tab?.connectionState ?? "idle",
        connectionError: tab?.connectionError,
        connectionErrorDismissed: tab?.connectionErrorDismissed,
        retryState: tab?.retryState,
        revertEnabled: s.settings.mode === "rookie",
      };
    }),
  );

  const updateTab = useAgentStore((s) => s.updateTab);
  const isHermanProvider = useIsHermanProvider();

  const scrollRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useAutoScroll({ scrollRef });

  const handleDismissError = useCallback(() => {
    if (!activeTabId) return;
    updateTab(activeTabId, {
      // Mark the current error as dismissed instead of clearing it. This
      // prevents the polling fallback from immediately restoring it.
      connectionErrorDismissed: connectionError,
      retryState: undefined,
    });
  }, [activeTabId, connectionError, updateTab]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking, connectionError, retryState, scrollToBottom]);

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <ProgressBar />
        <ProjectToolsBanner />
        {isHermanProvider && (
          <div className="bg-surface/30 border-b border-white/[0.06] px-5 py-2.5">
            <ThinkingBanner />
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl px-5 pt-6 pb-8 md:px-6">
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={activeTabId ?? "empty"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {messages.length === 0 ? (
                messagesHydrationStatus === "pending" ? (
                  <HydrationPendingState />
                ) : (
                  <EmptyState />
                )
              ) : (
                <MessageList
                  messages={messages}
                  isThinking={isThinking}
                  tabId={activeTabId}
                  revertEnabled={revertEnabled}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        {/* Error banner — shown once, below the message flow */}
        {activeTabId &&
          ((connectionError && connectionError !== connectionErrorDismissed) || retryState) && (
            <div className="pb-6">
              <ErrorBanner
                tabId={activeTabId}
                connectionState={connectionState}
                connectionError={connectionError}
                retryState={retryState}
                onDismiss={handleDismissError}
              />
            </div>
          )}
      </div>
      {/* Revert dock pinned to the bottom of the scroll area */}
      {revertEnabled && activeTabId && revertMessageId && (
        <div className="mx-auto w-full max-w-3xl px-5 md:px-6">
          <RevertDock
            tabId={activeTabId}
            revertMessageId={revertMessageId}
            messages={messages}
            diffSummary={revertDiffSummary}
          />
        </div>
      )}
    </div>
  );
}
