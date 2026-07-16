import { useCallback } from "react";

import type { DevServer } from "../../../shared/herman-manifest.js";
import { usePreviewController } from "../hooks/use-preview-controller.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsActiveTabWorking } from "../lib/agent-store/hooks.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import {
  formatRuntimeErrors,
  selectIsSaving,
  selectIsSynced,
  selectPreviewStage,
  selectShowRuntimeBanner,
  selectStatusCopy,
  usePreviewStore,
} from "../lib/preview-store.js";
import { PreviewDraftBar } from "./preview/preview-draft-bar.js";
import { PreviewStage } from "./preview/preview-stage.js";
import { PreviewToolbar } from "./preview/preview-toolbar.js";

type PreviewPaneProps = {
  folderPath: string;
  tabId?: string;
  isWorktree?: boolean;
  onPublish?: () => void;
  /** True while RookieShell split divider is being dragged. */
  splitDragging?: boolean;
  /** True while PublishDialog is open (parent owns this state). */
  publishOpen?: boolean;
};

export function PreviewPane({
  folderPath,
  tabId,
  isWorktree,
  onPublish,
  splitDragging,
  publishOpen,
}: PreviewPaneProps) {
  usePreviewController({ folderPath, tabId, isWorktree });

  const stage = usePreviewStore(selectPreviewStage);
  const manifest = usePreviewStore((s) => s.manifest);
  const server = usePreviewStore((s) => s.server);
  const activeServerId = usePreviewStore((s) => s.activeServerId);
  const operation = usePreviewStore((s) => s.operation);
  const reloadRevision = usePreviewStore((s) => s.reloadRevision);
  const deviceMode = usePreviewStore((s) => s.deviceMode);
  const runtimeErrors = usePreviewStore((s) => s.runtimeErrors);
  const showRuntimeBanner = usePreviewStore(selectShowRuntimeBanner);
  const draft = usePreviewStore((s) => s.draft);
  const isSaving = usePreviewStore(selectIsSaving);
  const isSynced = usePreviewStore(selectIsSynced);
  const statusCopy = usePreviewStore(selectStatusCopy);
  const discardDialogOpen = usePreviewStore((s) => s.discardDialogOpen);
  const askInFlight = usePreviewStore((s) => s.askInFlight);

  const setDeviceMode = usePreviewStore((s) => s.setDeviceMode);
  const setDiscardDialogOpen = usePreviewStore((s) => s.setDiscardDialogOpen);
  const restart = usePreviewStore((s) => s.restart);
  const switchServer = usePreviewStore((s) => s.switchServer);
  const applyDraft = usePreviewStore((s) => s.applyDraft);
  const discardDraft = usePreviewStore((s) => s.discardDraft);
  const askHermanToFix = usePreviewStore((s) => s.askHermanToFix);
  const dismissRuntimeErrors = usePreviewStore((s) => s.dismissRuntimeErrors);
  const acceptClientError = usePreviewStore((s) => s.acceptClientError);

  const isTabWorking = useIsActiveTabWorking();
  const modelSelectorOpen = useAgentStore((s) => s.ui.modelSelectorOpen);

  const overlayOpen = discardDialogOpen || Boolean(publishOpen) || modelSelectorOpen;
  const askDisabled = askInFlight || isTabWorking || !tabId;

  const handleOpenExternal = useCallback(() => {
    if (server?.url) {
      void desktopRpc.request.openExternal({ url: server.url });
    }
  }, [server?.url]);

  const handleSwitchServer = useCallback(
    (target: DevServer) => void switchServer(target),
    [switchServer],
  );

  const manifestError = manifest.phase === "failed" ? manifest.error : undefined;
  const serverError = server?.phase === "failed" ? server.error : undefined;
  const servers = manifest.value?.servers ?? [];

  return (
    <div className="flex h-full flex-col bg-void">
      <PreviewToolbar
        isRunning={stage === "ready"}
        deviceMode={deviceMode}
        onDeviceModeChange={setDeviceMode}
        isRestarting={operation === "restart"}
        onRestart={() => void restart()}
        servers={servers}
        activeServerId={activeServerId}
        onSwitchServer={handleSwitchServer}
        previewUrl={server?.url}
        onOpenExternal={handleOpenExternal}
        onPublish={onPublish}
        showPublish={Boolean(onPublish && manifest.value)}
      />

      {isWorktree && (
        <PreviewDraftBar
          statusCopy={statusCopy}
          isSaving={isSaving}
          isSynced={isSynced}
          saveDisabled={isSaving || !draft.canApply || isTabWorking}
          onDiscardClick={() => setDiscardDialogOpen(true)}
          onApply={() => void applyDraft()}
          discardOpen={discardDialogOpen}
          onDiscardOpenChange={setDiscardDialogOpen}
          onConfirmDiscard={() => void discardDraft()}
          saveError={draft.error}
          onAskFixSaveError={() => void askHermanToFix(draft.error ?? "", "save")}
          askDisabled={askDisabled}
        />
      )}

      <div className="flex min-h-0 flex-1 items-stretch justify-center overflow-hidden p-4">
        <PreviewStage
          stage={stage}
          manifestError={manifestError}
          serverError={serverError}
          deviceMode={deviceMode}
          url={server?.url}
          reloadRevision={reloadRevision}
          hidden={overlayOpen}
          passthrough={Boolean(splitDragging)}
          continuousSync={Boolean(splitDragging)}
          onClientError={acceptClientError}
          runtimeErrors={runtimeErrors}
          showRuntimeBanner={showRuntimeBanner}
          onDismissBanner={dismissRuntimeErrors}
          onAskFixRuntime={() => void askHermanToFix(formatRuntimeErrors(runtimeErrors), "runtime")}
          onAskFixManifest={() => void askHermanToFix(manifestError ?? "", "preview")}
          onAskFixServer={() => void askHermanToFix(serverError ?? "", "preview")}
          onRetryServer={() => void restart()}
          askDisabled={askDisabled}
        />
      </div>
    </div>
  );
}
