import { useEffect, useRef } from "react";

import type { TabId } from "../../../shared/rpc.js";
import { notifyAgentFinished, lastTurnHadError } from "../lib/agent-notifications.js";
import { useAgentStore } from "../lib/agent-store.js";

/** Debounce period: agent must be idle this long before we notify. */
const IDLE_DEBOUNCE_MS = 2_500;

/**
 * Check whether the agent is truly idle — not thinking, not streaming,
 * not crashed, and not waiting for an auto-retry.
 */
function isAgentTrulyDone(tab: {
  isThinking: boolean;
  connectionState: string;
  connectionError?: string;
  retryState?: { attempt: number; message: string; next: number };
  messages: { role: string; isStreaming?: boolean; status?: string }[];
}): boolean {
  if (tab.isThinking) return false;
  if (tab.connectionState === "crashed") return false;
  if (tab.retryState) return false;
  // Treat empty string as no error (some code paths set connectionError to "").
  if (tab.connectionError && tab.connectionError.length > 0) return false;
  // Double-check: no streaming messages still in flight.
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m = tab.messages[i];
    if (!m) continue;
    if (m.role === "assistant" && m.isStreaming) return false;
    if (m.role === "tool" && m.status === "running") return false;
    if (m.role === "user") break;
  }
  return true;
}

/**
 * Show a native Electrobun notification when an agent finishes work on a tab
 * that isn't currently focused.
 *
 * The web Notification API is intentionally not used; Electrobun's native
 * notification path is the documented cross-platform approach for this
 * framework. The pending tab is activated when the window next receives focus.
 */
export function useAgentFinishedNotifications() {
  /** Tracks which turn keys have already been notified. */
  const notifiedRef = useRef(new Map<TabId, number>());

  /**
   * Pending notification timers, keyed by tab ID.
   * When an agent finishes a turn, we don't fire immediately — we wait
   * IDLE_DEBOUNCE_MS to ensure the agent isn't about to start another
   * turn (e.g. processing queued follow-ups).  If the agent starts
   * thinking again before the timer fires, we cancel it.
   */
  const debounceTimers = useRef(new Map<TabId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    return useAgentStore.subscribe((state, prevState) => {
      if (state.ads.focused) return;

      for (const [tabId, tab] of Object.entries(state.tabs)) {
        const prevTab = prevState.tabs[tabId];
        if (!prevTab) continue;

        // When the agent starts a new turn, cancel any pending notification
        // debounce and reset the notification gate so this turn can produce
        // a notification when it finishes.
        if (!prevTab.isThinking && tab.isThinking) {
          notifiedRef.current.delete(tabId);
          const timer = debounceTimers.current.get(tabId);
          if (timer) {
            clearTimeout(timer);
            debounceTimers.current.delete(tabId);
          }
          continue;
        }

        // Only fire when the agent transitions from working to truly idle.
        // This skips transient false→true→false cycles during auto-retry,
        // crashes, and aborts.
        if (prevTab.isThinking && !tab.isThinking && isAgentTrulyDone(tab) && !lastTurnHadError(tab)) {
          // Use thinkingStartedAt as the dedup key.  It is now always set
          // when isThinking becomes true (see applyAgentEvent:agent_start).
          const turnKey = prevTab.thinkingStartedAt;
          if (turnKey === undefined) continue;
          if (notifiedRef.current.get(tabId) === turnKey) continue;

          // Debounce: wait to ensure the agent isn't about to start another
          // turn immediately (e.g. processing queued follow-ups).
          const existing = debounceTimers.current.get(tabId);
          if (existing) clearTimeout(existing);

          debounceTimers.current.set(
            tabId,
            setTimeout(() => {
              debounceTimers.current.delete(tabId);

              // Re-check: the agent may have started another turn while we
              // were waiting.  Fetch the latest tab state from the store.
              const latest = useAgentStore.getState().tabs[tabId];
              if (!latest || latest.isThinking || !isAgentTrulyDone(latest) || lastTurnHadError(latest)) {
                return;
              }

              notifiedRef.current.set(tabId, turnKey);
              void notifyAgentFinished(latest, tabId);
            }, IDLE_DEBOUNCE_MS),
          );
        }
      }
    });
  }, []);
}
