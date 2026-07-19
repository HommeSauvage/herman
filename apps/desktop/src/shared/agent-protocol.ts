import { isAdPlacement } from "@herman/rpc/ads";
import type { AdCampaign, AdEvent, AdPlacement } from "@herman/rpc/ads";
import type { ModelMetadata } from "./rpc.js";
import {
  tryParseInstallEnvelope,
  tryParseWizardEnvelope,
  type WizardAskEnvelope,
  type WizardInstallEnvelope,
} from "./wizard-protocol.js";

export type AgentCommand =
  | { id?: string; type: "prompt"; message: string; messageId?: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" };

export type AgentResponse =
  | {
      id?: string;
      type: "response";
      command: string;
      success: true;
      data?: unknown;
    }
  | {
      id?: string;
      type: "response";
      command: string;
      success: false;
      error: string;
    };

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_complete"; messages?: unknown[] }
  | { type: "agent_error"; error: string }
  | {
      type: "message_update";
      message: Record<string, unknown>;
      assistantMessageEvent: Record<string, unknown>;
    }
  | { type: "message_end"; message: Record<string, unknown> }
  | { type: "message_start"; message: Record<string, unknown> }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "agent_end"; messages?: unknown[] }
  | { type: "extension_error"; extensionPath?: string; event?: string; error: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: string;
      [key: string]: unknown;
    }
  | {
      type: "models_sync";
      models: string[];
      currentModel?: string;
      /** Optional per-model metadata keyed by "provider/modelId". */
      modelMetadata?: Record<string, ModelMetadata>;
    }
  | {
      type: "herman/models_sync";
      models: string[];
      currentModel?: string;
      /** Optional per-model metadata keyed by "provider/modelId". */
      modelMetadata?: Record<string, ModelMetadata>;
    }
  | { type: "herman/provider_pinned"; modelName: string; providerId: string }
  | {
      type: "herman/context_usage";
      tokens: number | null;
      contextWindow: number;
      percent: number | null;
    }
  | {
      /**
       * Live, full context snapshot streamed by the `pi-context-reporter`
       * extension. Replaces `herman/context_usage` as the source of
       * truth for context-window / token data. Older agents (without
       * the extension) keep emitting `herman/context_usage` instead.
       */
      type: "herman/context_report";
      schema: 1;
      modelKey: string;
      context: {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      };
      totals: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning: number;
        cost: number;
      };
      lastUsage?: ContextReportUsageWire;
      currentTurn?: {
        output: number;
        startedAt: number;
        messageId?: string;
      };
      isCompacted: boolean;
      isStreaming: boolean;
      updatedAt: number;
    }
  | { type: "herman/agent_proxy_error"; error: string; code: string }
  | AdEvent;

/** Wire shape for a single LLM call's `usage`, matching the agent payload. */
type ContextReportUsageWire = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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

export type { AdCampaign, AdEvent, AdPlacement } from "@herman/rpc/ads";

/**
 * Events emitted by the wizard session orchestrator to the renderer over a
 * dedicated channel (NOT the tab AgentEvent path, since the wizard runs as a
 * detached bridge). See `wizard-session.ts`.
 */
export type WizardSessionEvent =
  | {
      type: "wizard_request";
      wizardSessionId: string;
      /** The extension_ui_request id the bridge must respond to. */
      requestId: string;
      envelope: WizardAskEnvelope;
    }
  | {
      type: "wizard_progress";
      wizardSessionId: string;
      text: string;
    }
  | {
      type: "wizard_models";
      wizardSessionId: string;
      models: string[];
      currentModel?: string;
    }
  | {
      type: "wizard_phase";
      wizardSessionId: string;
      phase: "planning" | "coding" | "qa" | "docs";
    }
  | {
      type: "wizard_complete";
      wizardSessionId: string;
      projectPath: string;
      summary?: string;
    }
  | {
      type: "wizard_end";
      wizardSessionId: string;
      error?: string;
    }
  | {
      type: "wizard_retrying";
      wizardSessionId: string;
      attempt: number;
      maxRetries: number;
      error?: string;
    }
  | {
      type: "wizard_install_request";
      wizardSessionId: string;
      /** The extension_ui_request id the bridge must respond to. */
      requestId: string;
      envelope: WizardInstallEnvelope;
    };

