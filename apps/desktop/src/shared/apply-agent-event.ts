import type { AgentEvent } from "./agent-protocol.js";
import { isContextTool } from "./context-tools.js";
import type { Message } from "./rpc.js";

let messageCounter = 0;

export function createMessageId(): string {
  return `msg-${++messageCounter}`;
}

/** Advance the counter past the maximum numeric ID found in restored messages. */
export function syncMessageCounter(messagesList: { id?: string }[][]) {
  let max = 0;
  for (const messages of messagesList) {
    for (const m of messages) {
      if (m.id) {
        const match = /^msg-(\d+)$/.exec(m.id);
        if (match) max = Math.max(max, Number(match[1]));
      }
    }
  }
  if (max > messageCounter) messageCounter = max;
}

export function resetMessageIdCounter() {
  messageCounter = 0;
}

export function extractToolText(result: unknown): string {
  const partial = result as
    | { content?: { type: string; text?: string }[]; details?: unknown }
    | undefined;
  return (
    partial?.content
      ?.map((c) => c.text)
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

function eventMessageRole(message: unknown): string | undefined {
  if (message && typeof message === "object" && "role" in message) {
    return String((message as { role?: unknown }).role);
  }
  return undefined;
}

function normalizeAgentRole(role: string | undefined): string | undefined {
  // The agent emits tool results with role "toolResult", but the desktop
  // stores them as "tool" messages. Treat the two as equivalent when
  // matching the event's message suffix against the tab's messages.
  if (role === "toolResult") return "tool";
  return role;
}

/**
 * Determine whether an agent_end/agent_complete event still describes the
 * current turn.  The agent includes the messages produced during the run in
 * event.messages, so a simple length comparison against the tab's full
 * history wrongly treats every conversation with prior messages as stale.
 * Instead, check that event.messages matches the suffix of the tab's
 * messages by role.
 */
export function isAgentEndCurrent(
  event: Extract<AgentEvent, { type: "agent_end" | "agent_complete" }>,
  messages: Message[],
): boolean {
  const eventMsgs = event.messages as unknown[] | undefined;
  if (!Array.isArray(eventMsgs)) return true;
  if (eventMsgs.length > messages.length) return false;

  for (let i = 0; i < eventMsgs.length; i++) {
    const eventRole = normalizeAgentRole(eventMessageRole(eventMsgs[eventMsgs.length - 1 - i]));
    const tabMessage = messages[messages.length - 1 - i];
    if (!tabMessage) return false;
    if (eventRole !== tabMessage.role) return false;
  }
  return true;
}

function updateLastAssistant(
  messages: Message[],
  fn: (message: Extract<Message, { role: "assistant" }>) => Extract<Message, { role: "assistant" }>,
): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      const updated = fn(message);
      if (updated === message) return messages;
      const next = [...messages];
      next[i] = updated;
      return next;
    }
  }
  return messages;
}

/**
 * Force every in-flight assistant/tool message to a terminal state.
 *
 * Used when the user explicitly stops generation or when reloading a session
 * whose history was saved mid-stream. This prevents the UI from showing a
 * stuck "Working" indicator based on stale `isStreaming` / `running` flags.
 */
export function finalizeStreamingMessages(messages: Message[]): Message[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role === "assistant" && m.isStreaming) {
      changed = true;
      return { ...m, isStreaming: false };
    }
    if (m.role === "tool" && m.status === "running") {
      changed = true;
      return { ...m, status: "error" as const, output: m.output ?? "Stopped by user" };
    }
    return m;
  });
  return changed ? next : messages;
}

export function applyAgentEventToMessages(messages: Message[], event: AgentEvent): Message[] {
  switch (event.type) {
    case "message_start": {
      const msg = event.message as { role?: string } | undefined;
      if (msg?.role === "assistant") {
        return [
          ...messages,
          { id: createMessageId(), role: "assistant", content: "", isStreaming: true },
        ];
      }
      return messages;
    }
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent as
        | { type?: string; delta?: string; content?: string }
        | undefined;
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        if (assistantEvent.delta === "") return messages;
        return updateLastAssistant(messages, (m) => ({
          ...m,
          content: m.content + assistantEvent.delta,
          // Self-heal: if a delta flows, the message is streaming regardless of
          // what a stale lifecycle event may have claimed.  This corrects
          // isStreaming when a stale agent_end cleared it before a retry.
          isStreaming: true,
        }));
      }
      if (assistantEvent?.type === "text_end" && typeof assistantEvent.content === "string") {
        const text = assistantEvent.content;
        return updateLastAssistant(messages, (m) =>
          m.content === text ? m : { ...m, content: text },
        );
      }
      return messages;
    }
    case "message_end": {
      const eventMessage = event.message as Record<string, unknown> | undefined;
      const stopReason =
        typeof eventMessage?.stopReason === "string" ? eventMessage.stopReason : undefined;
      const errorMessage =
        typeof eventMessage?.errorMessage === "string" ? eventMessage.errorMessage : undefined;
      const model = typeof eventMessage?.model === "string" ? eventMessage.model : undefined;
      const provider =
        typeof eventMessage?.provider === "string" ? eventMessage.provider : undefined;

      return updateLastAssistant(messages, (m) => {
        if (
          !m.isStreaming &&
          m.stopReason === stopReason &&
          m.errorMessage === errorMessage &&
          m.model === model &&
          m.provider === provider
        ) {
          return m;
        }
        return { ...m, isStreaming: false, stopReason, errorMessage, model, provider };
      });
    }
    case "agent_end":
    case "agent_complete": {
      // Only finalize messages this turn knew about.  If messages have grown
      // past what event.messages carries (e.g. due to auto-retry), the event
      // is stale and must not touch messages from the new turn.
      if (!isAgentEndCurrent(event, messages)) return messages;

      const eventMsgs = event.messages as unknown[] | undefined;
      const knownCount = Array.isArray(eventMsgs) ? eventMsgs.length : messages.length;
      const startIndex = messages.length - knownCount;
      let changed = false;
      const next = messages.map((m, i) => {
        if (i >= startIndex && m.role === "assistant" && m.isStreaming) {
          changed = true;
          return { ...m, isStreaming: false };
        }
        return m;
      });
      return changed ? next : messages;
    }
    case "agent_error": {
      return updateLastAssistant(messages, (m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m,
      );
    }
    case "tool_execution_start": {
      return [
        ...messages,
        {
          id: createMessageId(),
          role: "tool",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          status: "running",
          args: event.args,
        },
      ];
    }
    case "tool_execution_update": {
      // Context tools emit frequent intermediate updates whose output is
      // always replaced by the final result — skip them to avoid churn.
      if (isContextTool(event.toolName)) return messages;
      const output = extractToolText(event.partialResult);
      let changed = false;
      const next = messages.map((m) => {
        if (m.role === "tool" && m.toolCallId === event.toolCallId) {
          if (m.output !== output) {
            changed = true;
            return { ...m, output };
          }
        }
        return m;
      });
      return changed ? next : messages;
    }
    case "tool_execution_end": {
      const output = extractToolText(event.result);
      const status: "error" | "done" = event.isError ? "error" : "done";
      let changed = false;
      const next = messages.map((m) => {
        if (m.role === "tool" && m.toolCallId === event.toolCallId) {
          if (m.status !== status || m.output !== output) {
            changed = true;
            return { ...m, status, output };
          }
        }
        return m;
      });
      return changed ? next : messages;
    }
    default:
      return messages;
  }
}
