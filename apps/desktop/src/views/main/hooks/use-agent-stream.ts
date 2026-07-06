import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

import type { AdCampaign, AgentEvent } from "../../../shared/agent-protocol.js";
import { isContextTool } from "../../../shared/context-tools.js";
import type { AgentStatus, TabId } from "../../../shared/rpc.js";
import { retryAgent } from "../lib/agent-actions.js";
import { isTabAgentRunning, useAgentStore, useAppStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";

const FAST_POLL_MS = 120;
const IDLE_POLL_MS = 600;

/**
 * Tool output updates can arrive at very high frequency while a tool is
 * streaming. Rather than dispatching each chunk to the store immediately,
 * we buffer the last update per tool call and flush on a short frame.
 */
const TOOL_UPDATE_FLUSH_MS = 24;
const toolUpdateBuffers = new Map<
  TabId,
  Map<string, AgentEvent & { type: "tool_execution_update" }>
>();
const toolUpdateTimers = new Map<TabId, ReturnType<typeof setTimeout>>();

function flushToolUpdates(tabId: TabId) {
  const timer = toolUpdateTimers.get(tabId);
  if (timer) clearTimeout(timer);
  toolUpdateTimers.delete(tabId);

  const buffer = toolUpdateBuffers.get(tabId);
  if (!buffer || buffer.size === 0) return;

  for (const event of buffer.values()) {
    useAgentStore.getState().recordAgentEvent(tabId, event);
  }
  buffer.clear();
}

function bufferToolUpdate(tabId: TabId, event: AgentEvent & { type: "tool_execution_update" }) {
  let buffer = toolUpdateBuffers.get(tabId);
  if (!buffer) {
    buffer = new Map();
    toolUpdateBuffers.set(tabId, buffer);
  }
  buffer.set(event.toolCallId, event);

  if (!toolUpdateTimers.has(tabId)) {
    toolUpdateTimers.set(
      tabId,
      setTimeout(() => flushToolUpdates(tabId), TOOL_UPDATE_FLUSH_MS),
    );
  }
}

/**
 * Process a single agent event from the IPC stream into the store.
 *
 * This is the live-rendering path: events arrive via IPC and are applied
 * one-by-one so the UI streams text character-by-character and shows tool
 * output as it arrives.  The polling fallback (useAgentEventPolling) is a
 * separate full-sync path that replaces the entire messages array from the
 * main process — it does NOT replay individual events.
 */
function processAgentEvent(tabId: TabId, event: AgentEvent) {
  if (event.type === "tool_execution_update") {
    // Context tool intermediate updates are no-ops in the store; skip buffering.
    if (isContextTool(event.toolName)) return;
    bufferToolUpdate(tabId, event);
    return;
  }

  // Preserve ordering: flush any pending tool updates before a lifecycle,
  // message, or tool-end event is applied.
  flushToolUpdates(tabId);

  const needsFlush =
    event.type === "message_start" ||
    event.type === "message_end" ||
    (event.type === "message_update" &&
      (event.assistantMessageEvent as { type?: string })?.type === "text_delta");

  if (needsFlush) {
    flushSync(() => {
      useAgentStore.getState().recordAgentEvent(tabId, event);
    });
  } else {
    useAgentStore.getState().recordAgentEvent(tabId, event);
  }
}

/**
 * Returns true when the tab has an actively streaming assistant message
 * (content still being filled).  This is more reliable than `isThinking`
 * because the main process keeps `isStreaming` on the message object
 * regardless of whether the `agent_start` event arrived via IPC.
 *
 * Walks backwards past tool messages, stopping at the first user message,
 * so a streaming assistant followed by completed tool results still counts
 * as actively streaming.
 */
function isActivelyStreaming(tab: {
  messages: { role: string; isStreaming?: boolean; status?: string }[];
}): boolean {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const message = tab.messages[i];
    if (!message) continue;
    if (message.role === "assistant" && message.isStreaming) return true;
    if (message.role === "tool" && message.status === "running") return true;
    if (message.role === "user") return false;
  }
  return false;
}

/**
 * Poll the main process for the authoritative tab state.
 *
 * Instead of replaying individual buffered events (which requires complex
 * dedup and can create duplicate messages when the webview reloads), every
 * poll cycle fetches the full tab from the main process.  The main process
 * is the single source of truth for message order and lifecycle flags.
 *
 * Poll speed is adaptive: fast (120 ms) while the tab is actively streaming
 * so the UI catches missed deltas quickly; slow (600 ms) while idle.
 */
