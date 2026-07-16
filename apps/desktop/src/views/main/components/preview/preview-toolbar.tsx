import { cn } from "@herman/ui/lib/utils";
import { ArrowLeft, ExternalLink, Loader2, Monitor, RefreshCw, Rocket, Smartphone, Tablet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DevServer } from "../../../../shared/herman-manifest.js";
import {
  buildUrlWithPath,
  formatOriginDisplay,
  getPathSuffix,
  isSameOrigin,
} from "../../lib/preview-url.js";
import { DEVICE_WIDTHS, type DeviceMode } from "../../lib/preview-store.js";
import { PreviewSaveButton } from "./preview-save-button.js";

const DEVICE_ICONS: Record<DeviceMode, React.ElementType> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

type PreviewToolbarProps = {
  showControls: boolean;
  deviceMode: DeviceMode;
  onDeviceModeChange: (mode: DeviceMode) => void;
  servers: DevServer[];
  activeServerId: string | null;
  onSwitchServer: (server: DevServer) => void;
  showSave: boolean;
  isSaving: boolean;
  isSynced: boolean;
  changedFiles: number;
  saveDisabled: boolean;
  saveTooltip: string;
  onSave: () => void;
  onPublish?: () => void;
  showPublish: boolean;
};

export function PreviewToolbar({
  showControls,
  deviceMode,
  onDeviceModeChange,
  servers,
  activeServerId,
  onSwitchServer,
  showSave,
  isSaving,
  isSynced,
  changedFiles,
  saveDisabled,
  saveTooltip,
  onSave,
  onPublish,
  showPublish,
}: PreviewToolbarProps) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-mist px-3 py-2">
      <div className="flex min-w-0 items-center gap-1">
        {showControls && (
          <>
            <div className="flex items-center rounded-lg border border-mist bg-fog p-0.5">
              {(Object.keys(DEVICE_WIDTHS) as DeviceMode[]).map((mode) => {
                const Icon = DEVICE_ICONS[mode];
                return (
                  <button
                    key={mode}
                    type="button"
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

            {servers.length > 1 && (
              <div className="ml-1 flex items-center gap-1 rounded-lg border border-mist bg-fog p-0.5">
                {servers.map((server) => (
                  <button
                    key={server.id}
                    type="button"
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
        <PreviewSaveButton
          show={showSave}
          isSaving={isSaving}
          isSynced={isSynced}
          changedFiles={changedFiles}
          disabled={saveDisabled}
          tooltip={saveTooltip}
          onSave={onSave}
        />

        {showPublish && onPublish && (
          <button
            type="button"
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

type PreviewBrowserBarProps = {
  showControls: boolean;
  baseUrl?: string;
  currentUrl?: string | null;
  canGoBack: boolean;
  canRestart: boolean;
  isRestarting: boolean;
  onGoBack: () => void;
  onRestart: () => void;
  onNavigate: (url: string) => void;
  onOpenExternal: (url: string) => void;
  onCanGoBackChange: (can: boolean) => void;
  refreshCanGoBack: () => Promise<boolean>;
};

export function PreviewBrowserBar({
  showControls,
  baseUrl,
  currentUrl,
  canGoBack,
  canRestart,
  isRestarting,
  onGoBack,
  onRestart,
  onNavigate,
  onOpenExternal,
  onCanGoBackChange,
  refreshCanGoBack,
}: PreviewBrowserBarProps) {
  const [pathInput, setPathInput] = useState("/");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayUrl = currentUrl ?? baseUrl ?? "";
  const originLabel = baseUrl ? formatOriginDisplay(baseUrl) : "";

  useEffect(() => {
    if (focused) return;
    if (displayUrl) {
      setPathInput(getPathSuffix(displayUrl));
    }
  }, [displayUrl, focused]);

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const can = await refreshCanGoBack();
      if (!cancelled) onCanGoBackChange(can);
    };
    void sync();
    return () => {
      cancelled = true;
    };
  }, [displayUrl, refreshCanGoBack, onCanGoBackChange]);

  const commitPath = useCallback(() => {
    if (!baseUrl) return;
    const nextUrl = buildUrlWithPath(baseUrl, pathInput);
    if (!isSameOrigin(baseUrl, nextUrl)) {
      setPathInput(getPathSuffix(displayUrl));
      return;
    }
    onNavigate(nextUrl);
    setFocused(false);
    inputRef.current?.blur();
  }, [baseUrl, pathInput, displayUrl, onNavigate]);

  if (!showControls) return null;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-mist px-3 py-1.5">
      <button
        type="button"
        onClick={onGoBack}
        disabled={!canGoBack}
        aria-label="Back"
        className="text-ghost hover:text-dim flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/4 disabled:cursor-default disabled:opacity-40"
        title="Back"
      >
        <ArrowLeft size={14} />
      </button>

      <button
        type="button"
        onClick={onRestart}
        aria-label="Restart server"
        disabled={!canRestart}
        className="text-ghost hover:text-dim flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/4 disabled:opacity-40"
        title="Restart server"
      >
        {isRestarting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      </button>

      <div className="flex min-w-0 flex-1 items-center rounded-lg border border-mist bg-fog px-2 py-1">
        {originLabel && (
          <span className="text-ghost shrink-0 pr-1 text-[11px] select-none">{originLabel}</span>
        )}
        <input
          ref={inputRef}
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commitPath();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitPath();
            }
            if (e.key === "Escape") {
              setPathInput(getPathSuffix(displayUrl));
              setFocused(false);
              inputRef.current?.blur();
            }
          }}
          disabled={!baseUrl}
          aria-label="Preview path"
          className="text-dim min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-ghost"
          placeholder="/"
        />
        <button
          type="button"
          onClick={() => displayUrl && onOpenExternal(displayUrl)}
          disabled={!displayUrl}
          aria-label="Open in browser"
          className="text-ghost hover:text-dim ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-white/4 disabled:opacity-40"
          title="Open in browser"
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  );
}
