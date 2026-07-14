import { cn } from "@herman/ui/lib/utils";
import { Monitor, Smartphone, Tablet, RefreshCw, Loader2, Rocket, ExternalLink, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DevServer, ProjectManifestView } from "../../../shared/herman-manifest.js";
import { desktopRpc } from "../lib/desktop-rpc.js";

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
};

export function PreviewPane({ folderPath, tabId, isWorktree, onPublish }: PreviewPaneProps) {
  const [manifest, setManifest] = useState<ProjectManifestView | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<"idle" | "working">("idle");
  const [sessionChanges, setSessionChanges] = useState<number>(0);
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
    if (!tabId || !isWorktree) {
      setSessionChanges(0);
      return;
    }
    void desktopRpc.request.getSessionChanges({ tabId }).then((state) => {
      setSessionChanges(state.changedFiles);
    });
  }, [tabId, isWorktree]);

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
    if (!tabId) return;
    setApplyState("working");
    void desktopRpc.request
      .applySession({ tabId })
      .finally(() => setApplyState("idle"));
  }, [tabId]);

  const handleDiscardSession = useCallback(() => {
    if (!tabId) return;
    setApplyState("working");
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
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <p className="text-ghost text-xs">
            Working in a safe draft copy{sessionChanges > 0 ? ` · ${sessionChanges} file(s) changed` : ""}.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscardSession}
              disabled={applyState === "working"}
              className="text-ghost hover:text-dim rounded-md border border-white/[0.08] px-2 py-1 text-xs disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleApplySession}
              disabled={applyState === "working"}
              className="bg-signal hover:bg-signal-dim rounded-md px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              Save to my project
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 items-start justify-center overflow-auto p-4">
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
            className="overflow-hidden rounded-lg border border-white/[0.08] shadow-2xl shadow-black/60 transition-all duration-300"
            style={{ width: deviceWidth }}
          >
            <iframe
              ref={iframeRef}
              src={previewUrl}
              className="block w-full bg-white"
              style={{
                height: deviceMode === "mobile" ? "667px" : "100%",
                minHeight: "500px",
              }}
              title="Site preview"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
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
    </div>
  );
}
