/**
 * Per-session context accounting state.
 *
 * Owns all the rolling numbers the extension needs to send to the desktop:
 *
 * - Cumulative session totals (input, output, cache, cost) across all
 *   assistant turns.
 * - The current context-size snapshot, anchored to `getContextUsage()` at
 *   the pre-LLM `context` event (Pi's own estimate, which is the
 *   most accurate reading we get between calls). Null after compaction
 *   until the next pre-LLM call.
 * - A running estimate of the in-flight assistant turn's output tokens
 *   (accumulated from `message_update` deltas).
 * - The most recent finalized `usage` (from `message_end`).
 *
 * The state is intentionally provider-agnostic. The same logic works for
 * any model, including non-Herman providers.
 */

import type {
  ContextReportCurrentTurn,
  ContextReportPayload,
  ContextReportSnapshot,
  ContextReportTotals,
  ContextReportUsage,
} from "./payload.js";

function emptyTotals(): ContextReportTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

function emptyCurrentTurn(startedAt: number, messageId?: string): ContextReportCurrentTurn {
  return { output: 0, startedAt, messageId };
}

export class ContextState {
  /** Cumulative session totals. */
  private totals: ContextReportTotals = emptyTotals();

  /** Whether cumulative totals have been initialised from the session file. */
  private totalsSeeded = false;

  /**
   * Current context-size anchor (tokens), `null` when unknown.
   *
   * Sourced from Pi's `getContextUsage()` at the pre-LLM `context` event.
   * The estimate includes the system prompt, all prior messages, and
   * any tool results and user prompts added since the last call. Null
   * immediately after `session_compact` and before the first LLM call.
   */
  private contextTokens: number | null = null;

  /**
   * Running estimate of the in-flight assistant turn's output (chars/4
   * of `message_update` deltas). Reset on each `message_end`.
   */
  private currentTurn: ContextReportCurrentTurn | undefined;

  /** Last finalized `message_end.usage` from an assistant turn. */
  private lastUsage: ContextReportUsage | undefined;

  /** Current model key (e.g. "anthropic/claude-sonnet-4.6"). */
  private modelKey = "unknown";

  /** Current context window (tokens) for the active model. */
  private contextWindow = 0;

  /**
   * `true` immediately after a `session_compact` event. Suppressed by
   * the next pre-LLM `context` event that re-anchors `contextTokens`.
   */
  private isCompacted = false;

  /** `true` while the agent is mid-turn (between `agent_start` and `agent_end`). */
  private isStreaming = false;

  // ---------------------------------------------------------------------------
  // Initialisation from session file (source of truth)
  // ---------------------------------------------------------------------------

