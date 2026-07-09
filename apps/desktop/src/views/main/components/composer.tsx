import { getLogger } from "@logtape/logtape";
import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import type { PendingAttachment, QueuedFollowUp, TabId } from "../../../shared/rpc.js";
import { useFileMention } from "../hooks/use-file-mention.js";
import { useSlashCommand } from "../hooks/use-slash-command.js";
import { useComposerDraftSync } from "../hooks/use-composer-draft-sync.js";
import { useComposerTextarea } from "../hooks/use-composer-textarea.js";
import { sendPrompt } from "../lib/agent-actions.js";
import { isTabWorking, useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { AttachmentList } from "./attachment-list.js";
import { AttachButton } from "./attach-button.js";
import { ComposerInput } from "./composer-input.js";
import { ComposerActions } from "./composer-actions.js";
import { FileMentionPopover } from "./file-mention-popover.js";
import { QueuedFollowUps } from "./queued-follow-ups.js";
import { SlashCommandPopover } from "./slash-command-popover.js";

const logger = getLogger(["herman-desktop", "view", "composer"]);

// @refresh reset

/** Stable empty array used as a fallback when the active tab has no
 *  `pendingAttachments` field yet.  Re-using a hoisted reference (instead
 *  of returning a fresh `[]` literal from the selector) prevents the
 *  `getSnapshot should be cached` infinite-loop warning from React 18,
 *  which fires when a selector returns a new array reference on every
 *  call. */
const EMPTY_ATTACHMENTS: PendingAttachment[] = [];

export function Composer() {
  // ---- Store selectors ------------------------------------------------

  const { tabId, folderPath, composerValue, pendingAttachments } = useAgentStore(
    useShallow((s) => {
      const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
      return {
        tabId: tab?.id,
        folderPath: tab?.folderPath,
        composerValue: tab?.composerValue,
        pendingAttachments: tab?.pendingAttachments ?? EMPTY_ATTACHMENTS,
      };
    }),
  );
  const queuedMessages = useAgentStore(
    useShallow((s) =>
      s.activeTabId ? (s.tabs[s.activeTabId]?.queuedMessages ?? []) : [],
    ),
  );
  const queueMessage = useAgentStore((s) => s.queueMessage);
  const removeQueuedMessage = useAgentStore((s) => s.removeQueuedMessage);
  const dequeueMessage = useAgentStore((s) => s.dequeueMessage);
  const addAttachment = useAgentStore((s) => s.addAttachment);
  const removeAttachment = useAgentStore((s) => s.removeAttachment);

  // ---- Hooks ----------------------------------------------------------

  const draftSync = useComposerDraftSync(tabId);
  const mention = useFileMention(folderPath);
  const slash = useSlashCommand();

  const {
    textareaRef,
    hasText,
    mentionRef,
    slashRef,
    clearTextarea,
    commitMessage,
    restoreText,
    insertMention,
    handleInput,
    handleBlur,
  } = useComposerTextarea({
    tabId,
    composerValue,
    draftSync,
    mention,
    slash,
  });

  // ---- Shared refs ----------------------------------------------------

  const isWorkingRef = { current: false };

  // ---- Slash selection ------------------------------------------------

  const applySlashSelection = useCallback(
    (text: string) => {
      if (text === "") {
        clearTextarea();
        if (tabId) useAgentStore.getState().setComposerValue(tabId, "");
      } else {
        restoreText(text);
      }
    },
    [clearTextarea, tabId, restoreText],
  );

  // ---- Submission handlers --------------------------------------------

  const handleSubmit = useCallback(async () => {
    if (!tabId) return;
    const trimmed = (textareaRef.current?.value ?? "").trim();
    if (!trimmed || isWorkingRef.current) return;
    const text = commitMessage();
    await sendPrompt(tabId, text);
  }, [tabId, textareaRef, isWorkingRef, commitMessage]);

  const handleSteer = useCallback(async () => {
    if (!tabId) return;
    const trimmed = commitMessage();
    if (!trimmed) return;
    await sendPrompt(tabId, trimmed);
  }, [tabId, commitMessage]);

  const handleQueue = useCallback(() => {
    const trimmed = commitMessage();
    if (!trimmed || !tabId) return;
    queueMessage(tabId, trimmed);
  }, [commitMessage, tabId, queueMessage]);

  // ---- Queued message management --------------------------------------

  const handleQueueFlush = useCallback(
    (flushTabId: TabId) => {
      const next = dequeueMessage(flushTabId);
      if (!next) return;
      void sendPrompt(flushTabId, next.text);
    },
    [dequeueMessage],
  );

  // ---- File attachment handlers --------------------------------------

  const handleAttach = useCallback(async () => {
    if (!tabId) return;
    try {
      const { files } = await desktopRpc.request.openFilePicker({
        multiple: true,
        title: "Attach files",
        defaultPath: folderPath || undefined,
      });
      for (const file of files) {
        const attachment: PendingAttachment = {
          ...file,
          id: crypto.randomUUID(),
          addedAt: Date.now(),
        };
        addAttachment(tabId, attachment);
      }
    } catch (error) {
      // The user dismissing the dialog is not an error worth surfacing.
      // Log it for debugging but don't disrupt the composer.
      logger.error("openFilePicker failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [tabId, folderPath, addAttachment]);

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      if (!tabId) return;
      removeAttachment(tabId, id);
    },
    [tabId, removeAttachment],
  );

  /**
   * Handle paste events on the composer textarea.  If the clipboard
   * contains files (e.g. an image copied from Finder or a screenshot
   * tool), we route them to the attachment list instead of letting the
   * default text-paste behavior insert a useless file name into the
   * prompt.  Plain text pastes are passed through untouched.
   */
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      const files = Array.from(clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (files.length === 0) return;

      // The clipboard File objects don't carry an absolute path on
      // most platforms, so we can't satisfy the "send a path" promise
      // for arbitrary clipboard files.  We still turn them into
      // attachments by reading the contents as a data URL and using
      // the file name as the identifier — the chip can still be
      // rendered and removed by the user.
      event.preventDefault();

      if (!tabId) return;

      for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : undefined;
          if (!dataUrl) return;
          const attachment: PendingAttachment = {
            // No path available for clipboard files; we still record a
            // synthetic name so the chip can be rendered and removed.
            path: file.name,
            name: file.name,
            size: file.size,
            mime: file.type || "application/octet-stream",
            previewDataUrl: dataUrl.startsWith("data:") ? dataUrl : undefined,
            id: crypto.randomUUID(),
            addedAt: Date.now(),
          };
          addAttachment(tabId, attachment);
        };
        reader.readAsDataURL(file);
      }
    },
    [tabId, addAttachment],
  );

  const handleEditQueued = useCallback(
    (item: QueuedFollowUp) => {
      if (!tabId) return;
      removeQueuedMessage(tabId, item.id);
      restoreText(item.text);
    },
    [tabId, removeQueuedMessage, restoreText],
  );

  const handleRemoveQueued = useCallback(
    (id: string) => {
      if (!tabId) return;
      removeQueuedMessage(tabId, id);
    },
    [tabId, removeQueuedMessage],
  );

  // ---- Queue flush on mount (if queued messages already pending) ------

  // Must be after handleQueueFlush definition for closure to capture it.
  useEffect(() => {
    if (!tabId) return;
    const tab = useAgentStore.getState().tabs[tabId];
    if (!tab?.queuedMessages?.length) return;
    if (!isTabWorking(tab)) {
      handleQueueFlush(tabId);
    }
  }, [tabId, handleQueueFlush]);

  // ---- Keyboard handler -----------------------------------------------

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const slashState = slashRef.current;
      const mentionState = mentionRef.current;

      // Slash popover keyboard navigation (priority over mentions)
      if (slashState.open && slashState.totalItems > 0) {
        if (event.key === "Escape") {
          slashState.reset();
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowDown") {
          slashState.moveActive(1);
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowUp") {
          slashState.moveActive(-1);
          event.preventDefault();
          return;
        }
        const ctrl =
          event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (ctrl && (event.key === "n" || event.key === "p")) {
          slashState.moveActive(event.key === "n" ? 1 : -1);
          event.preventDefault();
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const selected = slashState.activeItem;
          if (selected) {
            const text = slashState.handleSelect(selected);
            if (text !== null) applySlashSelection(text);
          }
          event.preventDefault();
          return;
        }
      }

      // Mention popover keyboard navigation
      if (mentionState.open && mentionState.items.length > 0) {
        if (event.key === "Escape") {
          mentionState.reset();
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowDown") {
          mentionState.moveActive(1);
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowUp") {
          mentionState.moveActive(-1);
          event.preventDefault();
          return;
        }
        const ctrl =
          event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (ctrl && (event.key === "n" || event.key === "p")) {
          mentionState.moveActive(event.key === "n" ? 1 : -1);
          event.preventDefault();
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const selected = mentionState.activeItem;
          if (selected) insertMention(selected);
          event.preventDefault();
          return;
        }
      }

      // Enter key: submit / steer / queue
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (event.repeat) return;
        if (isWorkingRef.current && event.altKey) {
          handleQueue();
        } else if (isWorkingRef.current) {
          void handleSteer();
        } else {
          void handleSubmit();
        }
      }
    },
    [
      slashRef,
      mentionRef,
      insertMention,
      handleQueue,
      handleSteer,
      handleSubmit,
      applySlashSelection,
    ],
  );

  // ---- Render ---------------------------------------------------------

  return (
    <div className="flex w-full flex-col gap-2">
      <QueuedFollowUps
        items={queuedMessages}
        onEdit={handleEditQueued}
        onRemove={handleRemoveQueued}
      />
      <div className="bg-void border-white/[0.06] relative flex w-full flex-col gap-1.5 rounded-2xl border p-2 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] transition focus-within:border-signal/30 focus-within:shadow-[0_0_24px_rgba(34,197,94,0.08)]">
        <AttachmentList
          attachments={pendingAttachments}
          onRemove={handleRemoveAttachment}
          removeLabel="Remove attachment"
        />
        <div className="flex w-full items-end gap-2">
          <FileMentionPopover
            open={mention.open}
            folderPath={folderPath}
            items={mention.items}
            activeIndex={mention.activeIndex}
            loading={mention.loading}
            onSelect={insertMention}
            onHover={mention.setActiveIndex}
          />
          <SlashCommandPopover
            open={slash.open}
            commands={slash.commands}
            skills={slash.skills}
            activeSectionIndex={slash.activeSectionIndex}
            activeItemIndex={slash.activeItemIndex}
            onSelect={(item) => {
              const text = slash.handleSelect(item);
              if (text !== null) applySlashSelection(text);
            }}
            onHover={(sectionIndex, itemIndex) => {
              slash.setActiveHover(sectionIndex, itemIndex);
            }}
          />
          <AttachButton onAttach={handleAttach} label="Attach files" />
          <ComposerInput
            defaultValue={composerValue ?? ""}
            textareaRef={textareaRef}
            onInput={handleInput}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <ComposerActions
            tabId={tabId}
            hasText={hasText}
            queuedCount={queuedMessages.length}
            isWorkingRef={isWorkingRef}
            onQueue={handleQueue}
            onSteer={handleSteer}
            onSubmit={handleSubmit}
            onQueueFlush={handleQueueFlush}
          />
        </div>
      </div>
    </div>
  );
}
