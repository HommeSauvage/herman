import { ChevronDown, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Message } from "../../../shared/rpc.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useAgentStore } from "../lib/agent-store.js";

type RevertDockProps = {
  tabId: string;
  revertMessageId: string;
  messages: Message[];
  diffSummary?: string;
};

/**
 * Extract a single-line preview of a user message for the revert dock.
 */
function previewText(message: Message): string {
  if (message.role !== "user") return "";
  const firstLine = message.content.split("\n")[0] ?? message.content;
  return firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
}

/**
 * Shows reverted messages with an expand/collapse toggle and per-message restore controls.
 *
 * Based on OpenCode's `SessionRevertDock`, this component:
 * 1. Shows a summary of how many messages were reverted
 * 2. Allows restoring individual messages (moving the revert boundary forward)
 * 3. Allows cancelling the entire revert (bringing all messages back)
 * 4. Allows committing the revert (permanently removing reverted messages)
 */
export function RevertDock({ tabId, revertMessageId, messages, diffSummary }: RevertDockProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [restoring, setRestoring] = useState<string | undefined>(undefined);
  const [committing, setCommitting] = useState(false);

  // Reverted user messages: those at or after the revert point.
  const revertedUserMessages = useMemo(() => {
    const revertIdx = messages.findIndex((m) => m.id === revertMessageId);
    if (revertIdx === -1) return [];
    return messages.slice(revertIdx).filter((m) => m.role === "user");
  }, [messages, revertMessageId]);

  // Track the first reverted user message ID to auto-collapse on revert change.
  const firstRevertedId = revertedUserMessages[0]?.id;
  const prevFirstRef = useRef(firstRevertedId);
  useEffect(() => {
    if (firstRevertedId !== prevFirstRef.current) {
      prevFirstRef.current = firstRevertedId;
      setCollapsed(true);
    }
  }, [firstRevertedId]);

  if (revertedUserMessages.length === 0) return null;

  const total = revertedUserMessages.length;
  const label =
    total === 1 ? "1 message reverted" : `${total} messages reverted`;
  const preview = previewText(revertedUserMessages[0]!);
  const disabled = !!restoring || committing;

  const toggle = useCallback(() => setCollapsed((prev) => !prev), []);

  /**
   * Save current revert state so we can roll back if the RPC fails.
   * Returns a function that restores the saved state.
   */
  const snapshotRevertState = useCallback(() => {
    const store = useAgentStore.getState();
    const tab = store.tabs[tabId];
    return {
      prevRevertMessageId: tab?.revertMessageId,
      prevComposerValue: tab?.composerValue ?? "",
      prevMessages: tab?.messages ?? [],
    };
  }, [tabId]);

  /**
   * Roll back the store to a previously captured state.
   */
  const rollbackRevertState = useCallback(
    (snapshot: ReturnType<typeof snapshotRevertState>) => {
      useAgentStore.getState().updateTab(tabId, {
        revertMessageId: snapshot.prevRevertMessageId,
        messages: snapshot.prevMessages,
        composerValue: snapshot.prevComposerValue,
      });
    },
    [tabId],
  );

  /**
   * Restore a single reverted message by moving the revert boundary
   * to the next user message. If this is the last reverted message,
   * clear the revert entirely (bring everything back).
   *
   * This also populates the composer with the message being restored to,
   * so the user can edit and resend it (matches OpenCode's undo/redo).
   */
  const handleRestore = useCallback(
    async (messageId: string) => {
      if (restoring || committing) return;
      setRestoring(messageId);

      const snapshot = snapshotRevertState();
      const clickedIdx = messages.findIndex((m) => m.id === messageId);
      if (clickedIdx === -1) {
        setRestoring(undefined);
        return;
      }

      try {
        // Find the next user message after this one in the full messages list.
        let nextUser: Message | undefined;
        for (let i = clickedIdx + 1; i < messages.length; i++) {
          if (messages[i]?.role === "user") {
            nextUser = messages[i]!;
            break;
          }
        }

        const store = useAgentStore.getState();
        await desktopRpc.request.abortAgent({ tabId }).catch(() => {});

        if (nextUser && nextUser.role === "user") {
          // Move the revert boundary forward to the next user message.
          store.revertTab(tabId, nextUser.id);

          // Populate composer with the newly-hidden message so the user can
          // edit and resend it (matches OpenCode's undo/redo behaviour).
          store.setComposerValue(tabId, nextUser.content);

          // Sync with main process.
          const nextIdx = store.tabs[tabId]?.messages.findIndex((m) => m.id === nextUser.id);
          if (nextIdx !== undefined && nextIdx !== -1) {
            const { tab, diffSummary: nextDiff } = await desktopRpc.request.revertTab({ tabId, messageIndex: nextIdx });
            store.updateTab(tabId, {
              messages: tab.messages,
              revertMessageId: tab.revertMessageId,
              revertDiffSummary: nextDiff,
            });
          }
        } else {
          // This is the last reverted message — clear the revert entirely.
          store.unrevertTab(tabId);
          // Clear composer since everything is back to normal.
          store.setComposerValue(tabId, "");

          const { tab } = await desktopRpc.request.unrevertTab({ tabId });
          store.updateTab(tabId, {
            messages: tab.messages,
            revertMessageId: tab.revertMessageId,
            revertDiffSummary: undefined,
          });
        }
      } catch {
        rollbackRevertState(snapshot);
      } finally {
        setRestoring(undefined);
      }
    },
    [tabId, messages, restoring, committing, snapshotRevertState, rollbackRevertState],
  );

  /**
   * Cancel the revert entirely — bring all reverted messages back.
   * This is the "unrevert" operation.
   */
  const handleCancelRevert = useCallback(async () => {
    if (restoring || committing) return;
    setRestoring("__all__");

    const snapshot = snapshotRevertState();
    try {
      await desktopRpc.request.abortAgent({ tabId }).catch(() => {});
      const store = useAgentStore.getState();
      store.unrevertTab(tabId);
      // Clear composer since everything is back to normal.
      store.setComposerValue(tabId, "");

      const { tab } = await desktopRpc.request.unrevertTab({ tabId });
      store.updateTab(tabId, {
        messages: tab.messages,
        revertMessageId: tab.revertMessageId,
        revertDiffSummary: undefined,
      });
    } catch {
      rollbackRevertState(snapshot);
    } finally {
      setRestoring(undefined);
    }
  }, [tabId, restoring, committing, snapshotRevertState, rollbackRevertState]);

  /**
   * Commit the revert — permanently remove the reverted messages.
   * This is the "discard" operation.
   */
  const handleCommitRevert = useCallback(async () => {
    if (restoring || committing) return;
    setCommitting(true);

    const snapshot = snapshotRevertState();
    try {
      await desktopRpc.request.abortAgent({ tabId }).catch(() => {});
      const store = useAgentStore.getState();

      const tab = store.tabs[tabId];
      if (!tab) return;
      const revertIdx = tab.messages.findIndex((m) => m.id === revertMessageId);
      if (revertIdx === -1) return;

      // Optimistic: prune messages locally.
      store.updateTab(tabId, {
        messages: tab.messages.slice(0, revertIdx),
        revertMessageId: undefined,
        composerValue: "",
      });

      const { tab: synced } = await desktopRpc.request.commitRevertTab({
        tabId,
        messageIndex: revertIdx,
      });
      store.updateTab(tabId, {
        messages: synced.messages,
        revertMessageId: synced.revertMessageId,
      });
    } catch {
      rollbackRevertState(snapshot);
    } finally {
      setCommitting(false);
    }
  }, [tabId, restoring, committing, revertMessageId, snapshotRevertState, rollbackRevertState]);

  return (
    <div
      data-component="revert-dock"
      className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04]"
    >
      {/* Header row */}
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-amber-400 font-medium whitespace-nowrap">{label}</span>
        {collapsed && preview && (
          <span className="text-dim min-w-0 flex-1 truncate text-left">
            {preview}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-dim text-xs">
            {collapsed ? `Edit the last visible message and send to confirm` : `${total} hidden`}
          </span>
          <ChevronDown
            size={14}
            className="text-dim transition-transform"
            style={{ transform: collapsed ? "rotate(180deg)" : "rotate(0deg)" }}
          />
        </div>
      </button>

      {/* Expanded list */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="max-h-48 overflow-y-auto px-3 pb-2">
              {/* File changes summary */}
              {diffSummary && (
                <div className="mb-2 rounded-md border border-amber-500/15 bg-amber-500/[0.03] px-2.5 py-1.5">
                  <pre className="text-faint whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
                    {diffSummary}
                  </pre>
                </div>
              )}
              {revertedUserMessages.map((message, idx) => (
                <div
                  key={message.id}
                  className="flex items-center gap-2 py-1"
                >
                  <span className="text-dim flex shrink-0 items-center justify-center rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="text-text min-w-0 flex-1 truncate text-xs">
                    {previewText(message)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRestore(message.id)}
                    disabled={disabled}
                    className="text-signal hover:text-signal/80 disabled:opacity-40 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/[0.06]"
                  >
                    <RotateCcw size={11} />
                    Restore
                  </button>
                </div>
              ))}
            </div>

            {/* Footer actions */}
            <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2">
              <button
                type="button"
                onClick={() => void handleCancelRevert()}
                disabled={disabled}
                className="text-dim hover:text-text disabled:opacity-40 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/[0.06]"
              >
                <Undo2 size={12} />
                Cancel revert
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => void handleCommitRevert()}
                disabled={disabled}
                className="text-red-400 hover:text-red-300 disabled:opacity-40 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-red-500/10"
              >
                <Trash2 size={12} />
                Discard {total} {total === 1 ? "message" : "messages"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
