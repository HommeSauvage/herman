import type { ContextStats, Message, Usage } from "./rpc.js";

export type { ContextStats } from "./rpc.js";

/** Default context-window size when the model limit is unknown. */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

/** Known model context-window overrides (model id or provider/model id -> tokens). */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic Claude
  "claude-fable-5": 1_000_000,
  "claude-opus-4.8": 1_000_000,
  "claude-opus-4.7": 1_000_000,
  "claude-opus-4.6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4.6": 1_000_000,
  "claude-sonnet-4.5": 200_000,
  "claude-haiku-4.5": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-5-haiku": 200_000,

  // OpenAI GPT / o-series
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 128_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "o1": 200_000,
  "o1-mini": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,

  // Google Gemini
  "gemini-3.1-pro": 1_000_000,
  "gemini-3.1-flash": 1_000_000,
  "gemini-3.0-pro": 1_000_000,
  "gemini-3.0-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,

  // Grok
  "grok-3": 131_072,
  "grok-3-mini": 131_072,

  // Herman / Chinese frontier models
  "kimi-k2.7-code": 256_000,
  "kimi-k2.6": 256_000,
  "kimi-k2.5": 256_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v3": 128_000,
  "deepseek-v3.2": 128_000,
  "glm-5.2": 1_000_000,
  "glm-5.1": 200_000,
  "glm-4.5": 128_000,
  "minimax-m3": 1_000_000,
  "minimax-m2.7": 204_800,
  "minimax-m2.5": 204_800,
  "minimax-m2.1": 204_800,
  "minimax-m2": 204_800,
  "mimo-v2.5-pro": 1_000_000,
  "qwen3.7-max": 1_000_000,
};

function isValidNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeNumber(value: unknown): number {
  return isValidNumber(value) ? value : 0;
}

/** Estimate tokens from a string using the same chars/4 heuristic pi uses. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(message: Message): number {
  switch (message.role) {
    case "user":
      return estimateTextTokens(message.content);
    case "assistant": {
      if (message.usage && message.usage.totalTokens > 0) {
        return message.usage.totalTokens;
      }
      return estimateTextTokens(message.content);
    }
    case "tool":
      return estimateTextTokens(message.output ?? "");
    default:
      return 0;
  }
}

function calculateContextTokens(usage: Usage): number {
  return (
    usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

function getLastAssistantUsage(messages: Message[]): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage) continue;
    const total = calculateContextTokens(usage);
    if (total > 0) {
      return { usage, index: i };
    }
  }
  return undefined;
}

function inferContextLimit(modelId?: string, providerId?: string, contextLimit?: number): number {
  if (contextLimit !== undefined && Number.isFinite(contextLimit) && contextLimit > 0) {
    return contextLimit;
  }
  if (modelId) {
    const direct = MODEL_CONTEXT_LIMITS[modelId];
    if (direct) return direct;

    const lowerModel = modelId.toLowerCase();
    const sortedEntries = Object.entries(MODEL_CONTEXT_LIMITS).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [key, limit] of sortedEntries) {
      if (lowerModel.includes(key.toLowerCase())) return limit;
    }

    if (providerId) {
      const combined = `${providerId}/${modelId}`.toLowerCase();
      for (const [key, limit] of sortedEntries) {
        if (combined.includes(key.toLowerCase())) return limit;
      }
    }
  }

  return DEFAULT_CONTEXT_LIMIT;
}

export function estimateSessionTokens(messages: Message[]): number {
  const usageInfo = getLastAssistantUsage(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateMessageTokens(message);
    }
    return estimated;
  }

  let total = calculateContextTokens(usageInfo.usage);
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    total += estimateMessageTokens(messages[i]!);
  }
  return total;
}

export function computeContextStats(
  messages: Message[],
  modelId?: string,
  providerId?: string,
  contextLimit?: number,
): ContextStats {
  const now = Date.now();
  const usageInfo = getLastAssistantUsage(messages);
  const lastUsage = usageInfo?.usage;

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCost = 0;

  if (lastUsage) {
    inputTokens = lastUsage.input;
    outputTokens = lastUsage.output;
    reasoningTokens = lastUsage.reasoning ?? 0;
    cacheReadTokens = lastUsage.cacheRead;
    cacheWriteTokens = lastUsage.cacheWrite;
    estimatedCost = lastUsage.cost?.total ?? 0;
  }

  // Estimate incremental tokens for messages after the last authoritative usage.
  for (let i = (usageInfo?.index ?? -1) + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.usage) {
      // Streaming assistant messages may have partial/empty usage; only add real values.
      inputTokens += safeNumber(message.usage.input);
      outputTokens += safeNumber(message.usage.output);
      reasoningTokens += safeNumber(message.usage.reasoning);
      cacheReadTokens += safeNumber(message.usage.cacheRead);
      cacheWriteTokens += safeNumber(message.usage.cacheWrite);
      estimatedCost += message.usage.cost?.total ?? 0;
    } else {
      inputTokens += estimateMessageTokens(message);
    }
  }

  const totalTokens = estimateSessionTokens(messages);
  const resolvedContextLimit = inferContextLimit(modelId, providerId, contextLimit);
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const assistantMessageCount = messages.filter((m) => m.role === "assistant").length;
  const toolMessageCount = messages.filter((m) => m.role === "tool").length;

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCost,
    contextLimit: resolvedContextLimit,
    messageCount: messages.length,
    userMessageCount,
    assistantMessageCount,
    toolMessageCount,
    modelId,
    providerId,
    updatedAt: now,
  };
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function clampPercentage(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 100;
  return Math.round(value * 100);
}