/**
 * If an `extension_ui_request` is an `editor` dialog carrying a wizard
 * question envelope (sentinel `__herman_wizard__`), return the parsed
 * envelope + request id so the bridge can route it to the React wizard
 * instead of a text editor. Returns undefined for real editor requests.
 *
 * Interactive user dialogs ride `ctx.ui.editor`; silent host queries ride
 * the host bridge HTTP API (see .agents/docs/host-bridge.md).
 */
export function tryParseWizardRequest(
  event: AgentEvent,
): { requestId: string; envelope: WizardAskEnvelope } | undefined {
  if (event.type !== "extension_ui_request") return undefined;
  if (event.method !== "editor") return undefined;
  const prefill = typeof event.prefill === "string" ? event.prefill : undefined;
  const envelope = tryParseWizardEnvelope(prefill);
  if (!envelope) return undefined;
  return { requestId: event.id, envelope };
}

/**
 * Same routing as tryParseWizardRequest, but for `herman_request_install`
 * editor dialogs carrying an install envelope (sentinel `__herman_install__`).
 */
export function tryParseInstallRequest(
  event: AgentEvent,
): { requestId: string; envelope: WizardInstallEnvelope } | undefined {
  if (event.type !== "extension_ui_request") return undefined;
  if (event.method !== "editor") return undefined;
  const prefill = typeof event.prefill === "string" ? event.prefill : undefined;
  const envelope = tryParseInstallEnvelope(prefill);
  if (!envelope) return undefined;
  return { requestId: event.id, envelope };
}

export function isAdEvent(event: AgentEvent): event is AdEvent {
  return event.type === "herman/ad_event";
}

export function parseAdEventFromNotify(payload: unknown): AdEvent | undefined {
  const event = parseNotifyJson(payload);
  if (!event) return undefined;

  if (event.type !== "herman/ad_event") return undefined;
  if (!isAdPlacement(event.placement)) return undefined;

  const campaign = event.campaign;
  if (!campaign || typeof campaign !== "object") return undefined;

  const c = campaign as Record<string, unknown>;
  if (
    typeof c.id !== "string" ||
    typeof c.brandName !== "string" ||
    typeof c.tagline !== "string" ||
    typeof c.destinationUrl !== "string"
  ) {
    return undefined;
  }

  const parsedCampaign: AdCampaign = {
    id: c.id,
    brandName: c.brandName,
    tagline: c.tagline,
    destinationUrl: c.destinationUrl,
    iconUrl: typeof c.iconUrl === "string" ? c.iconUrl : undefined,
    imageUrl: typeof c.imageUrl === "string" ? c.imageUrl : undefined,
    title: typeof c.title === "string" ? c.title : undefined,
    body: typeof c.body === "string" ? c.body : undefined,
    cta: typeof c.cta === "string" ? c.cta : undefined,
    accentColor: typeof c.accentColor === "string" ? c.accentColor : undefined,
  };

  return {
    type: "herman/ad_event",
    placement: event.placement as AdPlacement,
    campaign: parsedCampaign,
  };
}

export function parseHermanEventFromNotify(payload: unknown): AgentEvent | undefined {
  const event = parseNotifyJson(payload);
  if (!event || typeof event.type !== "string") return undefined;

  if (event.type === "herman/models_sync" || event.type === "models_sync") {
    const models = Array.isArray(event.models)
      ? event.models.filter((m): m is string => typeof m === "string")
      : [];
    const modelMetadata = parseModelMetadata(event.modelMetadata);
    return {
      type: "models_sync",
      models,
      currentModel: typeof event.currentModel === "string" ? event.currentModel : undefined,
      modelMetadata,
    };
  }

  if (event.type === "herman/provider_pinned") {
    if (typeof event.modelName !== "string" || typeof event.providerId !== "string")
      return undefined;
    return {
      type: "herman/provider_pinned",
      modelName: event.modelName,
      providerId: event.providerId,
    };
  }

  if (event.type === "herman/agent_proxy_error") {
    return {
      type: "herman/agent_proxy_error",
      error: typeof event.error === "string" ? event.error : "Herman server error",
      code: typeof event.code === "string" ? event.code : "proxy_error",
    };
  }

  if (event.type === "herman/context_usage") {
    const tokens = typeof event.tokens === "number" ? event.tokens : null;
    const contextWindow = typeof event.contextWindow === "number" ? event.contextWindow : 0;
    const percent = typeof event.percent === "number" ? event.percent : null;
    if (contextWindow > 0) {
      return {
        type: "herman/context_usage",
        tokens,
        contextWindow,
        percent,
      };
    }
  }

  if (event.type === "herman/context_report") {
    return parseContextReport(event);
  }

  return undefined;
}

