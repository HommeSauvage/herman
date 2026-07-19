import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { TabId } from "../../../shared/rpc.js";
import { useAgentStore, useComposerValue } from "../lib/agent-store.js";
import { adjustTextareaHeight } from "../lib/composer-textarea-height.js";
import type { SlashCommandItem } from "./use-slash-command.js";

/** Regex patterns for trigger detection. */
const MENTION_TRIGGER = /(^|\s)@(\S*)$/;
const SLASH_TRIGGER = /^\/(\S*)$/;

function readHasText(textarea: HTMLTextAreaElement | null): boolean {
  return (textarea?.value.trim().length ?? 0) > 0;
}

type MentionState = {
  onInput: (query: string) => void;
  close: () => void;
  reset: () => void;
  open: boolean;
  items: string[];
  moveActive: (delta: number) => void;
  activeItem: string | undefined;
};

type SlashState = {
  onInputSlice: (query: string) => void;
  close: () => void;
  reset: () => void;
  open: boolean;
  totalItems: number;
  moveActive: (delta: number) => void;
  activeItem: SlashCommandItem | null;
  handleSelect: (item: SlashCommandItem | null) => string | null;
};

type DraftSync = {
  schedule: (value: string) => void;
  cancel: () => void;
};

type UseComposerTextareaOptions = {
  tabId: TabId | undefined;
  draftSync: DraftSync;
  mention: MentionState;
  slash: SlashState;
};

/**
 * Encapsulates the bidirectional sync between the composer textarea DOM
 * element and the Zustand store, plus textarea manipulation utilities and
 * trigger-detection dispatch to mention / slash popover hooks.
 */
export function useComposerTextarea({
  tabId,
  draftSync,
  mention,
  slash,
}: UseComposerTextareaOptions) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerValue = useComposerValue();
  const setComposerValue = useAgentStore((s) => s.setComposerValue);

  // --- State -----------------------------------------------------------

  const [hasText, setHasText] = useState(() => (composerValue ?? "").trim().length > 0);
  const hasTextRef = useRef(hasText);
  const draftValueRef = useRef(composerValue ?? "");
  const lastStoreValueRef = useRef<string | undefined>(undefined);

  // Keep refs for popover hooks (stable across renders for keyboard handler).
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const slashRef = useRef(slash);
  slashRef.current = slash;

  // --- Helpers ---------------------------------------------------------

  const syncHasText = useCallback((textarea: HTMLTextAreaElement | null) => {
    const next = readHasText(textarea);
    if (next !== hasTextRef.current) {
      hasTextRef.current = next;
      setHasText(next);
    }
  }, []);

  // --- Store → textarea sync -------------------------------------------

  useLayoutEffect(() => {
    const storeValue = composerValue ?? "";
    if (storeValue === lastStoreValueRef.current) return;

    const textarea = textareaRef.current;
    if (textarea) {
      if (storeValue !== textarea.value) {
        textarea.value = storeValue;
        draftValueRef.current = storeValue;
      }
      if (storeValue === "") {
        textarea.style.height = "auto";
      } else {
        adjustTextareaHeight(textarea);
      }
      syncHasText(textarea);
    }
    lastStoreValueRef.current = storeValue;
  }, [composerValue, syncHasText]);

  // Persist draft to store on tab change / unmount.
  useEffect(() => {
    return () => {
      if (tabId) {
        setComposerValue(tabId, draftValueRef.current);
      }
    };
  }, [tabId, setComposerValue]);

  // --- Textarea manipulation -------------------------------------------

  const clearTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.value = "";
    draftValueRef.current = "";
    textarea.style.height = "auto";
    hasTextRef.current = false;
    setHasText(false);
  }, []);

  /** Clear the textarea and return the trimmed value for submission. */
  const commitMessage = useCallback(() => {
    const trimmed = (textareaRef.current?.value ?? "").trim();
    draftSync.cancel();
    clearTextarea();
    if (tabId) setComposerValue(tabId, "");
    mentionRef.current.reset();
    return trimmed;
  }, [draftSync, clearTextarea, tabId, setComposerValue]);

  /** Restore text into the textarea (e.g. when editing a queued message). */
  const restoreText = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea || !tabId) return;
      textarea.value = text;
      draftValueRef.current = text;
      draftSync.schedule(text);
      setComposerValue(tabId, text);
      syncHasText(textarea);
      requestAnimationFrame(() => {
        textarea.focus();
        adjustTextareaHeight(textarea);
      });
    },
    [tabId, draftSync, setComposerValue, syncHasText],
  );

  /** Insert a file mention at the cursor position. */
  const insertMention = useCallback(
    (filePath: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const value = textarea.value;
      const cursor = textarea.selectionStart;
      const before = value.slice(0, cursor);
      const match = before.match(MENTION_TRIGGER);
      if (!match) return;

      const mentionStart = (match.index ?? 0) + match[1].length;
      const replacement = `@${filePath} `;
      const nextValue = value.slice(0, mentionStart) + replacement + value.slice(cursor);

      textarea.value = nextValue;
      draftValueRef.current = nextValue;
      draftSync.schedule(nextValue);
      if (tabId) setComposerValue(tabId, nextValue);
      mentionRef.current.reset();
      syncHasText(textarea);

      const nextCursor = mentionStart + replacement.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
        adjustTextareaHeight(textarea);
      });
    },
    [draftSync, tabId, setComposerValue, syncHasText],
  );

  // --- Input handler ---------------------------------------------------

  const handleInput = useCallback(
    (textarea: HTMLTextAreaElement) => {
      const nextValue = textarea.value;
      draftValueRef.current = nextValue;
      draftSync.schedule(nextValue);
      syncHasText(textarea);

      const cursor = textarea.selectionStart;
      const before = nextValue.slice(0, cursor);

      // Slash trigger (line-start only)
      const slashMatch = before.match(SLASH_TRIGGER);
      if (slashMatch) {
        slashRef.current.onInputSlice(slashMatch[1] ?? "");
        mentionRef.current.close();
        return;
      }
      if (slashRef.current.open) {
        slashRef.current.close();
      }

      // @mention trigger
      const match = before.match(MENTION_TRIGGER);
      if (match) {
        mentionRef.current.onInput(match[2] as string);
      } else if (mentionRef.current.open) {
        mentionRef.current.close();
      }
    },
    [draftSync, syncHasText],
  );

  const handleBlur = useCallback(() => {
    if (tabId) {
      setComposerValue(tabId, textareaRef.current?.value ?? "");
    }
    mentionRef.current.close();
    slashRef.current.close();
  }, [tabId, setComposerValue]);

  return {
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
  };
}
