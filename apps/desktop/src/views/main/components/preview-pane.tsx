import { useCallback, useRef } from "react";

import type { DevServer } from "../../../shared/herman-manifest.js";
import { usePreviewController } from "../hooks/use-preview-controller.js";
import { usePreviewErrorToasts } from "../hooks/use-preview-error-toasts.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsActiveTabWorking } from "../lib/agent-store/hooks.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import {
  selectIsSaving,
  selectIsSynced,
  selectPreviewStage,
  selectSaveTooltip,
  selectShowRuntimeBanner,
  usePreviewStore,
} from "../lib/preview-store.js";
import { PreviewBrowserBar, PreviewToolbar } from "./preview/preview-toolbar.js";
import { PreviewSaveErrorStrip } from "./preview/preview-save-error-strip.js";
import { PreviewStage } from "./preview/preview-stage.js";
import type { PreviewWebviewHandle } from "./preview-webview.js";

type PreviewPaneProps = {
  folderPath: string;
  projectRoot?: string;
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
  projectRoot,
  tabId,
  isWorktree,
  onPublish,
  splitDragging,
  publishOpen,
}: PreviewPaneProps) {
  usePreviewController({ folderPath, projectRoot, tabId, isWorktree });

  const webviewRef = useRef<PreviewWebviewHandle>(null);

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
  const saveTooltip = usePreviewStore(selectSaveTooltip);
  const currentUrl = usePreviewStore((s) => s.currentUrl);
  const canGoBack = usePreviewStore((s) => s.canGoBack);
  const setDeviceMode = usePreviewStore((s) => s.setDeviceMode);
  const restart = usePreviewStore((s) => s.restart);
  const switchServer = usePreviewStore((s) => s.switchServer);
  const applyDraft = usePreviewStore((s) => s.applyDraft);
  const askHermanToFix = usePreviewStore((s) => s.askHermanToFix);
  const acceptClientError = usePreviewStore((s) => s.acceptClientError);
  const setCurrentUrl = usePreviewStore((s) => s.setCurrentUrl);
  const setCanGoBack = usePreviewStore((s) => s.setCanGoBack);

  const isTabWorking = useIsActiveTabWorking();
  const modelSelectorOpen = useAgentStore((s) => s.ui.modelSelectorOpen);

  const overlayOpen = Boolean(publishOpen) || modelSelectorOpen;
  const askDisabled = isTabWorking || !tabId;
  const showControls = Boolean(folderPath && folderPath.length >= 3);
  const baseUrl = server?.url;

  // Replace the fragile absolute-positioned error banner with Sonner toasts.
  usePreviewErrorToasts(runtimeErrors, showRuntimeBanner);

  const handleOpenExternal = useCallback(
    (url: string) => {
      void desktopRpc.request.openExternal({ url });
    },
    [],
  );

  const handleSwitchServer = useCallback(
    (target: DevServer) => void switchServer(target),
    [switchServer],
  );

  const handleNavigate = useCallback(
    (url: string) => {
      setCurrentUrl(url);
      webviewRef.current?.loadURL(url);
    },
    [setCurrentUrl],
  );

  const handleGoBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const refreshCanGoBack = useCallback(async () => {
    return (await webviewRef.current?.canGoBack()) ?? false;
  }, []);

  const handleWebviewNavigate = useCallback(
    (url: string) => {
      setCurrentUrl(url);
    },
    [setCurrentUrl],
  );

  const manifestError = manifest.phase === "failed" ? manifest.error : undefined;
  const serverError = server?.phase === "failed" ? server.error : undefined;
  const servers = manifest.value?.servers ?? [];

  return (
    <div className="flex h-full flex-col bg-void">
      <PreviewToolbar
        showControls={showControls}
        deviceMode={deviceMode}
        onDeviceModeChange={setDeviceMode}
        servers={servers}
        activeServerId={activeServerId}
        onSwitchServer={handleSwitchServer}
        showSave={Boolean(isWorktree)}
        isSaving={isSaving}
        isSynced={isSynced}
        changedFiles={draft.changedFiles}
        saveDisabled={isSaving || !draft.canApply || isTabWorking}
        saveTooltip={saveTooltip}
        onSave={() => void applyDraft()}
        onPublish={onPublish}
        showPublish={Boolean(onPublish && manifest.value)}
      />

      <PreviewBrowserBar
        showControls={showControls}
        baseUrl={baseUrl}
        currentUrl={currentUrl}
        canGoBack={canGoBack}
        canRestart={Boolean(manifest.value)}
        isRestarting={operation === "restart"}
        onGoBack={handleGoBack}
        onRestart={() => void restart()}
        onNavigate={handleNavigate}
        onOpenExternal={handleOpenExternal}
        onCanGoBackChange={setCanGoBack}
        refreshCanGoBack={refreshCanGoBack}
      />

      {isWorktree && draft.error && (
        <PreviewSaveErrorStrip
          error={draft.error}
          onAskFix={() => void askHermanToFix(draft.error ?? "", "save")}
          askDisabled={askDisabled}
        />
      )}

      <div className="flex min-h-0 flex-1 items-stretch justify-center overflow-hidden p-4">
        <PreviewStage
          stage={stage}
          manifestError={manifestError}
          serverError={serverError}
          deviceMode={deviceMode}
          url={currentUrl ?? baseUrl}
          reloadRevision={reloadRevision}
          hidden={overlayOpen}
          passthrough={Boolean(splitDragging)}
          continuousSync={Boolean(splitDragging)}
          onClientError={acceptClientError}
          onAskFixManifest={() => void askHermanToFix(manifestError ?? "", "preview")}
          onAskFixServer={() => void askHermanToFix(serverError ?? "", "preview")}
          onRetryServer={() => void restart()}
          askDisabled={askDisabled}
          webviewRef={webviewRef}
          onNavigate={handleWebviewNavigate}
        />
      </div>
    </div>
  );
}