function useAgentEventPolling() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let stopped = false;

    const scheduleNext = (delayMs: number) => {
      if (stopped) return;
      timerRef.current = setTimeout(poll, delayMs);
    };

    const poll = async () => {
      if (stopped) return;

      const { activeTabId, tabs } = useAgentStore.getState();
      if (!activeTabId) {
        scheduleNext(IDLE_POLL_MS);
        return;
      }

      const tab = tabs[activeTabId];
      if (!tab) {
        scheduleNext(IDLE_POLL_MS);
        return;
      }

      const streaming = isActivelyStreaming(tab);

      try {
        // Replace the renderer's messages with the main process's version.
        // The main process processes every agent event synchronously and is
        // the authoritative source — no individual event replay, no dedup.
        const { tabs: freshTabs } = await desktopRpc.request.getTabs();
        const freshTab = freshTabs.find((t) => t.id === activeTabId);
        if (freshTab) {
          useAgentStore.getState().updateTab(activeTabId, {
            messages: freshTab.messages,
            isThinking: freshTab.isThinking,
            availableModels: freshTab.availableModels,
            currentModel: freshTab.currentModel,
            connectionError: freshTab.connectionError,
            ...(freshTab.connectionState !== tab.connectionState
              ? { connectionState: freshTab.connectionState }
              : {}),
          });
        }
      } catch {
        // Best-effort.
      }

      scheduleNext(streaming ? FAST_POLL_MS : IDLE_POLL_MS);
    };

    // Start the first poll after a short delay to let the initial state settle.
    scheduleNext(200);

    return () => {
      stopped = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      for (const tabId of toolUpdateTimers.keys()) {
        flushToolUpdates(tabId);
      }
    };
  }, []);
}

/**
 * Maximum time (ms) the "Thinking..." indicator is allowed to stay visible
 * before being force-cleared.  This is a safety net for when `agent_end`
 * events are lost — the IPC layer is known to be unreliable under
 * high-throughput streaming, and the polling fallback only covers the
 * active tab.  Two minutes is generous for any legitimate thinking phase.
 */
const THINKING_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Safety timeout that force-clears `isThinking` for any tab that has been
 * stuck in the thinking state for longer than THINKING_TIMEOUT_MS.
 */
function useThinkingTimeout() {
  useEffect(() => {
    const interval = setInterval(() => {
      const { tabs } = useAgentStore.getState();
      const now = Date.now();
      for (const tab of Object.values(tabs)) {
        if (
          tab.isThinking &&
          tab.thinkingStartedAt &&
          now - tab.thinkingStartedAt > THINKING_TIMEOUT_MS
        ) {
          useAgentStore.getState().setThinking(tab.id, false);
        }
      }
    }, 5_000);

    return () => clearInterval(interval);
  }, []);
}

/**
 * Watch for tabs that have an active retry state whose `next` timestamp has
 * elapsed, and trigger the actual retry.  This is separate from the store
 * because the retry involves async RPC calls.
 */
function useAutoRetry() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const check = () => {
      const { tabs } = useAgentStore.getState();
      const now = Date.now();

      for (const tab of Object.values(tabs)) {
        if (!tab.retryState) continue;
        if (tab.retryState.next > now) continue;

        // Time to retry! Trigger the retry — the subsequent connection state
        // change will clear or increment retryState as appropriate.
        void retryAgent(tab.id).catch(() => {
          // Error will surface via connectionState.
        });
      }
    };

    // Check every 500ms — fine granularity for countdown display.
    timerRef.current = setInterval(check, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);
}

export function useAgentStream() {
  const session = useAppStore((s) => s.session);
  const activeTabId = useAgentStore((s) => s.activeTabId);

  useAgentEventPolling();
  useThinkingTimeout();
  useAutoRetry();

  useEffect(() => {
    const listener = ({ tabId, event }: { tabId: TabId; event: AgentEvent }) => {
      processAgentEvent(tabId, event);
    };
    desktopRpc.addMessageListener("agentEvent", listener);
    return () => desktopRpc.removeMessageListener("agentEvent", listener);
  }, []);

  useEffect(() => {
    const listener = ({
      tabId,
      state,
      stderr,
    }: {
      tabId: TabId;
      state: AgentStatus["state"];
      stderr?: string;
    }) => {
      useAgentStore.getState().setConnectionState(tabId, { state, stderr });
    };
    desktopRpc.addMessageListener("agentStatusChanged", listener);
    return () => desktopRpc.removeMessageListener("agentStatusChanged", listener);
  }, []);

  useEffect(() => {
    const listener = ({ focused, visible }: { focused: boolean; visible: boolean }) => {
      useAgentStore.getState().setAdVisibility(focused, visible);
    };
    desktopRpc.addMessageListener("adVisibilityChanged", listener);
    return () => desktopRpc.removeMessageListener("adVisibilityChanged", listener);
  }, []);

  useEffect(() => {
    const listener = ({
      tabId,
      placement,
      campaign,
    }: {
      tabId: TabId;
      placement: "thinking_banner" | "sidebar" | "native";
      campaign: AdCampaign;
    }) => {
      useAgentStore.getState().recordAgentEvent(tabId, {
        type: "herman/ad_event",
        placement,
        campaign,
      });
    };
    desktopRpc.addMessageListener("adEvent", listener);
    return () => desktopRpc.removeMessageListener("adEvent", listener);
  }, []);

  useEffect(() => {
    if (!session || !activeTabId) return;

    if (!isTabAgentRunning(activeTabId)) return;

    void desktopRpc.request
      .agentRequest({ tabId: activeTabId, command: { type: "get_state" } })
      .catch(() => {
        // Best-effort: the polling fallback keeps the tab state in sync.
      });
  }, [session, activeTabId]);
}
