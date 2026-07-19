import type { ContextStats, Message } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { readSessionSnapshot, type SessionSnapshot } from "./session-snapshot.js";
import { loadTabHistoryCache } from "./tab-history.js";
import type { PersistedSession } from "./window-state.js";

export type InstantHydration = {
  messages: Message[];
  contextStats?: ContextStats;
  piSessionId?: string;
  hydrationStatus: "pending" | "success" | "empty";
};

/** Merge cache + pi snapshot for instant tab paint (no agent wait). */
export async function loadInstantHydration(
  tabId: TabId,
  persisted: PersistedSession,
): Promise<InstantHydration> {
  const cache = await loadTabHistoryCache(tabId);
  const snapshot = readSessionSnapshot(tabId, persisted.piSessionId);

  const merged = mergeHydrationSources(cache?.messages ?? [], cache?.contextStats, snapshot);

  const piSessionId = persisted.piSessionId ?? snapshot.piSessionId ?? cache?.piSessionId;

  const hydrationStatus =
    merged.messages.length > 0 ? "success" : persisted.folderPath ? "pending" : "empty";

  return {
    messages: merged.messages,
    contextStats: merged.contextStats,
    piSessionId,
    hydrationStatus,
  };
}

function mergeHydrationSources(
  cacheMessages: Message[],
  cacheContextStats: ContextStats | undefined,
  snapshot: SessionSnapshot,
): { messages: Message[]; contextStats?: ContextStats } {
  if (snapshot.messages.length >= cacheMessages.length && snapshot.messages.length > 0) {
    return {
      messages: snapshot.messages,
      contextStats: snapshot.contextStats ?? cacheContextStats,
    };
  }

  if (cacheMessages.length > 0) {
    return {
      messages: cacheMessages,
      contextStats: cacheContextStats ?? snapshot.contextStats,
    };
  }

  return {
    messages: snapshot.messages,
    contextStats: snapshot.contextStats ?? cacheContextStats,
  };
}