function parseContextReport(event: Record<string, unknown>): AgentEvent | undefined {
  if (event.schema !== 1) return undefined;
  if (typeof event.modelKey !== "string") return undefined;
  const contextRaw = event.context;
  if (!contextRaw || typeof contextRaw !== "object") return undefined;
  const context = contextRaw as Record<string, unknown>;
  const tokens = typeof context.tokens === "number" ? context.tokens : null;
  const contextWindow = typeof context.contextWindow === "number" ? context.contextWindow : 0;
  const percent = typeof context.percent === "number" ? context.percent : null;

  const totalsRaw = event.totals;
  if (!totalsRaw || typeof totalsRaw !== "object") return undefined;
  const totals = totalsRaw as Record<string, unknown>;
  const normalizedTotals = {
    input: numberOr(totals.input, 0),
    output: numberOr(totals.output, 0),
    cacheRead: numberOr(totals.cacheRead, 0),
    cacheWrite: numberOr(totals.cacheWrite, 0),
    reasoning: numberOr(totals.reasoning, 0),
    cost: numberOr(totals.cost, 0),
  };

  const lastUsage = parseContextReportUsage(event.lastUsage);
  const currentTurnRaw = event.currentTurn;
  let currentTurn:
    | { output: number; startedAt: number; messageId?: string }
    | undefined;
  if (currentTurnRaw && typeof currentTurnRaw === "object") {
    const ct = currentTurnRaw as Record<string, unknown>;
    if (typeof ct.output === "number" && typeof ct.startedAt === "number") {
      currentTurn = {
        output: ct.output,
        startedAt: ct.startedAt,
        ...(typeof ct.messageId === "string" ? { messageId: ct.messageId } : {}),
      };
    }
  }

  return {
    type: "herman/context_report",
    schema: 1,
    modelKey: event.modelKey,
    context: { tokens, contextWindow, percent },
    totals: normalizedTotals,
    ...(lastUsage ? { lastUsage } : {}),
    ...(currentTurn ? { currentTurn } : {}),
    isCompacted: event.isCompacted === true,
    isStreaming: event.isStreaming === true,
    updatedAt: typeof event.updatedAt === "number" ? event.updatedAt : Date.now(),
  };
}

function parseContextReportUsage(value: unknown): ContextReportUsageWire | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  if (
    typeof u.input !== "number" ||
    typeof u.output !== "number" ||
    typeof u.cacheRead !== "number" ||
    typeof u.cacheWrite !== "number"
  ) {
    return undefined;
  }
  const costRaw = u.cost;
  if (!costRaw || typeof costRaw !== "object") return undefined;
  const c = costRaw as Record<string, unknown>;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    ...(typeof u.reasoning === "number" ? { reasoning: u.reasoning } : {}),
    totalTokens:
      typeof u.totalTokens === "number"
        ? u.totalTokens
        : u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: {
      input: numberOr(c.input, 0),
      output: numberOr(c.output, 0),
      cacheRead: numberOr(c.cacheRead, 0),
      cacheWrite: numberOr(c.cacheWrite, 0),
      total: numberOr(c.total, 0),
    },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type ModelMetadataMap = Record<string, ModelMetadata>;

function parseModelMetadata(value: unknown): ModelMetadataMap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const output: ModelMetadataMap = {};
  for (const [key, meta] of Object.entries(input)) {
    if (!meta || typeof meta !== "object") continue;
    const m = meta as Record<string, unknown>;
    const contextWindow = typeof m.contextWindow === "number" ? m.contextWindow : undefined;
    if (contextWindow === undefined || !Number.isFinite(contextWindow)) continue;
    const maxTokens = typeof m.maxTokens === "number" ? m.maxTokens : undefined;
    output[key] = { contextWindow, ...(maxTokens !== undefined && Number.isFinite(maxTokens) ? { maxTokens } : {}) };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function parseNotifyJson(payload: unknown): Record<string, unknown> | undefined {
  let parsed: Record<string, unknown>;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else if (payload && typeof payload === "object") {
    parsed = payload as Record<string, unknown>;
  } else {
    return undefined;
  }

  // Accept either the raw event or a JSONL-RPC notification envelope.
  return parsed.params && typeof parsed.params === "object"
    ? (parsed.params as Record<string, unknown>)
    : parsed;
}
