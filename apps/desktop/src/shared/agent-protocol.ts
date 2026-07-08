import { isAdPlacement } from "@herman/rpc/ads";
import type { AdCampaign, AdEvent, AdPlacement } from "@herman/rpc/ads";
import type { ModelMetadata } from "./rpc.js";

export type AgentCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "bash"; command: string };

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
  | { type: "herman/agent_proxy_error"; error: string; code: string }
  | AdEvent;

export type { AdCampaign, AdEvent, AdPlacement } from "@herman/rpc/ads";

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

  return undefined;
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
