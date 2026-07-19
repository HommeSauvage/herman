import type { ContextStats, Message, QueuedFollowUp } from "../../../../shared/rpc.js";

export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function queuedMessagesEqual(a: QueuedFollowUp[], b: QueuedFollowUp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].text !== b[i].text) return false;
  }
  return true;
}

export function messagesEqualish(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  // Compare the first, middle, and last messages by identity first (common case).
  const indices = [0, Math.floor(a.length / 2), a.length - 1];
  for (const i of indices) {
    if (i < 0 || i >= a.length) continue;
    if (a[i] === b[i]) continue;
    const am = a[i];
    const bm = b[i];
    if (am.id !== bm.id || am.role !== bm.role) return false;
    if (am.role === "user") {
      const au = am as Extract<Message, { role: "user" }>;
      const bu = bm as Extract<Message, { role: "user" }>;
      if (au.content !== bu.content) return false;
    }
    if (am.role === "assistant") {
      const aa = am as Extract<Message, { role: "assistant" }>;
      const ba = bm as Extract<Message, { role: "assistant" }>;
      if (aa.content !== ba.content || aa.isStreaming !== ba.isStreaming) return false;
      if (aa.stopReason !== ba.stopReason || aa.errorMessage !== ba.errorMessage) return false;
    }
    if (am.role === "tool") {
      const at = am as Extract<Message, { role: "tool" }>;
      const bt = bm as Extract<Message, { role: "tool" }>;
      if (at.status !== bt.status || at.output !== bt.output) return false;
    }
  }
  return true;
}

export function contextStatsEqual(
  a: ContextStats | undefined,
  b: ContextStats | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.totalTokens === b.totalTokens &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.estimatedCost === b.estimatedCost &&
    a.contextLimit === b.contextLimit &&
    a.messageCount === b.messageCount &&
    a.userMessageCount === b.userMessageCount &&
    a.assistantMessageCount === b.assistantMessageCount &&
    a.toolMessageCount === b.toolMessageCount &&
    a.modelId === b.modelId &&
    a.providerId === b.providerId &&
    a.isCompacted === b.isCompacted &&
    a.isStreaming === b.isStreaming &&
    a.currentTurnOutput === b.currentTurnOutput
  );
}
