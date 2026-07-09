import type { TabId } from "../../../shared/rpc.js";
import { isTabAgentRunning, useAgentStore } from "./agent-store.js";
import { desktopRpc } from "./desktop-rpc.js";
import { formatAttachmentsForPrompt } from "./attachment-format.js";

export async function sendPrompt(tabId: TabId, text: string) {
  const store = useAgentStore.getState();
  const tab = store.tabs[tabId];
  // Serialize pending attachments into the prompt text before the
  // user message is stored / sent.  The agent only ever sees the
  // final string, so the on-screen chips can stay a UI-only concept.
  const pendingAttachments = tab?.pendingAttachments ?? [];
  const message = formatAttachmentsForPrompt(text, pendingAttachments);

  const messageId = store.appendUserMessage(tabId, message);
  store.setComposerValue(tabId, "");
  // Clear attachments once the prompt is sent — they belong to a
  // single turn and shouldn't be re-sent on the next one.
  if (pendingAttachments.length > 0) {
    store.clearAttachments(tabId);
  }
  store.setThinking(tabId, true);

  try {
    await desktopRpc.request.agentRequest({
      tabId,
      command: { type: "prompt", message, ...(messageId ? { messageId } : {}) },
    });
  } catch (error) {
    store.setConnectionState(tabId, {
      state: "crashed",
      stderr: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function abortAgent(tabId: TabId) {
  // Clear the UI streaming state immediately so the stop button always
  // feels responsive, even if the abort RPC is slow or fails.
  useAgentStore.getState().stopStreaming(tabId);
  await desktopRpc.request.abortAgent({ tabId });
}

/** Tracks tabs with an in-flight retry to prevent concurrent restarts. */
const retryingTabs = new Set<TabId>();

/**
 * Retry a crashed agent: restart the process and re-submit the last visible
 * user message so the agent picks up where it left off.
 *
 * Safe to call at any time — no-ops if the agent is already running, idle,
 * or another retry is in progress for the same tab.
 */
export async function retryAgent(tabId: TabId) {
  if (retryingTabs.has(tabId)) return;

  const store = useAgentStore.getState();
  const tab = store.tabs[tabId];
  if (!tab) return;

  // Only retry if the agent is actually crashed.
  if (tab.connectionState !== "crashed" && !tab.connectionError) return;

  // Find the last VISIBLE user message to re-submit (respects revert boundary).
  const revertIdx = tab.revertMessageId
    ? tab.messages.findIndex((m) => m.id === tab.revertMessageId)
    : -1;
  const visibleMessages = revertIdx >= 0 ? tab.messages.slice(0, revertIdx) : tab.messages;
  const lastUserMessage = [...visibleMessages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUserMessage?.content;

  // Clear error state optimistically, but leave retryState so the
  // connection-state handler can properly increment the attempt counter
  // if the restart fails.
  retryingTabs.add(tabId);
  store.updateTab(tabId, {
    connectionError: undefined,
    connectionStderr: undefined,
  });

  try {
    await desktopRpc.request.restartAgent({ tabId });

    // After restart, resubmit the last user prompt so the agent continues.
    if (lastUserContent) {
      store.setThinking(tabId, true);
      await desktopRpc.request.agentRequest({
        tabId,
        command: { type: "prompt", message: lastUserContent },
      });
    }
  } catch (error) {
    store.setConnectionState(tabId, {
      state: "crashed",
      stderr: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    retryingTabs.delete(tabId);
  }
}

export async function selectModel(tabId: TabId, modelId: string) {
  if (!isTabAgentRunning(tabId)) {
    // The model can only be changed while the agent is running.
    return;
  }
  const [provider, id] = modelId.includes("/") ? modelId.split("/") : ["herman", modelId];
  try {
    await desktopRpc.request.agentRequest({
      tabId,
      command: { type: "set_model", provider, modelId: id },
    });
  } catch {
    // Best-effort: the model selector will still show the previous selection.
  }
}

export async function requestAvailableModels(tabId: TabId) {
  if (!isTabAgentRunning(tabId)) {
    // The agent must be running to answer this request; otherwise the list
    // is populated later via herman/models_sync events.
    return;
  }
  try {
    await desktopRpc.request.agentRequest({
      tabId,
      command: { type: "get_available_models" },
    });
  } catch {
    // Best-effort: models are also pushed via herman/models_sync events.
  }
}

export async function setTabFolder(tabId: TabId, folderPath?: string) {
  const result = await desktopRpc.request.setTabFolder({ tabId, folderPath });
  return result.folderPath;
}

export async function selectTabProject(tabId: TabId, folderPath: string) {
  const result = await desktopRpc.request.selectTabProject({ tabId, folderPath });
  return result.folderPath;
}

export async function createTab(folderPath?: string) {
  await desktopRpc.request.createTab({ folderPath });
}

export async function closeTab(tabId: TabId) {
  const store = useAgentStore.getState();
  // When closing the active tab, prefer the live textarea value because the
  // store is only synced on blur/unmount to avoid per-keystroke re-renders.
  const isActive = store.activeTabId === tabId;
  const textareaValue =
    isActive && typeof document !== "undefined"
      ? document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.value
      : undefined;
  const composerValue = textareaValue ?? store.tabs[tabId]?.composerValue ?? "";
  await desktopRpc.request.setComposerDraft({ tabId, value: composerValue });
  await desktopRpc.request.closeTab({ tabId });
}

export async function activateTab(tabId: TabId) {
  await desktopRpc.request.activateTab({ tabId });
  useAgentStore.getState().setView("session");
}

export async function openSession(sessionId: TabId) {
  await desktopRpc.request.openSession({ sessionId });
  useAgentStore.getState().setView("session");
}

export async function openProject() {
  const result = await desktopRpc.request.openProject({});
  if (!result.folderPath) return;

  const { projects } = await desktopRpc.request.getProjectsAndSessions();
  useAgentStore.getState().handleProjectOpened(result.folderPath, projects);
}

export async function openProjectPath(folderPath: string) {
  const result = await desktopRpc.request.openProject({ folderPath });
  return result.folderPath;
}

export async function closeProject(folderPath: string) {
  await desktopRpc.request.closeProject({ folderPath });
}

export async function signOut() {
  await desktopRpc.request.signOut();
}

export async function reportAdClick(
  campaignId: string,
  placement: "thinking_banner" | "sidebar" | "native",
) {
  await desktopRpc.request.reportAdClick({ campaignId, placement });
}

export async function reportImpression(params: {
  campaignId: string;
  placement: "thinking_banner" | "sidebar" | "native";
  durationMs: number;
  wasFocused: boolean;
  wasVisible: boolean;
  thinkingDurationMs?: number;
}) {
  await desktopRpc.request.reportImpression(params);
}
