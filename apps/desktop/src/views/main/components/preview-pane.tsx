import { cn } from "@herman/ui/lib/utils";
import { Monitor, Smartphone, Tablet, RefreshCw, Loader2, Rocket, ExternalLink, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

type ProjectManifest = {
  devCommand: string;
  devPort: number;
  buildCommand: string;
  outputDir: string;
  deployTarget: string;
};

type PreviewPaneProps = {
  folderPath: string;
  onPublish?: () => void;
};

export function PreviewPane({ folderPath, onPublish }: PreviewPaneProps) {
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Load herman.json when folderPath changes
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

    desktopRpc.request
      .getProjectManifest({ folderPath })
      .then((m) => {
        if (!cancelled) {
          setManifest(m ?? null);
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

  const handleStartPreview = useCallback(async () => {
    if (!manifest) return;

    setIsStarting(true);
    try {
      const status = await desktopRpc.request.getPreviewStatus({ folderPath });
      if (status.running && status.url) {
        setPreviewUrl(status.url);
        setIsRunning(true);
        setIsStarting(false);
        return;
      }

      const result = await desktopRpc.request.startPreview({
        folderPath,
        devCommand: manifest.devCommand,
        devPort: manifest.devPort,
      });

      if (result.url) {
        setPreviewUrl(result.url);
        setIsRunning(true);
      }
    } catch (err) {
      console.error("Failed to start preview:", err);
    } finally {
      setIsStarting(false);
    }
  }, [manifest, folderPath]);

  const handleRefresh = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (previewUrl) {
      void desktopRpc.request.openExternal({ url: previewUrl });
    }
  }, [previewUrl]);

  const deviceWidth = DEVICE_WIDTHS[deviceMode];

  return (
    <div className="flex h-full flex-col bg-[#0a0a0b]">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-2">
        <div className="flex items-center gap-1">
          {isRunning && (
            <>
              {/* Device mode toggle */}
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

              {/* Refresh */}
              <button
                onClick={handleRefresh}
                aria-label="Refresh preview"
                className="text-ghost hover:text-dim flex h-7 w-7 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
              >
                <RefreshCw size={13} />
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* URL display */}
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

          {/* Publish button */}
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

      {/* Preview area */}
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
        ) : previewUrl ? (
          <div
            className="overflow-hidden rounded-lg border border-white/[0.08] shadow-2xl shadow-black/60 transition-all duration-300"
            style={{ width: deviceWidth }}
          >
            <iframe
              key={iframeKey}
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
          /* Has manifest but not started — show start button */
          <div className="flex flex-col items-center gap-4 pt-20">
            <div className="text-dim flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.02]">
              <Play size={26} strokeWidth={1.5} />
            </div>
            <div className="text-center">
              <p className="text-dim text-sm">Ready to preview</p>
              <p className="text-ghost mt-1 text-xs">
                Start the dev server to see your site live.
              </p>
            </div>
            <button
              onClick={handleStartPreview}
              className="bg-signal hover:bg-signal-dim flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_16px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_24px_rgba(34,197,94,0.28)] active:scale-[0.97]"
            >
              <Play size={14} />
              Start Preview
            </button>
          </div>
        ) : (
          /* No manifest — project not created from a template */
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
