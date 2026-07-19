import { Button } from "@herman/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@herman/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { getLogger } from "@logtape/logtape";
import { ChevronDown, HelpCircle, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { Message } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";

const logger = getLogger(["herman-desktop", "view", "revert-dock"]);

function logAbortFailure(tabId: string, error: unknown) {
  logger.warning("Failed to abort agent during revert", {
    tabId,
    error: error instanceof Error ? error.message : String(error),
  });
}

type RevertDockProps = {
  tabId: string;
  revertMessageId: string;
  messages: Message[];
  diffSummary?: string;
};

function previewText(message: Message): string {
  if (message.role !== "user") return "";
  const firstLine = message.content.split("\n")[0] ?? message.content;
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

function countChangedFiles(diffSummary?: string): number {
  if (!diffSummary?.trim()) return 0;
  return diffSummary
    .split("\n")
    .filter((line) => line.startsWith("diff ") || line.startsWith("--- ")).length;
}

export function RevertDock({ tabId, revertMessageId, messages, diffSummary }: RevertDockProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [restoring, setRestoring] = useState<string | undefined>(undefined);
  const [committing, setCommitting] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const revertedUserMessages = useMemo(() => {
    const revertIdx = messages.findIndex((m) => m.id === revertMessageId);
    if (revertIdx === -1) return [];
    return messages.slice(revertIdx).filter((m) => m.role === "user");
  }, [messages, revertMessageId]);

  const firstRevertedId = revertedUserMessages[0]?.id;
  const prevFirstRef = useRef(firstRevertedId);
  useEffect(() => {
    if (firstRevertedId !== prevFirstRef.current) {
      prevFirstRef.current = firstRevertedId;
      setCollapsed(true);
      setError(undefined);
    }
  }, [firstRevertedId]);

  if (revertedUserMessages.length === 0) return null;

  const total = revertedUserMessages.length;
  const label = total === 1 ? "Undo in progress" : `Undo in progress (${total} messages)`;
  const firstMsg = revertedUserMessages[0];
  const preview = firstMsg ? previewText(firstMsg) : "";
  const disabled = !!restoring || committing;
  const fileCount = countChangedFiles(diffSummary);

  const toggle = useCallback(() => setCollapsed((prev) => !prev), []);

  const snapshotRevertState = useCallback(() => {
    const store = useAgentStore.getState();
    const tab = store.tabs[tabId];
    return {
      prevRevertMessageId: tab?.revertMessageId,
      prevRevertSafetyCheckpointId: tab?.revertSafetyCheckpointId,
      prevComposerValue: tab?.composerValue ?? "",
      prevMessages: tab?.messages ?? [],
      prevDiffSummary: tab?.revertDiffSummary,
    };
  }, [tabId]);

  const rollbackRevertState = useCallback(
    (snapshot: ReturnType<typeof snapshotRevertState>) => {
      useAgentStore.getState().updateTab(tabId, {
        revertMessageId: snapshot.prevRevertMessageId,
        revertSafetyCheckpointId: snapshot.prevRevertSafetyCheckpointId,
        messages: snapshot.prevMessages,
        composerValue: snapshot.prevComposerValue,
        revertDiffSummary: snapshot.prevDiffSummary,
      });
    },
    [tabId],
  );

  const handleRestore = useCallback(
    async (messageId: string) => {
      if (restoring || committing) return;
      setRestoring(messageId);
      setError(undefined);

      const snapshot = snapshotRevertState();
      const clickedIdx = messages.findIndex((m) => m.id === messageId);
      if (clickedIdx === -1) {
        setRestoring(undefined);
        return;
      }

      try {
        let nextUser: Message | undefined;
        for (let i = clickedIdx + 1; i < messages.length; i++) {
          if (messages[i]?.role === "user") {
            nextUser = messages[i] as Message;
            break;
          }
        }

        await desktopRpc.request
          .abortAgent({ tabId })
          .catch((error) => logAbortFailure(tabId, error));
        const store = useAgentStore.getState();

        if (nextUser && nextUser.role === "user") {
          store.revertTab(tabId, nextUser.id);
          store.setComposerValue(tabId, nextUser.content);

          const nextIdx = store.tabs[tabId]?.messages.findIndex((m) => m.id === nextUser.id);
          if (nextIdx !== undefined && nextIdx !== -1) {
            const { tab, diffSummary: nextDiff } = await desktopRpc.request.revertTab({
              tabId,
              messageIndex: nextIdx,
            });
            store.updateTab(tabId, {
              messages: tab.messages,
              revertMessageId: tab.revertMessageId,
              revertSafetyCheckpointId: tab.revertSafetyCheckpointId,
              revertDiffSummary: nextDiff,
            });
          }
        } else {
          store.unrevertTab(tabId);
          store.setComposerValue(tabId, "");

          const { tab } = await desktopRpc.request.unrevertTab({ tabId });
          store.updateTab(tabId, {
            messages: tab.messages,
            revertMessageId: tab.revertMessageId,
            revertSafetyCheckpointId: tab.revertSafetyCheckpointId,
            revertDiffSummary: undefined,
          });
        }
      } catch (err) {
        rollbackRevertState(snapshot);
        const message = err instanceof Error ? err.message : "Could not update the undo.";
        setError(message);
        toast.error(message);
      } finally {
        setRestoring(undefined);
      }
    },
    [tabId, messages, restoring, committing, snapshotRevertState, rollbackRevertState],
  );

  const handleCancelRevert = useCallback(async () => {
    if (restoring || committing) return;
    setRestoring("__all__");
    setError(undefined);

    const snapshot = snapshotRevertState();
    try {
      await desktopRpc.request
        .abortAgent({ tabId })
        .catch((error) => logAbortFailure(tabId, error));
      const store = useAgentStore.getState();
      store.unrevertTab(tabId);
      store.setComposerValue(tabId, "");

      const { tab } = await desktopRpc.request.unrevertTab({ tabId });
      store.updateTab(tabId, {
        messages: tab.messages,
        revertMessageId: tab.revertMessageId,
        revertSafetyCheckpointId: tab.revertSafetyCheckpointId,
        revertDiffSummary: undefined,
      });
      toast.success("Messages and files restored.");
    } catch (err) {
      rollbackRevertState(snapshot);
      const message = err instanceof Error ? err.message : "Could not cancel the undo.";
      setError(message);
      toast.error(message);
    } finally {
      setRestoring(undefined);
    }
  }, [tabId, restoring, committing, snapshotRevertState, rollbackRevertState]);

  const handleCommitRevert = useCallback(async () => {
    if (restoring || committing) return;
    setCommitting(true);
    setError(undefined);
    setDiscardOpen(false);

    const snapshot = snapshotRevertState();
    try {
      await desktopRpc.request
        .abortAgent({ tabId })
        .catch((error) => logAbortFailure(tabId, error));
      const store = useAgentStore.getState();

      const tab = store.tabs[tabId];
      if (!tab) return;
      const revertIdx = tab.messages.findIndex((m) => m.id === revertMessageId);
      if (revertIdx === -1) return;

      store.updateTab(tabId, {
        messages: tab.messages.slice(0, revertIdx),
        revertMessageId: undefined,
        revertSafetyCheckpointId: undefined,
        composerValue: "",
        revertDiffSummary: undefined,
      });

      const { tab: synced } = await desktopRpc.request.commitRevertTab({
        tabId,
        messageIndex: revertIdx,
      });
      store.updateTab(tabId, {
        messages: synced.messages,
        revertMessageId: synced.revertMessageId,
        revertSafetyCheckpointId: synced.revertSafetyCheckpointId,
      });
      toast.success("Undo confirmed.");
    } catch (err) {
      rollbackRevertState(snapshot);
      const message = err instanceof Error ? err.message : "Could not confirm the undo.";
      setError(message);
      toast.error(message);
    } finally {
      setCommitting(false);
    }
  }, [tabId, restoring, committing, revertMessageId, snapshotRevertState, rollbackRevertState]);

  return (
    <>
      <div
        data-component="revert-dock"
        className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04]"
      >
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-white/[0.03]"
        >
          <span className="font-medium whitespace-nowrap text-amber-400">{label}</span>
          {collapsed && preview && (
            <span className="text-dim min-w-0 flex-1 truncate text-left">{preview}</span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="text-dim text-xs">
              {collapsed
                ? "Edit your question below and send to confirm, or cancel."
                : `${total} hidden`}
            </span>
            <ChevronDown
              size={14}
              className="text-dim transition-transform"
              style={{ transform: collapsed ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </div>
        </button>

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
                {error && <p className="text-red-400 mb-2 text-xs leading-relaxed">{error}</p>}

                {fileCount > 0 && (
                  <p className="text-dim mb-2 text-xs leading-relaxed">
                    {fileCount} {fileCount === 1 ? "file was" : "files were"} rolled back in this
                    session&apos;s preview copy.
                  </p>
                )}

                {diffSummary && (
                  <div className="mb-2 rounded-md border border-amber-500/15 bg-amber-500/[0.03] px-2.5 py-1.5">
                    <pre className="text-faint max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
                      {diffSummary}
                    </pre>
                  </div>
                )}

                {revertedUserMessages.map((message, idx) => (
                  <div key={message.id} className="flex items-center gap-2 py-1">
                    <span className="text-dim flex shrink-0 items-center justify-center rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                      {idx + 1}
                    </span>
                    <span className="text-text min-w-0 flex-1 truncate text-xs">
                      {previewText(message)}
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => void handleRestore(message.id)}
                            disabled={disabled}
                            className="text-signal hover:text-signal/80 disabled:opacity-40 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/[0.06]"
                          />
                        }
                      >
                        <RotateCcw size={11} />
                        Bring back
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Bring this message back without undoing earlier ones
                      </TooltipContent>
                    </Tooltip>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => void handleCancelRevert()}
                        disabled={disabled}
                        className="text-dim hover:text-text disabled:opacity-40 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/[0.06]"
                      />
                    }
                  >
                    <Undo2 size={12} />
                    Keep my messages &amp; files
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Cancel the undo and restore your hidden messages and files
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="text-faint hover:text-dim inline-flex h-7 w-7 items-center justify-center rounded-md"
                      />
                    }
                  >
                    <HelpCircle size={13} />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    Send an edited question below to confirm the undo, or use &ldquo;Keep my
                    messages &amp; files&rdquo; to go back.
                  </TooltipContent>
                </Tooltip>

                <div className="flex-1" />

                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={disabled}
                  onClick={() => setDiscardOpen(true)}
                >
                  <Trash2 size={12} />
                  Remove {total} {total === 1 ? "message" : "messages"} permanently
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove these messages permanently?</DialogTitle>
            <DialogDescription className="text-left leading-relaxed">
              This will permanently delete {total} hidden {total === 1 ? "message" : "messages"}.
              Your rolled-back files will stay as they are now.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDiscardOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={committing}
              onClick={() => void handleCommitRevert()}
            >
              Remove permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
