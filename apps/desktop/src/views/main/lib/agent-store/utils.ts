import type { Message } from "../../../../shared/rpc.js";
import type { Tab } from "./types.js";

export function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseCurrentModel(currentModel?: string): { providerId?: string; modelId?: string } {
  if (!currentModel) return {};
  const [providerId, modelId] = currentModel.split("/", 2);
  return { providerId, modelId: modelId ?? providerId };
}

/** Maximum number of auto-retry attempts before giving up. */
export const MAX_RETRY_ATTEMPTS = 5;
/** Base delay in ms for the first auto-retry (doubles each attempt). */
export const RETRY_BASE_DELAY_MS = 2_000;

export function computeRetryState(attempt: number, message: string): Tab["retryState"] {
  return {
    attempt,
    message,
    next: Date.now() + RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
  };
}

export function currentStreamingAssistantId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.isStreaming) {
      return message.id;
    }
  }
  return undefined;
}

export function findLastStreamingThinkingIndex(
  messages: Message[],
  parentId: string,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.role === "thinking" &&
      message.parentId === parentId &&
      message.isStreaming
    ) {
      return i;
    }
  }
  return -1;
}
