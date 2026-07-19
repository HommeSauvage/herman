import { Loader2, Monitor, Play } from "lucide-react";
import { type Ref } from "react";

import { DEVICE_WIDTHS, type DeviceMode, type PreviewStage as PreviewStageKind } from "../../lib/preview-store.js";
import { PreviewWebview, type PreviewClientError, type PreviewConsoleEntryCallback, type PreviewWebviewHandle } from "../preview-webview.js";
import { PreviewErrorBox } from "./preview-error-box.js";

type PreviewStageProps = {
  stage: PreviewStageKind;
  manifestError?: string;
  serverError?: string;
  deviceMode: DeviceMode;
  url?: string;
  reloadRevision: number;
  hidden: boolean;
  passthrough: boolean;
  continuousSync: boolean;
  onClientError: (error: PreviewClientError) => void;
  onConsoleEntry?: PreviewConsoleEntryCallback;
  onAskFixManifest: () => void;
  onAskFixServer: () => void;
  onRetryServer: () => void;
  askDisabled: boolean;
  webviewRef?: Ref<PreviewWebviewHandle>;
  onNavigate?: (url: string) => void;
};

/**
 * Renders the main preview surface for every possible `PreviewStage`. The
 * switch below is written to be exhaustive — adding a new stage to
 * `selectPreviewStage` without handling it here is a compile error.
 */
export function PreviewStage({
  stage,
  manifestError,
  serverError,
  deviceMode,
  url,
  reloadRevision,
  hidden,
  passthrough,
  continuousSync,
  onClientError,
  onConsoleEntry,
  onAskFixManifest,
  onAskFixServer,
  onRetryServer,
  askDisabled,
  webviewRef,
  onNavigate,
}: PreviewStageProps) {
  switch (stage) {
    case "manifest_loading":
      return (
        <div className="flex flex-col items-center gap-3 pt-20">
          <Loader2 size={22} className="text-signal animate-spin" />
          <p className="text-dim text-sm">Loading project…</p>
        </div>
      );

    case "manifest_failed":
      return (
        <div className="flex flex-col items-center gap-4 px-4 pt-20">
          <PreviewErrorBox
            title="Couldn't load this project"
            subtitle="Something went wrong reading the project configuration."
            error={manifestError ?? "Unknown error"}
            onAsk={onAskFixManifest}
            disabled={askDisabled}
          />
        </div>
      );

    case "server_starting":
      return (
        <div className="flex flex-col items-center gap-3 pt-20">
          <Loader2 size={22} className="text-signal animate-spin" />
          <p className="text-dim text-sm">Starting preview server…</p>
        </div>
      );

    case "waiting_for_setup":
      return (
        <div className="flex flex-col items-center gap-3 pt-20">
          <Loader2 size={22} className="text-signal animate-spin" />
          <div className="text-center">
            <p className="text-dim text-sm">Setting up your workspace…</p>
            <p className="text-ghost mt-1 text-xs">The preview will start automatically when it's ready.</p>
          </div>
        </div>
      );

    case "server_failed":
      return (
        <div className="flex flex-col items-center gap-4 px-4 pt-20">
          <PreviewErrorBox
            title="Preview server problem"
            subtitle="Something went wrong while starting or running the preview."
            error={serverError ?? "Unknown error"}
            onAsk={onAskFixServer}
            onRetry={onRetryServer}
            disabled={askDisabled}
          />
        </div>
      );

    case "waiting":
      return (
        <div className="flex flex-col items-center gap-4 pt-20">
          <div className="text-dim flex h-16 w-16 items-center justify-center rounded-2xl bg-fog">
            <Play size={26} strokeWidth={1.5} />
          </div>
          <div className="text-center">
            <p className="text-dim text-sm">Starting preview automatically…</p>
            <p className="text-ghost mt-1 text-xs">This can take a bit on first run.</p>
          </div>
        </div>
      );

    case "no_manifest":
      return (
        <div className="flex flex-col items-center gap-3 pt-20">
          <div className="text-ghost flex h-16 w-16 items-center justify-center rounded-2xl bg-fog">
            <Monitor size={24} strokeWidth={1} />
          </div>
          <p className="text-dim text-sm">No preview available</p>
          <p className="text-ghost max-w-[220px] text-center text-xs leading-relaxed">
            Create a project from a template to enable live preview.
          </p>
        </div>
      );

    case "ready":
      return (
        <div
          className="relative flex h-full min-h-[500px] overflow-hidden rounded-lg border border-mist shadow-2xl shadow-black/60"
          style={{
            width: DEVICE_WIDTHS[deviceMode],
            height: deviceMode === "mobile" ? "667px" : "100%",
            maxHeight: "100%",
          }}
        >
          <PreviewWebview
            ref={webviewRef}
            url={url ?? ""}
            reloadRevision={reloadRevision}
            hidden={hidden}
            passthrough={passthrough}
            continuousSync={continuousSync}
            className="bg-white"
            onClientError={onClientError}
            onConsoleEntry={onConsoleEntry}
            onNavigate={onNavigate}
          />
        </div>
      );

    default: {
      const _exhaustive: never = stage;
      throw new Error(`Unhandled preview stage: ${String(_exhaustive)}`);
    }
  }
}
