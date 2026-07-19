import type { AgentEvent } from "../../../../shared/agent-protocol.js";
import { createMessageId } from "../../../../shared/apply-agent-event.js";
import type { Message } from "../../../../shared/rpc.js";
import { currentStreamingAssistantId, findLastStreamingThinkingIndex } from "./utils.js";

export function applyAgentEventToThinkingMessages(
  messages: Message[],
  thinkingMessages: Message[],
  event: AgentEvent,
): Message[] {
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent as
      | { type?: string; delta?: string }
      | undefined;
    const type = assistantEvent?.type;
    if (!type) return thinkingMessages;

    if (type === "thinking_start") {
      const parentId = currentStreamingAssistantId(messages);
      if (!parentId) return thinkingMessages;
      const thinkingMsg: Message = {
        id: createMessageId(),
        role: "thinking",
        content: "",
        isStreaming: true,
        parentId,
      };
      return [...thinkingMessages, thinkingMsg];
    }

    if (type === "thinking_delta") {
      const parentId = currentStreamingAssistantId(messages);
      if (!parentId) return thinkingMessages;
      const idx = findLastStreamingThinkingIndex(thinkingMessages, parentId);
      if (idx === -1) return thinkingMessages;
      const next = [...thinkingMessages];
      const previous = next[idx] as Extract<Message, { role: "thinking" }>;
      if (!previous) return thinkingMessages;
      next[idx] = {
        ...previous,
        content: previous.content + (assistantEvent?.delta ?? ""),
      };
      return next;
    }

    if (type === "thinking_end") {
      const parentId = currentStreamingAssistantId(messages);
      if (!parentId) return thinkingMessages;
      const idx = findLastStreamingThinkingIndex(thinkingMessages, parentId);
      if (idx === -1) return thinkingMessages;
      const next = [...thinkingMessages];
      const prev = next[idx] as Extract<Message, { role: "thinking" }>;
      if (!prev) return thinkingMessages;
      next[idx] = { ...prev, isStreaming: false };
      return next;
    }
  }

  if (event.type === "message_end") {
    const eventMessage = event.message as { role?: string } | undefined;
    if (eventMessage?.role === "assistant") {
      const idx = (() => {
        for (let i = thinkingMessages.length - 1; i >= 0; i--) {
          const m = thinkingMessages[i];
          if (m?.role === "thinking" && (m as Extract<Message, { role: "thinking" }>).isStreaming) {
            return i;
          }
        }
        return -1;
      })();
      if (idx !== -1) {
        return thinkingMessages.map((m) =>
          m.role === "thinking" && (m as Extract<Message, { role: "thinking" }>).isStreaming
            ? { ...m, isStreaming: false }
            : m,
        );
      }
    }
  }

  if (
    event.type === "agent_end" ||
    event.type === "agent_complete" ||
    event.type === "agent_error"
  ) {
    if (
      thinkingMessages.some(
        (m) => m.role === "thinking" && (m as Extract<Message, { role: "thinking" }>).isStreaming,
      )
    ) {
      return thinkingMessages.map((m) =>
        m.role === "thinking" && (m as Extract<Message, { role: "thinking" }>).isStreaming
          ? { ...m, isStreaming: false }
          : m,
      );
    }
  }

  return thinkingMessages;
}
