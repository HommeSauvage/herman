import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { ContextStats, Message } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { loadMessagesFromPiSessionFile, normalizePiMessage } from "./pi-messages.js";
import {
  extractPiSessionIdFromFilePath,
  piSessionDir,
  resolvePiSessionFile,
} from "./pi-session.js";

export type SessionSnapshot = {
  messages: Message[];
  contextStats?: ContextStats;
  piSessionId?: string;
  sessionFile?: string;
};

/** Synchronous read of pi session JSONL — the instant paint path for tab open. */
export function readSessionSnapshot(tabId: TabId, piSessionId?: string): SessionSnapshot {
  const sessionFile = resolvePiSessionFile(piSessionId);
  const resolvedPiSessionId = sessionFile
    ? extractPiSessionIdFromFilePath(sessionFile)
    : piSessionId;
  if (!sessionFile) {
    return { messages: [], piSessionId: resolvedPiSessionId };
  }

  const messages = loadMessagesFromPiSessionFile(tabId, piSessionId);
  const contextStats = buildContextStatsFromSessionFile(sessionFile, messages);
  return { messages, contextStats, piSessionId: resolvedPiSessionId, sessionFile };
}

function buildContextStatsFromSessionFile(
  sessionFile: string,
  messages: Message[],
): ContextStats | undefined {
  try {
    const sessionManager = SessionManager.open(sessionFile, piSessionDirFromFile(sessionFile));
    const branch = sessionManager.getBranch();
    return buildContextStatsFromBranch(branch, messages);
  } catch {
    return buildContextStatsFromMessages(messages);
  }
}

function piSessionDirFromFile(sessionFile: string): string {
  const idx = sessionFile.lastIndexOf("/");
  return idx >= 0 ? sessionFile.slice(0, idx) : sessionFile;
}

type BranchEntry = {
  type: string;
  provider?: string;
  modelId?: string;
  message?: unknown;
};

function buildContextStatsFromBranch(
  branch: BranchEntry[],
  messages: Message[],
): ContextStats {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let cost = 0;
  let modelKey: string | undefined;
  let contextWindow = 0;

  for (const entry of branch) {
    if (entry.type === "model_change" && entry.provider && entry.modelId) {
      modelKey = `${entry.provider}/${entry.modelId}`;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const usage = record.usage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    const uInput = typeof u.input === "number" ? u.input : 0;
    const uOutput = typeof u.output === "number" ? u.output : 0;
    if (uInput === 0 && uOutput === 0) continue;
    input += uInput;
    output += uOutput;
    cacheRead += typeof u.cacheRead === "number" ? u.cacheRead : 0;
    cacheWrite += typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
    reasoning += typeof u.reasoning === "number" ? u.reasoning : 0;
    const costRaw = u.cost;
    if (costRaw && typeof costRaw === "object") {
      const c = costRaw as Record<string, number>;
      cost += typeof c.total === "number" ? c.total : 0;
    }
    if (typeof record.model === "string" && typeof record.provider === "string") {
      modelKey = `${record.provider}/${record.model}`;
    }
  }

  const [providerId, modelId] = modelKey ? modelKey.split("/", 2) : [undefined, undefined];
  const gaugeTokens = input + output + cacheRead + cacheWrite;

  return {
    totalTokens: gaugeTokens,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    estimatedCost: cost,
    contextLimit: contextWindow,
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === "user").length,
    assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
    toolMessageCount: messages.filter((m) => m.role === "tool").length,
    ...(modelId ? { modelId } : {}),
    ...(providerId ? { providerId } : {}),
    updatedAt: Date.now(),
  };
}

function buildContextStatsFromMessages(messages: Message[]): ContextStats | undefined {
  if (messages.length === 0) return undefined;
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    contextLimit: 0,
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === "user").length,
    assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
    toolMessageCount: messages.filter((m) => m.role === "tool").length,
    updatedAt: Date.now(),
  };
}

/** Map a live `herman/context_report` agent event to desktop `ContextStats`. */
export function contextStatsFromContextReport(
  event: Extract<import("../shared/agent-protocol.js").AgentEvent, { type: "herman/context_report" }>,
  messages: Message[],
): ContextStats {
  const [providerId, modelId] = event.modelKey.includes("/")
    ? event.modelKey.split("/", 2)
    : [undefined, event.modelKey];
  return {
    totalTokens: event.context.tokens ?? 0,
    inputTokens: event.totals.input,
    outputTokens: event.totals.output,
    reasoningTokens: event.totals.reasoning,
    cacheReadTokens: event.totals.cacheRead,
    cacheWriteTokens: event.totals.cacheWrite,
    estimatedCost: event.totals.cost,
    contextLimit: event.context.contextWindow,
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === "user").length,
    assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
    toolMessageCount: messages.filter((m) => m.role === "tool").length,
    ...(modelId ? { modelId } : {}),
    ...(providerId ? { providerId } : {}),
    updatedAt: event.updatedAt,
    isCompacted: event.isCompacted,
    isStreaming: event.isStreaming,
    ...(event.currentTurn ? { currentTurnOutput: event.currentTurn.output } : {}),
  };
}
