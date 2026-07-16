import { useEffect, useRef } from "react";

import type { OutgoingMessages, TabId } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { usePreviewStore } from "../lib/preview-store.js";

type UsePreviewControllerParams = {
  folderPath: string;
  projectRoot?: string;
  tabId?: TabId;
  isWorktree?: boolean;
};

/**
 * Owns the preview store's lifecycle wiring for a `PreviewPane`:
 *  - (re)activates the store whenever the folder/tab/worktree identity changes
 *  - forwards `previewStatusChanged` / `previewLog` push events into the store
 *  - refreshes the draft summary once the active tab finishes thinking
 *
 * Never stops the underlying Bun preview server(s) on cleanup — servers keep
 * running across tab switches / unmounts so re-opening the pane is instant.
 */
export function usePreviewController({
  folderPath,
  projectRoot,
  tabId,
  isWorktree,
}: UsePreviewControllerParams): void {
  useEffect(() => {
    // Listeners are registered *before* `activate` so no push event that
    // arrives while the initial load is in flight can be missed.
    const handleStatus = (payload: OutgoingMessages["previewStatusChanged"]) => {
      usePreviewStore.getState().acceptStatus(payload);
    };
    const handleLog = (payload: OutgoingMessages["previewLog"]) => {
      usePreviewStore.getState().acceptLog(payload);
    };

    desktopRpc.addMessageListener("previewStatusChanged", handleStatus);
    desktopRpc.addMessageListener("previewLog", handleLog);

    usePreviewStore.getState().activate({ folderPath, projectRoot, tabId, isWorktree });

    return () => {
      desktopRpc.removeMessageListener("previewStatusChanged", handleStatus);
      desktopRpc.removeMessageListener("previewLog", handleLog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath, projectRoot, tabId, isWorktree]);

  const isThinking = useAgentStore((state) =>
    tabId ? (state.tabs[tabId]?.isThinking ?? false) : false,
  );
  const prevThinkingRef = useRef(false);

  useEffect(() => {
    if (prevThinkingRef.current && !isThinking) {
      void usePreviewStore.getState().refreshDraft();
    }
    prevThinkingRef.current = isThinking;
  }, [isThinking]);
}
