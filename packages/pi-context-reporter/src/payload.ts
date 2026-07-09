/**
 * Payload schema for the `herman/context_report` event.
 *
 * This file is the single source of truth for the wire format between the
 * agent's `pi-context-reporter` extension and the Herman desktop app. The
 * desktop mirrors the same shape in `apps/desktop/src/shared/...`.
 *
 * Wire format: an `extension_ui_request` envelope with `method: "notify"`
 * and `message` containing a JSON-stringified `ContextReportPayload`.
 *
 * We intentionally re-declare the `Usage` shape here (rather than import
 * it from `@earendil-works/pi-ai`) so the wire format is decoupled from
 * any upstream package renames.
 */

/** Token usage breakdown for a single LLM call, as reported by the provider. */
export type ContextReportUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning/thinking tokens (subset of `output`). Provider-specific. */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

/** Cumulative session-wide token totals. */
export type ContextReportTotals = {
  /** Sum of `usage.input` across all assistant messages in the session. */
  input: number;
  /** Sum of `usage.output` across all assistant messages in the session. */
  output: number;
  /** Sum of `usage.cacheRead` across all assistant messages. */
  cacheRead: number;
  /** Sum of `usage.cacheWrite` across all assistant messages. */
  cacheWrite: number;
  /** Sum of `usage.reasoning` (subset of `output`). */
  reasoning: number;
  /** Sum of `usage.cost.total` across all assistant messages. */
  cost: number;
};

/** Running estimate of the current turn's output tokens. */
export type ContextReportCurrentTurn = {
  /** Streaming output estimate (chars/4 of deltas + final usage if known). */
  output: number;
  /** Wall-clock time (ms) when the current assistant turn started. */
  startedAt: number;
  /** Assistant message id (for correlating with desktop's local message list). */
  messageId?: string;
};

/**
 * The current context-window snapshot — what the fuel gauge displays.
 *
 * `tokens` and `percent` are `null` when the agent does not know the
 * current context size (e.g. immediately after a compaction, before the
 * next LLM response). The desktop should render a "?" in that case.
 */
export type ContextReportSnapshot = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

/**
 * Full payload sent on every `herman/context_report` notify.
 *
 * Designed so the desktop can replace the entire `ContextStats` value
 * with this object without re-deriving anything.
 */
export type ContextReportPayload = {
  type: "herman/context_report";
  /** Schema version of this payload (incremented on breaking changes). */
  schema: 1;
  /** Current model (e.g. "anthropic/claude-sonnet-4.6"). */
  modelKey: string;
  /** Current context-window snapshot. */
  context: ContextReportSnapshot;
  /** Cumulative session totals. */
  totals: ContextReportTotals;
  /** Last finalized `message_end.usage` from an assistant turn. */
  lastUsage?: ContextReportUsage;
  /** Running estimate for the in-flight assistant turn (if any). */
  currentTurn?: ContextReportCurrentTurn;
  /**
   * True immediately after a `session_compact` event and before the next
   * authoritative `message_end` arrives. The desktop should suppress
   * the gauge and show "compact pending".
   */
  isCompacted: boolean;
  /** True while the agent is mid-turn (between `agent_start` and `agent_end`). */
  isStreaming: boolean;
  /** Wall-clock time (ms) when this report was generated. */
  updatedAt: number;
};

/** Window under which notify calls are coalesced (ms). */
export const REPORT_THROTTLE_MS = 200;

export const CONTEXT_REPORT_EVENT = "herman/context_report" as const;