  /**
   * Seed cumulative totals by walking every assistant message in the session
   * branch. Called on `session_start` so the desktop sees historical usage
   * even after the app or tab is restarted. Safe to call multiple times —
   * only the first call takes effect (subsequent `message_end` events add
   * incrementally on top).
   */
  initFromBranch(entries: Array<{ type: string; message?: unknown }>): void {
    if (this.totalsSeeded) return;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    let cost = 0;

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || typeof msg !== "object") continue;
      const role = (msg as Record<string, unknown>).role;
      if (role !== "assistant") continue;
      const usage = (msg as Record<string, unknown>).usage;
      if (!usage || typeof usage !== "object") continue;
      const u = usage as Record<string, number>;
      const uInput = typeof u.input === "number" && Number.isFinite(u.input) ? u.input : 0;
      const uOutput = typeof u.output === "number" && Number.isFinite(u.output) ? u.output : 0;
      // Skip invalid entries (no input + no output = nothing to count).
      if (uInput === 0 && uOutput === 0) continue;
      input += uInput;
      output += uOutput;
      cacheRead += typeof u.cacheRead === "number" && Number.isFinite(u.cacheRead) ? u.cacheRead : 0;
      cacheWrite += typeof u.cacheWrite === "number" && Number.isFinite(u.cacheWrite) ? u.cacheWrite : 0;
      reasoning += typeof u.reasoning === "number" && Number.isFinite(u.reasoning) ? u.reasoning : 0;
      const costRaw = u.cost;
      if (costRaw && typeof costRaw === "object") {
        const c = costRaw as Record<string, number>;
        cost += typeof c.total === "number" && Number.isFinite(c.total) ? c.total : 0;
      }
    }

    this.totals = { input, output, cacheRead, cacheWrite, reasoning, cost };
    this.totalsSeeded = true;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  setModel(modelKey: string, contextWindow: number): void {
    this.modelKey = modelKey;
    this.contextWindow = contextWindow;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle events
  // ---------------------------------------------------------------------------

  onAgentStart(): void {
    this.isStreaming = true;
  }

  onAgentEnd(): void {
    // Clear the streaming flag but keep `currentTurn`. The previous
    // assistant's output is now part of the next call's input, so the
    // gauge should still reflect it until the pre-LLM `context` event
    // re-anchors the snapshot on the next turn.
    this.isStreaming = false;
  }

  onSessionCompact(): void {
    this.contextTokens = null;
    this.isCompacted = true;
    this.currentTurn = undefined;
  }

  // ---------------------------------------------------------------------------
  // Pre-LLM context event
  // ---------------------------------------------------------------------------

  /**
   * Called on the `context` event (fires right before each LLM call).
   * Pi's `getContextUsage()` is the most accurate current context size
   * we get, so we adopt it as the snapshot. Pass `null` when pi
   * itself reports unknown (post-compaction, pre-first-call).
   *
   * The new anchor already includes the previous assistant's output
   * (it's part of the message history that `getContextUsage` walks),
   * so we reset `currentTurn` to avoid double-counting it.
   */
  setContextAnchor(tokens: number | null): void {
    if (tokens !== null) {
      this.contextTokens = tokens;
      this.isCompacted = false;
      this.currentTurn = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Message events
  // ---------------------------------------------------------------------------

  /**
   * Called on every streaming delta for the active assistant turn.
   * Accumulates a chars/4 estimate of the output text.
   */
  onMessageUpdate(deltaChars: number, messageId?: string): void {
    if (!this.currentTurn) {
      this.currentTurn = emptyCurrentTurn(Date.now(), messageId);
    } else if (messageId && this.currentTurn.messageId === undefined) {
      this.currentTurn.messageId = messageId;
    }
    this.currentTurn.output = Math.ceil(this.currentTurn.output + deltaChars / 4);
  }

  /**
   * Called on `message_end` for an assistant message. Anchors the
   * cumulative totals from the LLM-reported `usage`. Note: the context
   * snapshot itself is not updated here — the next pre-LLM `context`
   * event is the canonical anchor.
   */
  onMessageEnd(usage: ContextReportUsage, messageId?: string): void {
    this.lastUsage = usage;
    this.totals.input += usage.input;
    this.totals.output += usage.output;
    this.totals.cacheRead += usage.cacheRead;
    this.totals.cacheWrite += usage.cacheWrite;
    this.totals.reasoning += usage.reasoning ?? 0;
    this.totals.cost += usage.cost.total;
    // Reset current turn to the real usage (more accurate than the
    // streaming chars/4 estimate).
    this.currentTurn = {
      output: usage.output,
      startedAt: this.currentTurn?.startedAt ?? Date.now(),
      messageId: messageId ?? this.currentTurn?.messageId,
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  snapshot(): ContextReportPayload {
    // Add the in-flight turn's streaming output to the anchor so the
    // gauge reflects "what the next LLM call will see" during streaming.
    const tokens =
      this.contextTokens === null
        ? null
        : this.contextTokens + (this.currentTurn?.output ?? 0);

    const percent =
      tokens === null || this.contextWindow <= 0
        ? null
        : (tokens / this.contextWindow) * 100;

    const context: ContextReportSnapshot = {
      tokens,
      contextWindow: this.contextWindow,
      percent,
    };

    return {
      type: "herman/context_report",
      schema: 1,
      modelKey: this.modelKey,
      context,
      totals: { ...this.totals },
      ...(this.lastUsage ? { lastUsage: cloneUsage(this.lastUsage) } : {}),
      ...(this.currentTurn ? { currentTurn: { ...this.currentTurn } } : {}),
      isCompacted: this.isCompacted,
      isStreaming: this.isStreaming,
      updatedAt: Date.now(),
    };
  }
}

function cloneUsage(usage: ContextReportUsage): ContextReportUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}
