/**
 * pi-context-reporter: live context-window and token-usage reporter.
 *
 * Subscribes to the full set of session/message events exposed by the
 * Pi coding agent and emits throttled `herman/context_report` notifies
 * to the desktop. The payload replaces the desktop's
 * chars/4-estimator + 60-entry `MODEL_CONTEXT_LIMITS` lookup with a
 * single, accurate stream sourced from the LLM itself.
 *
 * Event-subscription strategy:
 * - `session_start` / `model_select` → set the model + context window.
 * - `context` (pre-LLM) → adopt `getContextUsage()` as the anchor.
 * - `agent_start` / `agent_end` → mark the streaming flag.
 * - `session_compact` → mark context as unknown.
 * - `message_start` → begin a new current-turn estimate.
 * - `message_update` → accumulate streaming output (chars/4 of deltas).
 * - `message_end` → anchor cumulative totals from the LLM-reported usage.
 *
 * The notify channel is coalesced to `REPORT_THROTTLE_MS` (200ms) but
 * flushed immediately on lifecycle events (`agent_end`, `message_end`,
 * `session_compact`) so the desktop sees the final state without lag.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@logtape/logtape";

import { type ContextReportUsage, REPORT_THROTTLE_MS } from "./payload.js";
import { ContextState } from "./state.js";
import { createThrottledNotifier, type ThrottledNotifier } from "./throttle.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromMessage(message: unknown): ContextReportUsage | undefined {
  if (!isRecord(message)) return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;

  const input = numberOr(usage.input, 0);
  const output = numberOr(usage.output, 0);
  const cacheRead = numberOr(usage.cacheRead, 0);
  const cacheWrite = numberOr(usage.cacheWrite, 0);
  const reasoning = numberOrUndefined(usage.reasoning);
  const totalTokens = numberOr(usage.totalTokens, input + output + cacheRead + cacheWrite);
  const costRaw = isRecord(usage.cost) ? usage.cost : {};
  const cost = {
    input: numberOr(costRaw.input, 0),
    output: numberOr(costRaw.output, 0),
    cacheRead: numberOr(costRaw.cacheRead, 0),
    cacheWrite: numberOr(costRaw.cacheWrite, 0),
    total: numberOr(costRaw.total, 0),
  };

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens,
    cost,
  };
}

function assistantMessageId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.id === "string") return message.id;
  if (typeof message.messageId === "string") return message.messageId;
  return undefined;
}

function assistantEventDeltaChars(assistantMessageEvent: unknown): number {
  if (!isRecord(assistantMessageEvent)) return 0;
  const type = assistantMessageEvent.type;
  if ((type === "text_delta" || type === "thinking_delta") && typeof assistantMessageEvent.delta === "string") {
    return numberOr(assistantMessageEvent.delta.length, 0);
  }
  return 0;
}

export default function contextReporterExtension(pi: ExtensionAPI): void {
  const state = new ContextState();
  const verboseLogging =
    process.env.HERMAN_AGENT_LOG_LEVEL === "debug" ||
    process.env.HERMAN_AGENT_LOG_LEVEL === "trace";
  const logger = getLogger(["herman-agent", "context-reporter"]);
  let notifier: ThrottledNotifier | undefined;
  let installedForSession = false;

  const ensureNotifier = (ctx: ExtensionContext): ThrottledNotifier => {
    if (notifier) return notifier;
    notifier = createThrottledNotifier(
      (message) => ctx.ui.notify(message),
      () => JSON.stringify(state.snapshot()),
      REPORT_THROTTLE_MS,
      // Swallow notify errors — they should never break the agent loop.
      // The next scheduled emit will retry.
      () => {},
      verboseLogging
        ? () => {
            logger.debug("Context report emit throttled");
          }
        : undefined,
    );
    return notifier;
  };

  const teardownNotifier = () => {
    notifier?.cancel();
    notifier = undefined;
    installedForSession = false;
  };

  const emit = (ctx: ExtensionContext, opts: { flush?: boolean } = {}) => {
    if (!installedForSession) return;
    const n = ensureNotifier(ctx);
    if (opts.flush) {
      n.flush();
    } else {
      n.schedule();
    }
  };

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    installedForSession = true;
    const model = ctx.model;
    if (model) {
      state.setModel(`${model.provider}/${model.id}`, model.contextWindow ?? 0);
    }
    // Walk the session branch to recover cumulative totals from all prior
    // assistant messages. The session file on disk is the source of truth —
    // this survives app restarts and tab reopens.
    const branch = ctx.sessionManager.getBranch();
    state.initFromBranch(
      branch.map((e) => ({
        type: e.type,
        message: e.type === "message" ? (e as { message: unknown }).message : undefined,
      })),
    );
    const usage = ctx.getContextUsage();
    if (usage?.tokens != null) {
      state.setContextAnchor(usage.tokens);
    }
    // Emit a baseline so the desktop shows a gauge even before the first
    // turn runs.
    emit(ctx, { flush: true });
  });

  pi.on("model_select", async (event, ctx) => {
    const model = event.model;
    if (model) {
      state.setModel(`${model.provider}/${model.id}`, model.contextWindow ?? 0);
    }
    emit(ctx, { flush: true });
  });

  pi.on("session_compact", async (_event, ctx) => {
    state.onSessionCompact();
    emit(ctx, { flush: true });
  });

  pi.on("session_shutdown", () => {
    teardownNotifier();
  });

  // ---------------------------------------------------------------------------
  // Pre-LLM context estimation
  // ---------------------------------------------------------------------------

  pi.on("context", async (_event, ctx) => {
    // Fires right before each LLM call. Pi's `getContextUsage()` returns
    // the best estimate of the pre-prompt context size (it has its own
    // chars/4 estimator plus the post-compaction logic). We adopt it
    // as the gauge anchor so the desktop has a sensible value while the
    // assistant streams.
    const usage = ctx.getContextUsage();
    state.setContextAnchor(usage?.tokens ?? null);
    emit(ctx);
  });

  // ---------------------------------------------------------------------------
  // Turn lifecycle
  // ---------------------------------------------------------------------------

  pi.on("agent_start", async (_event, ctx) => {
    state.onAgentStart();
    emit(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    state.onAgentEnd();
    emit(ctx, { flush: true });
  });

  // ---------------------------------------------------------------------------
  // Message lifecycle (assistant)
  // ---------------------------------------------------------------------------

  pi.on("message_start", async (event, ctx) => {
    const message = event.message;
    if (!isRecord(message)) return;
    if (message.role !== "assistant") return;
    emit(ctx);
  });

  pi.on("message_update", async (event, ctx) => {
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return;
    const deltaChars = assistantEventDeltaChars(event.assistantMessageEvent);
    if (deltaChars === 0) return;
    state.onMessageUpdate(deltaChars, assistantMessageId(message));
    emit(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return;
    const usage = usageFromMessage(message);
    if (!usage) return;
    state.onMessageEnd(usage, assistantMessageId(message));
    emit(ctx, { flush: true });
  });
}
