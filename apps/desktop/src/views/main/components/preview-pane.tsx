import { cn } from "@herman/ui/lib/utils";
import { Button } from "@herman/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@herman/ui/components/dialog";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Rocket,
  Smartphone,
  Tablet,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DevServer, ProjectManifestView } from "../../../shared/herman-manifest.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsActiveTabWorking } from "../lib/agent-store/hooks.js";
import { PreviewWebview, type PreviewWebviewHandle } from "./preview-webview.js";

type DeviceMode = "desktop" | "tablet" | "mobile";

const DEVICE_WIDTHS: Record<DeviceMode, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

const DEVICE_ICONS: Record<DeviceMode, React.ElementType> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

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
  const [manifest, setManifest] = useState<ProjectManifestView | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<"idle" | "working">("idle");
  const [sessionChanges, setSessionChanges] = useState(0);
  const [canApply, setCanApply] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const webviewRef = useRef<PreviewWebviewHandle>(null);
  const prevThinkingRef = useRef(false);

  const isThinking = useAgentStore((state) =>
    tabId ? (state.tabs[tabId]?.isThinking ?? false) : false,
  );
  const isTabWorking = useIsActiveTabWorking();
  const modelSelectorOpen = useAgentStore((s) => s.ui.modelSelectorOpen);

  const overlayOpen = discardOpen || Boolean(publishOpen) || modelSelectorOpen;

  const refreshSessionChanges = useCallback(() => {
    if (!tabId || !isWorktree) {
      setSessionChanges(0);
      setCanApply(false);
      return;
    }
    void desktopRpc.request.getSessionChanges({ tabId }).then((state) => {
      setSessionChanges(state.changedFiles);
      setCanApply(state.canApply);
    });
  }, [tabId, isWorktree]);

  useEffect(() => {
    if (!folderPath || folderPath.length < 3) {
      setManifest(null);
      setManifestLoading(false);
      return;
    }

    let cancelled = false;
    setManifestLoading(true);
    setManifest(null);
    setPreviewUrl(null);
    setIsRunning(false);
    setStartError(null);
    setActiveServerId(null);

    desktopRpc.request
      .getProjectManifest({ folderPath })
      .then((m) => {
        if (!cancelled) {
          setManifest(m ?? null);
          setActiveServerId(m?.primary?.id ?? m?.servers?.[0]?.id ?? null);
          setManifestLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setManifestLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  useEffect(() => {
    refreshSessionChanges();
  }, [refreshSessionChanges]);

  useEffect(() => {
    if (prevThinkingRef.current && !isThinking) {
      refreshSessionChanges();
    }
    prevThinkingRef.current = isThinking;
  }, [isThinking, refreshSessionChanges]);

  useEffect(() => {
    webviewRef.current?.setHidden(overlayOpen);
  }, [overlayOpen, previewUrl]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    wv.setPassthrough(Boolean(splitDragging));
    wv.syncNow();
    return () => {
      wv.setPassthrough(false);
      wv.syncNow();
    };
  }, [splitDragging]);

  useEffect(() => {
    if (!splitDragging) return;
    let raf = 0;
    const tick = () => {
      webviewRef.current?.syncNow();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [splitDragging]);

  useEffect(() => {
    webviewRef.current?.syncNow();
  }, [deviceMode, previewUrl]);

  const handleStartPreview = useCallback(async () => {
    if (!manifest) return;

    setIsStarting(true);
    setStartError(null);
    try {
      const status = await desktopRpc.request.getPreviewStatus({ folderPath });
      if (status.running && status.url) {
        setPreviewUrl(status.url);
        setIsRunning(true);
        setActiveServerId(status.serverId ?? activeServerId);
        setIsStarting(false);
        return;
      }

      const result = await desktopRpc.request.startPreview({
        folderPath,
        all: true,
        ...(manifest.primary
          ? {
              serverId: manifest.primary.id,
              devCommand: manifest.primary.command,
              devPort: manifest.primary.port,
            }
          : {}),
      });

      if (result.url) {
        setPreviewUrl(result.url);
        setIsRunning(true);
        setActiveServerId(result.serverId ?? manifest.primary?.id ?? null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start preview server";
      setStartError(message);
    } finally {
      setIsStarting(false);
    }
  }, [manifest, folderPath, activeServerId]);

  useEffect(() => {
    if (!manifest || !folderPath) return;
    void handleStartPreview();
  }, [manifest, folderPath, handleStartPreview]);

  const handleRefresh = useCallback(() => {
    if (!manifest) return;
    setIsRestarting(true);
    setStartError(null);
    void desktopRpc.request
      .restartPreview({
        folderPath,
        all: true,
        ...(manifest.primary
          ? {
              serverId: manifest.primary.id,
              devCommand: manifest.primary.command,
              devPort: manifest.primary.port,
            }
          : {}),
      })
      .then((result) => {
        if (result.url) {
          setPreviewUrl(result.url);
          setIsRunning(true);
          setActiveServerId(result.serverId ?? manifest.primary?.id ?? null);
        }
        // Force reload even when the URL is unchanged after restart.
        queueMicrotask(() => webviewRef.current?.reload());
      })
      .catch((err) => {
        setStartError(err instanceof Error ? err.message : "Failed to restart preview");
      })
      .finally(() => setIsRestarting(false));
  }, [manifest, folderPath]);

  const handleSwitchServer = useCallback(
    async (server: DevServer) => {
      setActiveServerId(server.id);
      const status = await desktopRpc.request.getPreviewStatus({
        folderPath,
        serverId: server.id,
      });
      if (status.running && status.url) {
        setPreviewUrl(status.url);
        setIsRunning(true);
        return;
      }
      const result = await desktopRpc.request.startPreview({
        folderPath,
        serverId: server.id,
        devCommand: server.command,
        devPort: server.port,
      });
      if (result.url) {
        setPreviewUrl(result.url);
        setIsRunning(true);
      }
    },
    [folderPath],
  );

  const handleApplySession = useCallback(() => {
    if (!tabId || !canApply) return;
    setApplyState("working");
    setSaveError(null);
    void desktopRpc.request
      .applySession({ tabId })
      .then((result) => {
        if (result.status === "error") {
          setSaveError(result.error ?? "Could not save to your project. Try again.");
        } else {
          setSaveError(null);
        }
        refreshSessionChanges();
      })
      .catch(() => {
        setSaveError("Could not save to your project. Try again.");
      })
      .finally(() => setApplyState("idle"));
  }, [tabId, canApply, refreshSessionChanges]);

  const handleDiscardSession = useCallback(() => {
    if (!tabId) return;
    setApplyState("working");
    setDiscardOpen(false);
    void desktopRpc.request
      .discardSession({ tabId })
      .finally(() => setApplyState("idle"));
  }, [tabId]);

  const handleOpenExternal = useCallback(() => {
    if (previewUrl) {
      void desktopRpc.request.openExternal({ url: previewUrl });
    }
  }, [previewUrl]);

  const deviceWidth = DEVICE_WIDTHS[deviceMode];
  const servers = manifest?.servers ?? [];
  const isSaving = applyState === "working";
  const saveDisabled = isSaving || !canApply || isTabWorking;
  const isSynced = !canApply && !isSaving;

  const statusCopy = isSaving
    ? "Saving to your project…"
    : isSynced
      ? "Working in a safe draft copy · Up to date"
      : `Working in a safe draft copy · Unsaved changes${sessionChanges > 0 ? ` · ${sessionChanges} file(s) changed` : ""}`;

  return (
    <div className="flex h-full flex-col bg-[#0a0a0b]">
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-2">
        <div className="flex items-center gap-1">
          {isRunning && (
            <>
              <div className="flex items-center rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5">
                {(["desktop", "tablet", "mobile"] as DeviceMode[]).map((mode) => {
                  const Icon = DEVICE_ICONS[mode];
                  return (
                    <button
                      key={mode}
                      onClick={() => setDeviceMode(mode)}
                      aria-label={`${mode} view`}
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md transition",
                        deviceMode === mode
                          ? "bg-white/[0.08] text-text"
                          : "text-ghost hover:text-dim",
                      )}
                    >
                      <Icon size={14} />
                    </button>
                  );
                })}
              </div>

              <button
                onClick={handleRefresh}
                aria-label="Restart server"
                className="text-ghost hover:text-dim flex h-7 w-7 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
                title="Restart server"
              >
                {isRestarting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              </button>

              {servers.length > 1 && (
                <div className="ml-1 flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5">
                  {servers.map((server) => (
                    <button
                      key={server.id}
                      onClick={() => void handleSwitchServer(server)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[10px] font-medium transition",
                        activeServerId === server.id
                          ? "bg-white/[0.08] text-text"
                          : "text-ghost hover:text-dim",
                      )}
                    >
                      {server.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {previewUrl && (
            <button
              onClick={handleOpenExternal}
              className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.04]"
            >
              <span className="max-w-[160px] truncate">
                {previewUrl.replace(/^https?:\/\//, "")}
              </span>
              <ExternalLink size={11} />
            </button>
          )}

          {onPublish && manifest && (
            <button
              onClick={onPublish}
              className="bg-signal hover:bg-signal-dim flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold text-primary-foreground transition active:scale-[0.96]"
            >
              <Rocket size={12} />
              Publish
            </button>
          )}
        </div>
      </div>

      {isWorktree && (
        <div className="shrink-0 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-ghost flex items-center gap-1.5 text-xs">
              {isSaving ? (
                <Loader2 size={13} className="text-signal animate-spin" />
              ) : isSynced ? (
                <CheckCircle2 size={13} className="text-signal shrink-0" aria-hidden />
              ) : (
                <AlertCircle size={13} className="text-warning shrink-0" aria-hidden />
              )}
              {statusCopy}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDiscardOpen(true)}
                disabled={isSaving}
                className="text-ghost hover:text-dim rounded-md border border-white/[0.08] px-2 py-1 text-xs disabled:opacity-50"
              >
                Discard
              </button>
              <button
                onClick={handleApplySession}
                disabled={saveDisabled}
                className="bg-signal hover:bg-signal-dim rounded-md px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                Save to my project
              </button>
            </div>
          </div>
          {saveError && (
            <p className="mt-1.5 text-xs text-red-400">{saveError}</p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 items-stretch justify-center overflow-hidden p-4">
        {manifestLoading ? (
          <div className="flex flex-col items-center gap-3 pt-20">
            <Loader2 size={22} className="text-signal animate-spin" />
            <p className="text-dim text-sm">Loading project…</p>
          </div>
        ) : isStarting ? (
          <div className="flex flex-col items-center gap-3 pt-20">
            <Loader2 size={22} className="text-signal animate-spin" />
            <p className="text-dim text-sm">Starting preview server…</p>
          </div>
        ) : startError ? (
          <div className="flex flex-col items-center gap-3 pt-20">
            <p className="text-dim text-sm">{startError}</p>
            <button
              onClick={handleStartPreview}
              className="bg-signal hover:bg-signal-dim rounded-lg px-3 py-1.5 text-xs font-semibold text-primary-foreground"
            >
              Try again
            </button>
          </div>
        ) : previewUrl ? (
          <div
            className="flex h-full min-h-[500px] overflow-hidden rounded-lg border border-white/[0.08] shadow-2xl shadow-black/60"
            style={{
              width: deviceWidth,
              height: deviceMode === "mobile" ? "667px" : "100%",
              maxHeight: "100%",
            }}
          >
            <PreviewWebview ref={webviewRef} url={previewUrl} className="bg-white" />
          </div>
        ) : manifest ? (
          <div className="flex flex-col items-center gap-4 pt-20">
            <div className="text-dim flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.02]">
              <Play size={26} strokeWidth={1.5} />
            </div>
            <div className="text-center">
              <p className="text-dim text-sm">Starting preview automatically…</p>
              <p className="text-ghost mt-1 text-xs">
                This can take a bit on first run.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 pt-20">
            <div className="text-ghost flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.02]">
              <Monitor size={24} strokeWidth={1} />
            </div>
            <p className="text-dim text-sm">No preview available</p>
            <p className="text-ghost max-w-[220px] text-center text-xs leading-relaxed">
              Create a project from a template to enable live preview.
            </p>
          </div>
        )}
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Throw away this draft?</DialogTitle>
            <DialogDescription className="text-left leading-relaxed">
              Your real project won&apos;t change. This draft and everything you did here will be
              removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDiscardOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isSaving}
              onClick={handleDiscardSession}
            >
              Throw away draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
