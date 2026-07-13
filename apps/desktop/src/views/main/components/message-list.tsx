import { motion } from "motion/react";
import { getLogger } from "@logtape/logtape";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";

import type { Message } from "../../../shared/rpc.js";
import type { TabId } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useIsHermanProvider } from "../lib/model-utils.js";
import {
  computeRenderItems,
  useStableRenderItems,
} from "../lib/render-items.js";
import { ContextToolGroup } from "./context-tool-group.js";
import { MessageItem } from "./message-item.js";
import { NativeAdMessage } from "./native-ad-message.js";
import { ThinkingRow } from "./thinking-row.js";
import { UndoConfirmDialog } from "./undo-confirm-dialog.js";

const EMPTY_THINKING: Message[] = [];
const logger = getLogger(["herman-desktop", "view", "message-list"]);

export function MessageList({
  messages,
  isThinking,
  tabId,
  revertEnabled = false,
}: {
  messages: Message[];
  isThinking: boolean;
  tabId?: TabId;
  revertEnabled?: boolean;
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

  const visibleMessages = useMemo(() => {
    if (!revertMessageId) return messages;
    const revertIdx = messages.findIndex((m) => m.id === revertMessageId);
    if (revertIdx === -1) return messages;
    return messages.slice(0, revertIdx);
  }, [messages, revertMessageId]);

  const revertableIds = useMemo(() => {
    if (!revertEnabled) return new Set<string>();
    const ids = new Set<string>();
    for (const msg of visibleMessages) {
      if (msg.role === "user") ids.add(msg.id);
    }
    return ids;
  }, [visibleMessages, revertEnabled]);

  const [pendingUndo, setPendingUndo] = useState<{
    messageId: string;
    messageIndex: number;
    preview: string;
  } | null>(null);

  const executeRevert = useCallback(
    async (messageId: string) => {
      if (!tabId) return;
      try {
        await desktopRpc.request.abortAgent({ tabId }).catch((error) => {
          logger.warning("Failed to abort agent from message list", {
            tabId,
            error: error instanceof Error ? error.message : String(error),
          });
        });

        const state = useAgentStore.getState();
        const tab = state.tabs[tabId];
        if (!tab) return;
        const messageIndex = tab.messages.findIndex((m) => m.id === messageId);
        if (messageIndex === -1) return;
        const targetMessage = tab.messages[messageIndex];
        if (!targetMessage || targetMessage.role !== "user") return;

        state.revertTab(tabId, messageId);
        state.setComposerValue(tabId, targetMessage.content);

        const { tab: synced, diffSummary } = await desktopRpc.request.revertTab({
          tabId,
          messageIndex,
        });
        state.updateTab(tabId, {
          messages: synced.messages,
          revertMessageId: synced.revertMessageId,
          revertSafetyCheckpointId: synced.revertSafetyCheckpointId,
          revertDiffSummary: diffSummary,
        });
        setPendingUndo(null);
      } catch (err) {
        const store = useAgentStore.getState();
        store.unrevertTab(tabId);
        store.setComposerValue(tabId, "");
        store.updateTab(tabId, {
          revertDiffSummary: undefined,
          revertSafetyCheckpointId: undefined,
        });
        const message = err instanceof Error ? err.message : "Could not undo from here.";
        toast.error(message);
        setPendingUndo(null);
      }
    },
    [tabId],
  );

  const handleUndoRequest = useCallback(
    (messageId: string) => {
      if (!tabId || !revertEnabled) return;
      const tab = useAgentStore.getState().tabs[tabId];
      if (!tab) return;
      const messageIndex = tab.messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) return;
      const targetMessage = tab.messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user") return;
      const preview = targetMessage.content.split("\n")[0] ?? targetMessage.content;
      setPendingUndo({
        messageId,
        messageIndex,
        preview: preview.length > 120 ? `${preview.slice(0, 120)}…` : preview,
      });
    },
    [tabId, revertEnabled],
  );

  const rawItems = useMemo(() => {
    const items = computeRenderItems(visibleMessages, thinkingMessages, showThinking);
    for (const item of items) {
      if (
        item.type === "message" &&
        item.message.role === "user" &&
        revertableIds.has(item.message.id)
      ) {
        item.showRevert = true;
        item.onRevert = () => handleUndoRequest(item.message.id);
      }
    }
    return items;
  }, [visibleMessages, revertableIds, handleUndoRequest, thinkingMessages, showThinking]);
  const items = useStableRenderItems(rawItems);

  const visibleNativeAds = isHermanProvider ? nativeAds : [];

  const hasAssistantMessage = visibleMessages.some((m) => m.role === "assistant");
  const showThinkingRow = isThinking && !hasAssistantMessage && !showThinking;

  return (
    <>
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
            <NativeAdMessage key={`${campaign.id}-${index}`} campaign={campaign} />
          ))}
      </div>

      {tabId && pendingUndo && (
        <UndoConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingUndo(null);
          }}
          tabId={tabId}
          messageIndex={pendingUndo.messageIndex}
          messagePreview={pendingUndo.preview}
          onConfirm={() => void executeRevert(pendingUndo.messageId)}
        />
      )}
    </>
  );
}
