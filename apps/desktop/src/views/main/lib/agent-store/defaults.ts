import type {
  ContextStats,
  FileDiff,
  Message,
  ModelMetadata,
  PersistedSession,
} from "../../../../shared/rpc.js";
import { createTabId, getProjectColor } from "../../../../shared/tab-utils.js";
import type { Tab } from "./types.js";

// ---------------------------------------------------------------------------
// Initial UI state
// ---------------------------------------------------------------------------

export const INITIAL_UI_STATE = {
  sidebarOpen: true,
  sidebarWidth: 288,
  composerValue: "",
  modelSelectorOpen: false,
  view: "home" as const,
  selectedProject: null as string | null,
  sidebarTab: "changes" as const,
  diffScope: "last-message" as const,
  diffFiles: {} as Record<string, FileDiff[]>,
  diffLoading: {} as Record<string, boolean>,
  modelMetadata: {} as Record<string, ModelMetadata>,
};

export const INITIAL_ADS_STATE = {
  focused: true,
  visible: true,
  nativeInsertionsThisSession: 0,
  nativeInsertionsToday: 0,
  nativeInsertionDate: new Date().toISOString().slice(0, 10),
  lastNativeMessageIndex: null as number | null,
};

// ---------------------------------------------------------------------------
// makeTab
// ---------------------------------------------------------------------------

export function makeTab(folderPath: string, title?: string): Tab {
  const now = Date.now();
  return {
    id: createTabId(),
    title: title ?? "New session",
    folderPath,
    projectRoot: folderPath,
    projectColor: getProjectColor(folderPath),
    messages: [],
    isThinking: false,
    showThinking: false,
    thinkingMessages: [],
    availableModels: [],
    connectionState: "idle",
    setup: { phase: "none" },
    createdAt: now,
    updatedAt: now,
    composerValue: "",
    queuedMessages: [],
    pendingAttachments: [],
    nativeAds: [],
  };
}

// ---------------------------------------------------------------------------
// emptyContextStats
// ---------------------------------------------------------------------------

/** Build a `ContextStats` placeholder for a freshly opened tab. The
 *  agent's `herman/context_report` event will replace this on the
 *  first turn; the placeholder just gives the UI a stable shape to
 *  render against. */
export function emptyContextStats(
  messages: Message[],
  currentModel: string | undefined,
): ContextStats {
  const [providerId, modelId] = currentModel ? currentModel.split("/", 2) : [undefined, undefined];
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
    ...(modelId ? { modelId: modelId ?? providerId } : {}),
    ...(providerId ? { providerId } : {}),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// syncSessionFromTab
// ---------------------------------------------------------------------------

export function syncSessionFromTab(sessions: PersistedSession[], tab: Tab): PersistedSession[] {
  const persisted: PersistedSession = {
    id: tab.id,
    title: tab.title,
    folderPath: tab.folderPath,
    projectRoot: tab.projectRoot,
    projectColor: tab.projectColor,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    currentModel: tab.currentModel,
  };
  return sessions.some((session) => session.id === tab.id)
    ? sessions.map((session) => (session.id === tab.id ? persisted : session))
    : [...sessions, persisted];
}
