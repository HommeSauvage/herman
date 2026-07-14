import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@logtape/logtape";

import {
  createMessageId,
  finalizeStreamingMessages,
  syncMessageCounter,
} from "../shared/apply-agent-event.js";
import type { Message } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { piSessionDir, resolvePiSessionFile } from "./pi-session.js";

const logger = getLogger(["herman-desktop", "pi-messages"]);

export function extractMessagesFromAgentPayload(
  data: Record<string, unknown>,
): Message[] | undefined {
  const candidates = [
    data.messages,
    (data.state as Record<string, unknown> | undefined)?.messages,
    (data.data as Record<string, unknown> | undefined)?.messages,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const normalized: Message[] = [];
    for (const raw of candidate) {
      const normalizedMessage = normalizePiMessage(raw);
      if (normalizedMessage) normalized.push(normalizedMessage);
    }
    syncMessageCounter([normalized]);
    return normalized;
  }
  return undefined;
}

export function normalizePiMessage(raw: unknown): Message | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const msg = raw as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : undefined;
  const id =
    typeof msg.id === "string"
      ? msg.id
      : typeof msg.entryId === "string"
        ? msg.entryId
        : createMessageId();

  if (role === "user" || role === "assistant") {
    return {
      id,
      role,
      content: normalizeContentText(msg.content),
      ...(role === "assistant" && typeof msg.stopReason === "string"
        ? { stopReason: msg.stopReason }
        : {}),
      ...(role === "assistant" && typeof msg.errorMessage === "string"
        ? { errorMessage: msg.errorMessage }
        : {}),
      ...(role === "assistant" && typeof msg.model === "string" ? { model: msg.model } : {}),
      ...(role === "assistant" && typeof msg.provider === "string"
        ? { provider: msg.provider }
        : {}),
    } satisfies Message;
  }

  if (role === "thinking") {
    return {
      id,
      role: "thinking",
      content: normalizeContentText(msg.content),
      ...(typeof msg.parentId === "string" ? { parentId: msg.parentId } : {}),
    };
  }

  if (role === "toolResult" || role === "tool") {
    const toolName =
      typeof msg.toolName === "string"
        ? msg.toolName
        : typeof msg.name === "string"
          ? msg.name
          : "tool";
    const toolCallId =
      typeof msg.toolCallId === "string"
        ? msg.toolCallId
        : typeof msg.id === "string"
          ? msg.id
          : createMessageId();
    return {
      id,
      role: "tool",
      toolName,
      toolCallId,
      status: msg.isError === true ? "error" : "done",
      output: normalizeContentText(msg.content),
    };
  }

  return undefined;
}

export function normalizeContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const chunks: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    // Pi assistant blocks may be { type: "thinking", thinking: "..." } or
    // { type: "text", text: "..." }. Only surface user-visible text.
    if (block.type === "thinking" || typeof block.thinking === "string") {
      continue;
    }
    if (typeof block.text === "string") {
      chunks.push(block.text);
    }
  }
  return chunks.join("");
}

/** Load resolved LLM messages directly from pi's on-disk session JSONL. */
export function loadMessagesFromPiSessionFile(tabId: TabId, piSessionId?: string): Message[] {
  const filePath = resolvePiSessionFile(piSessionId);
  if (!filePath) return [];

  try {
    const sessionManager = SessionManager.open(filePath, piSessionDir());
    const { messages: rawMessages } = sessionManager.buildSessionContext();
    const normalized: Message[] = [];
    for (const raw of rawMessages) {
      const message = normalizePiMessage(raw);
      if (message) normalized.push(message);
    }
    syncMessageCounter([normalized]);
    return finalizeStreamingMessages(normalized);
  } catch (error) {
    logger.warning("Failed to load messages from pi session file", {
      tabId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
