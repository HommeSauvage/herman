import { useState } from "react";

import type { Message } from "../../../shared/rpc.js";
import { isContextTool } from "../lib/tool-info.js";

type ToolMessage = Extract<Message, { role: "tool" }>;
type ThinkingMessage = Extract<Message, { role: "thinking" }>;

export type RenderItem =
  | {
      type: "message";
      key: string;
      message: Message;
      showRevert?: boolean;
      onRevert?: () => void;
    }
  | { type: "context-group"; key: string; tools: ToolMessage[] };

function groupThinkingByParent(
  thinkingMessages: Message[],
  showThinking: boolean,
): Map<string, ThinkingMessage[]> {
  const map = new Map<string, ThinkingMessage[]>();
  if (!showThinking) return map;
  for (const message of thinkingMessages) {
    if (message.role !== "thinking" || !message.parentId) continue;
    const list = map.get(message.parentId);
    if (list) {
      list.push(message);
    } else {
      map.set(message.parentId, [message]);
    }
  }
  return map;
}

/**
 * Compute render items from a flat message array.
 *
 * Groups consecutive context tools (read, glob, grep, list) into a single
 * ContextToolGroup.  Skips empty assistant messages that never received text,
 * but renders visible thinking blocks before the assistant response that owns
 * them.
 */
export function computeRenderItems(
  messages: Message[],
  thinkingMessages: Message[] = [],
  showThinking = false,
): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: ToolMessage[] = [];
  const thinkingByParent = groupThinkingByParent(thinkingMessages, showThinking);

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      items.push({
        type: "message",
        key: buffer[0]!.id,
        message: buffer[0]!,
      });
    } else {
      const firstId = buffer[0]!.id;
      const lastId = buffer[buffer.length - 1]!.id;
      items.push({
        type: "context-group",
        key: `${firstId}:${lastId}`,
        tools: buffer,
      });
    }
    buffer = [];
  };

  const appendThinkingFor = (parentId: string) => {
    const thinkings = thinkingByParent.get(parentId);
    if (!thinkings) return;
    for (const thinking of thinkings) {
      items.push({ type: "message", key: thinking.id, message: thinking });
    }
  };

  for (const message of messages) {
    if (message.role === "tool" && isContextTool(message.toolName)) {
      buffer.push(message);
      continue;
    }

    const hasVisibleThinking =
      message.role === "assistant" && thinkingByParent.has(message.id);

    // Empty non-streaming assistant with no errors — usually skip it, but if
    // it owns visible thinking blocks, render those blocks instead.
    if (
      message.role === "assistant" &&
      !message.content &&
      !message.isStreaming &&
      !message.errorMessage &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      if (hasVisibleThinking) {
        flush();
        appendThinkingFor(message.id);
      }
      continue;
    }

    // Empty streaming assistant with visible thinking: show the thinking blocks
    // now and skip the placeholder "…" until text starts arriving.
    if (
      message.role === "assistant" &&
      !message.content &&
      message.isStreaming &&
      !message.errorMessage &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      hasVisibleThinking
    ) {
      flush();
      appendThinkingFor(message.id);
      continue;
    }

    flush();
    if (message.role === "assistant" && hasVisibleThinking) {
      appendThinkingFor(message.id);
    }
    items.push({
      type: "message",
      key: message.id,
      message,
    });
  }
  flush();

  return items;
}

/**
 * Returns true when two render items have the same visual representation
 * and do not need to trigger a React re-render.  This enables structural
 * sharing across message-list updates, so stable messages skip React.memo
 * checks entirely.
 *
 * Pattern adapted from T3Chat's `isRowUnchanged` / `useStableRows`.
 */
export function isRenderItemUnchanged(a: RenderItem, b: RenderItem): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;

  if (a.type === "context-group" && b.type === "context-group") {
    if (a.tools.length !== b.tools.length) return false;
    for (let i = 0; i < a.tools.length; i++) {
      const at = a.tools[i]!;
      const bt = b.tools[i]!;
      if (
        at.id !== bt.id ||
        at.status !== bt.status ||
        at.output !== bt.output
      )
        return false;
    }
    return true;
  }

  if (a.type !== "message" || b.type !== "message") return false;
  const am = a.message;
  const bm = b.message;
  if (am.role !== bm.role || am.id !== bm.id) return false;

  if (am.role === "assistant" && bm.role === "assistant") {
    return (
      am.content === bm.content &&
      am.isStreaming === bm.isStreaming &&
      am.stopReason === bm.stopReason &&
      am.errorMessage === bm.errorMessage
    );
  }

  if (am.role === "tool" && bm.role === "tool") {
    return (
      am.toolName === bm.toolName &&
      am.toolCallId === bm.toolCallId &&
      am.status === bm.status &&
      am.output === bm.output
    );
  }

  if (am.role === "thinking" && bm.role === "thinking") {
    return (
      am.content === bm.content &&
      am.isStreaming === bm.isStreaming
    );
  }

  // User messages never change content after creation.
  if (am.role === "user" && bm.role === "user") {
    return a.showRevert === b.showRevert;
  }

  return true;
}

/**
 * Returns a new array reusing stable references from `prev` where unchanged.
 */
export function stabilizeRenderItems(
  prev: RenderItem[],
  items: RenderItem[],
): RenderItem[] {
  const next: RenderItem[] = [];
  let anyChanged = false;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const existing = prev[i];

    if (existing && isRenderItemUnchanged(existing, item)) {
      next.push(existing); // reuse stable reference
    } else {
      next.push(item);
      anyChanged = true;
    }
  }

  if (!anyChanged && prev.length === next.length) {
    return prev;
  }

  return next;
}

/**
 * Stable structural sharing for render items.  Reuses previous item
 * references when unchanged, so React.memo on child components can skip
 * re-rendering.
 */
export function useStableRenderItems(items: RenderItem[]): RenderItem[] {
  const [state, setState] = useState<{
    input: RenderItem[];
    stable: RenderItem[];
  }>(() => ({
    input: items,
    stable: items,
  }));

  if (items !== state.input) {
    setState({
      input: items,
      stable: stabilizeRenderItems(state.stable, items),
    });
  }

  return state.stable;
}

/** Convenience re-export for external consumers (tests, etc.). */
export function buildRenderItems(messages: Message[]): RenderItem[] {
  return computeRenderItems(messages);
}
