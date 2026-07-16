import { cn } from "@herman/ui/lib/utils";
import { ExternalLink, Loader2, Monitor, RefreshCw, Rocket, Smartphone, Tablet } from "lucide-react";

import type { DevServer } from "../../../../shared/herman-manifest.js";
import { DEVICE_WIDTHS, type DeviceMode } from "../../lib/preview-store.js";

const DEVICE_ICONS: Record<DeviceMode, React.ElementType> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

type PreviewToolbarProps = {
  isRunning: boolean;
  deviceMode: DeviceMode;
  onDeviceModeChange: (mode: DeviceMode) => void;
  isRestarting: boolean;
  onRestart: () => void;
  servers: DevServer[];
  activeServerId: string | null;
  onSwitchServer: (server: DevServer) => void;
  previewUrl?: string;
  onOpenExternal: () => void;
  onPublish?: () => void;
  showPublish: boolean;
};

export function PreviewToolbar({
  isRunning,
  deviceMode,
  onDeviceModeChange,
  isRestarting,
  onRestart,
  servers,
  activeServerId,
  onSwitchServer,
  previewUrl,
  onOpenExternal,
  onPublish,
  showPublish,
}: PreviewToolbarProps) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-mist px-3 py-2">
      <div className="flex items-center gap-1">
        {isRunning && (
          <>
            <div className="flex items-center rounded-lg border border-mist bg-fog p-0.5">
              {(Object.keys(DEVICE_WIDTHS) as DeviceMode[]).map((mode) => {
                const Icon = DEVICE_ICONS[mode];
                return (
                  <button
                    key={mode}
                    onClick={() => onDeviceModeChange(mode)}
                    aria-label={`${mode} view`}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-md transition",
                      deviceMode === mode ? "bg-white/8 text-text" : "text-ghost hover:text-dim",
                    )}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div>

            <button
              onClick={onRestart}
              aria-label="Restart server"
              className="text-ghost hover:text-dim flex h-7 w-7 items-center justify-center rounded-lg transition hover:bg-white/4"
              title="Restart server"
            >
              {isRestarting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            </button>

            {servers.length > 1 && (
              <div className="ml-1 flex items-center gap-1 rounded-lg border border-mist bg-fog p-0.5">
                {servers.map((server) => (
                  <button
                    key={server.id}
                    onClick={() => onSwitchServer(server)}
                    className={cn(
                      "rounded-md px-2 py-1 text-[10px] font-medium transition",
                      activeServerId === server.id
                        ? "bg-white/8 text-text"
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
            onClick={onOpenExternal}
            className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/4"
          >
            <span className="max-w-[160px] truncate">{previewUrl.replace(/^https?:\/\//, "")}</span>
            <ExternalLink size={11} />
          </button>
        )}

        {showPublish && onPublish && (
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
  );
}
