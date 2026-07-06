import type { TabId } from "../../../shared/rpc.js";
import type { Tab } from "./agent-store.js";
import { desktopRpc } from "./desktop-rpc.js";

function notificationBody(tab: Tab): string {
  if (tab.connectionError) {
    return `Agent encountered an error in ${tab.title}`;
  }
  return `Agent finished in ${tab.title}`;
}

export function lastTurnHadError(tab: Tab): boolean {
  if (tab.connectionError) return true;
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const message = tab.messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      return (
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        !!message.errorMessage
      );
    }
    if (message.role === "user") break;
  }
  return false;
}

async function showNativeNotification(tab: Tab, tabId: TabId) {
  // Electrobun's Utils.showNotification tries the modern UNUserNotificationCenter
  // on macOS first. On unsigned dev builds (or when the user has denied permission)
  // authorization fails with UNErrorDomain Code=1, so Electrobun falls back to the
  // legacy NSUserNotificationCenter API. This is expected behaviour and matches the
  // Electrobun docs, which document macOS notifications as NSUserNotificationCenter.
  await desktopRpc.request.showNativeNotification({
    title: "Herman",
    body: notificationBody(tab),
    tabId,
  });
}

export async function notifyAgentFinished(tab: Tab, tabId: TabId) {
  // Don't celebrate a turn that actually failed.
  if (lastTurnHadError(tab)) return;

  await showNativeNotification(tab, tabId);
}
