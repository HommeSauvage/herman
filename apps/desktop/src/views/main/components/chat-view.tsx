import { motion, AnimatePresence } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAutoScroll } from "../hooks/use-auto-scroll.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsHermanProvider } from "../lib/model-utils.js";
import { ConnectionErrorBanner } from "./connection-error-banner.js";
import { EmptyState } from "./empty-state.js";
import { ErrorBanner } from "./error-banner.js";
import { MessageList } from "./message-list.js";
import { ProgressBar } from "./progress-bar.js";
import { RevertDock } from "./revert-dock.js";
import { ThinkingBanner } from "./thinking-banner.js";

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
    retryState,
  } = useAgentStore(
    useShallow((s) => {
      const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
      return {
        activeTabId: s.activeTabId,
        messages: tab?.messages ?? [],
        revertMessageId: tab?.revertMessageId,
        revertDiffSummary: tab?.revertDiffSummary,
        isThinking: tab?.isThinking ?? false,
        connectionState: tab?.connectionState ?? "idle",
        connectionError: tab?.connectionError,
        retryState: tab?.retryState,
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
      connectionError: undefined,
      retryState: undefined,
    });
  }, [activeTabId, updateTab]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking, scrollToBottom]);

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      {/* Connection error banner — always visible above the scroll area */}
      {activeTabId && (
        <ConnectionErrorBanner
          tabId={activeTabId}
          connectionState={connectionState}
          connectionError={connectionError}
          retryState={retryState}
          onDismiss={handleDismissError}
        />
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <ProgressBar />
        {isHermanProvider && (
          <div className="bg-surface/30 border-b border-white/[0.06] px-5 py-2.5">
            <ThinkingBanner />
          </div>
        )}
        {/* Inline error banner — visible inside the message flow */}
        {activeTabId &&
          (connectionError ||
            retryState ||
            connectionState === "crashed") && (
            <div className="pt-5">
              <ErrorBanner
                tabId={activeTabId}
                connectionState={connectionState}
                connectionError={connectionError}
                retryState={retryState}
                onDismiss={handleDismissError}
              />
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
                <EmptyState />
              ) : (
                <MessageList
                  messages={messages}
                  isThinking={isThinking}
                  tabId={activeTabId}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      {/* Revert dock pinned to the bottom of the scroll area */}
      {activeTabId && revertMessageId && (
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
