import type { AgentEvent } from "../../../../shared/agent-protocol.js";
import { applyAgentEventToMessages, isAgentEndCurrent } from "../../../../shared/apply-agent-event.js";
import type { ContextStats, ModelMetadata } from "../../../../shared/rpc.js";
import { contextStatsEqual } from "./compare.js";
import type { Tab } from "./types.js";
import { computeRetryState, MAX_RETRY_ATTEMPTS, parseCurrentModel } from "./utils.js";
import { applyAgentEventToThinkingMessages } from "./thinking.js";

/** Merge new model metadata into the store so context-stats computation
 *  always has the latest context-window limits. */
export function mergeModelMetadata(
  existing: Record<string, ModelMetadata>,
  incoming: Record<string, ModelMetadata> | undefined,
): Record<string, ModelMetadata> {
  if (!incoming) return existing;
  return { ...existing, ...incoming };
}

export function applyAgentEvent(
  tab: Tab,
  event: AgentEvent,
  modelMetadata?: Record<string, ModelMetadata>,
): Tab {
  const now = Date.now();
  let next: Tab = tab;
  let changed = false;

  const withPatch = (patch: Partial<Tab>) => {
    const hasChange = Object.keys(patch).some((key) => {
      const k = key as keyof Tab;
      const a = patch[k];
      const b = next[k];
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return true;
        // For messages, compare identity of last few items (cheap heuristic).
        for (let i = Math.max(0, a.length - 3); i < a.length; i++) {
          if (a[i] !== b[i]) return true;
        }
        return false;
      }
      return a !== b;
    });
    if (hasChange) {
      next = { ...next, ...patch, updatedAt: now };
      changed = true;
    }
  };

  const updatedMessages = applyAgentEventToMessages(next.messages, event);
  if (updatedMessages !== next.messages) {
    withPatch({ messages: updatedMessages });
  }

  const updatedThinkingMessages = applyAgentEventToThinkingMessages(
    updatedMessages,
    next.thinkingMessages,
    event,
  );
  if (updatedThinkingMessages !== next.thinkingMessages) {
    withPatch({ thinkingMessages: updatedThinkingMessages });
  }

  switch (event.type) {
    case "agent_start": {
      if (!next.isThinking) {
        withPatch({ isThinking: true, thinkingStartedAt: now });
      }
      // Clear transient connection errors and retry state — the
      // agent has recovered and is starting a new turn.
      if (next.connectionError || next.retryState || next.connectionErrorDismissed) {
        withPatch({
          connectionError: undefined,
          connectionErrorDismissed: undefined,
          retryState: undefined,
        });
      }
      break;
    }
    case "agent_end":
    case "agent_complete": {
      // Only clear isThinking when this event still describes the current turn.
      // If the agent has moved on (e.g. auto-retry), the event is stale and
      // must not downgrade the working state.
      if (next.isThinking && isAgentEndCurrent(event, next.messages)) {
        withPatch({ isThinking: false });
      }
      // Clear any lingering retry state on successful completion.
      if (next.retryState) {
        withPatch({ retryState: undefined });
      }
      break;
    }
    case "agent_error": {
      if (next.isThinking) {
        withPatch({ isThinking: false });
      }
      if (next.connectionError !== event.error) {
        withPatch({ connectionError: event.error });
      }
      // Start auto-retry if we haven't exceeded max attempts.
      if (!next.retryState || next.retryState.attempt < MAX_RETRY_ATTEMPTS) {
        const attempt = (next.retryState?.attempt ?? 0) + 1;
        withPatch({ retryState: computeRetryState(attempt, event.error) });
      }
      break;
    }
    case "message_end": {
      const lastAssistant = [...updatedMessages]
        .reverse()
        .find((m): m is Extract<Tab["messages"][number], { role: "assistant" }> => m.role === "assistant");
      if (lastAssistant) {
        const isError =
          lastAssistant.stopReason === "error" ||
          lastAssistant.stopReason === "aborted" ||
          typeof lastAssistant.errorMessage === "string";
        if (isError) {
          if (next.isThinking) {
            withPatch({ isThinking: false });
          }
          const errorText =
            lastAssistant.errorMessage ||
            `The assistant stopped unexpectedly (${lastAssistant.stopReason ?? "error"}).`;
          if (next.connectionError !== errorText) {
            withPatch({ connectionError: errorText });
          }
          if (next.thinkingBanner) {
            withPatch({ thinkingBanner: undefined });
          }
        }
      }
      break;
    }
    case "herman/models_sync":
    case "models_sync": {
      // Only adopt the agent's default model if this tab doesn't already
      // have one (e.g. restored from session or inherited from settings).
      withPatch({
        currentModel: tab.currentModel ?? event.currentModel,
        availableModels: event.models,
      });
      break;
    }
    case "herman/context_report": {
      // Live, agent-reported context snapshot. The agent's
      // `pi-context-reporter` extension is the source of truth; we
      // just copy the snapshot into `tab.contextStats`.
      const { providerId, modelId } = parseCurrentModel(event.modelKey);
      const newStats: ContextStats = {
        totalTokens: event.context.tokens ?? 0,
        inputTokens: event.totals.input,
        outputTokens: event.totals.output,
        reasoningTokens: event.totals.reasoning,
        cacheReadTokens: event.totals.cacheRead,
        cacheWriteTokens: event.totals.cacheWrite,
        estimatedCost: event.totals.cost,
        contextLimit: event.context.contextWindow,
        messageCount: next.messages.length,
        userMessageCount: next.messages.filter((m) => m.role === "user").length,
        assistantMessageCount: next.messages.filter((m) => m.role === "assistant").length,
        toolMessageCount: next.messages.filter((m) => m.role === "tool").length,
        ...(modelId ? { modelId } : {}),
        ...(providerId ? { providerId } : {}),
        updatedAt: event.updatedAt,
        isCompacted: event.isCompacted,
        isStreaming: event.isStreaming,
        ...(event.currentTurn ? { currentTurnOutput: event.currentTurn.output } : {}),
      };
      if (!contextStatsEqual(next.contextStats, newStats)) {
        withPatch({ contextStats: newStats });
      }
      break;
    }
    case "herman/context_usage": {
      // Legacy event from older agents (pre-`@herman/pi-context-reporter`).
      // The live `herman/context_report` event is the source of truth
      // for context stats, so we drop the legacy payload on the floor.
      break;
    }
    case "herman/agent_proxy_error": {
      // Never clear isThinking here — proxy errors are advisory, not lifecycle
      // events.  The agent may have already recovered via auto-retry before
      // this event reaches the renderer (IPC reordering, async extension
      // handler delay).  Let agent_start / agent_end own the working state.
      withPatch({ connectionError: event.error });
      break;
    }
    case "extension_error": {
      withPatch({ connectionError: event.error });
      break;
    }
  }

  if (!changed) return tab;
  return next;
}
