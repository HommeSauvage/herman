import { motion } from "motion/react";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { Message } from "../../../shared/rpc.js";
import type { TabId } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useIsHermanProvider } from "../lib/model-utils.js";
import {
  computeRenderItems,
  useStableRenderItems,
  type RenderItem,
} from "../lib/render-items.js";
import { ContextToolGroup } from "./context-tool-group.js";
import { MessageItem } from "./message-item.js";
import { NativeAdMessage } from "./native-ad-message.js";
import { ThinkingRow } from "./thinking-row.js";

const EMPTY_THINKING: Message[] = [];

export function MessageList({
  messages,
  isThinking,
  tabId,
}: {
  messages: Message[];
  isThinking: boolean;
  tabId?: TabId;
}) {
  const revertMessageId = useAgentStore(
    useShallow((s) =>
      tabId ? s.tabs[tabId]?.revertMessageId : undefined,
    ),
  );
  const nativeAds = useAgentStore(
    useShallow((s) =>
      tabId ? (s.tabs[tabId]?.nativeAds ?? []) : [],
    ),
  );
  const isHermanProvider = useIsHermanProvider();

  // ---- Show thinking (per-tab) -----------------------------------------

  const { showThinking, thinkingMessages } = useAgentStore(
    useShallow((s) => {
      if (!tabId) return { showThinking: false, thinkingMessages: EMPTY_THINKING };
      const tab = s.tabs[tabId];
      return {
        showThinking: tab?.showThinking ?? false,
        thinkingMessages: tab?.showThinking ? tab?.thinkingMessages ?? EMPTY_THINKING : EMPTY_THINKING,
      };
    }),
  );

  // ---- Visible messages (respect revert boundary) ----------------------

  const visibleMessages = useMemo(() => {
    if (!revertMessageId) return messages;
    const revertIdx = messages.findIndex((m) => m.id === revertMessageId);
    if (revertIdx === -1) return messages;
    return messages.slice(0, revertIdx);
  }, [messages, revertMessageId]);

  // ---- Revert-eligible user messages ----------------------------------

  const revertableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of visibleMessages) {
      if (msg.role === "user") ids.add(msg.id);
    }
    return ids;
  }, [visibleMessages]);

  // ---- Revert handler -------------------------------------------------

  const handleRevert = useCallback(
    async (messageId: string) => {
      if (!tabId) return;
      try {
        // Abort if running.
        await desktopRpc.request.abortAgent({ tabId }).catch(() => {});

        const state = useAgentStore.getState();
        const tab = state.tabs[tabId];
        if (!tab) return;
        const messageIndex = tab.messages.findIndex(
          (m) => m.id === messageId,
        );
        if (messageIndex === -1) return;
        const targetMessage = tab.messages[messageIndex];
        if (!targetMessage || targetMessage.role !== "user") return;

        // Optimistic update.
        state.revertTab(tabId, messageId);
        state.setComposerValue(tabId, targetMessage.content);

        // Sync with main process.
        const { tab: synced, diffSummary } =
          await desktopRpc.request.revertTab({
            tabId,
            messageIndex,
          });
        state.updateTab(tabId, {
          messages: synced.messages,
          revertMessageId: synced.revertMessageId,
          revertDiffSummary: diffSummary,
        });
      } catch {
        const store = useAgentStore.getState();
        store.unrevertTab(tabId);
        store.setComposerValue(tabId, "");
        store.updateTab(tabId, { revertDiffSummary: undefined });
      }
    },
    [tabId],
  );

  // ---- Render items ---------------------------------------------------

  const rawItems = useMemo(() => {
    const items = computeRenderItems(visibleMessages, thinkingMessages, showThinking);
    // Attach revert props to eligible user messages.
    for (const item of items) {
      if (
        item.type === "message" &&
        item.message.role === "user" &&
        revertableIds.has(item.message.id)
      ) {
        item.showRevert = true;
        item.onRevert = () => void handleRevert(item.message.id);
      }
    }
    return items;
  }, [visibleMessages, revertableIds, handleRevert, thinkingMessages, showThinking]);
  const items = useStableRenderItems(rawItems);

  const visibleNativeAds = isHermanProvider ? nativeAds : [];

  // Only show the generic "Thinking" shimmer when we are not already
  // rendering the live thinking stream and before the first assistant message.
  const hasAssistantMessage = visibleMessages.some(
    (m) => m.role === "assistant",
  );
  const showThinkingRow = isThinking && !hasAssistantMessage && !showThinking;

  // ---- Render ---------------------------------------------------------

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {items.map((item) =>
        item.type === "context-group" ? (
          <motion.div
            key={item.key}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="min-w-0"
            style={{ contain: "layout style" }}
          >
            <ContextToolGroup tools={item.tools} />
          </motion.div>
        ) : (
          <motion.div
            key={item.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="min-w-0"
            style={{ contain: "layout style" }}
          >
            <MessageItem
              message={item.message}
              showRevert={item.showRevert}
              onRevert={item.onRevert}
            />
          </motion.div>
        ),
      )}
      {showThinkingRow && <ThinkingRow />}
      {tabId &&
        visibleNativeAds.map((campaign, index) => (
          <NativeAdMessage
            key={`${campaign.id}-${index}`}
            campaign={campaign}
          />
        ))}
    </div>
  );
}
