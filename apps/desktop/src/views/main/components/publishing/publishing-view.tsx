import { ArrowLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { PublishingConfigView } from "../../../../shared/publishing.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";
import { ContentWidth } from "../ui/index.js";
import { PublishingStatus } from "./publishing-status.js";
import { PublishingWizard } from "./publishing-wizard.js";

export type PublishingViewProps = {
  projectPath: string;
  projectName: string;
  onBack: () => void;
  /** Start a deploy conversation (prefills the composer and returns to the session). */
  onDeploy: () => void;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; config: PublishingConfigView | null }
  | { kind: "error"; message: string };

/** Setup is complete once the Coolify connection (URL + token) is recorded. */
function isSetupComplete(config: PublishingConfigView | null): boolean {
  return Boolean(config?.coolifyUrl && config.hasApiToken);
}

export function PublishingView({
  projectPath,
  projectName,
  onBack,
  onDeploy,
}: PublishingViewProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  /** User explicitly asked to re-run/edit the setup from the status screen. */
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    desktopRpc.request
      .getPublishingConfig({ projectPath })
      .then((result) => {
        if (cancelled) return;
        setState({ kind: "loaded", config: result.config });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load publishing config",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, refreshKey]);

  const handleConfigSaved = useCallback(() => {
    setEditing(false);
    refresh();
  }, [refresh]);

  const config = state.kind === "loaded" ? state.config : null;
  const showWizard = state.kind === "loaded" && (editing || !isSetupComplete(config));

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {/* Header */}
      <div className="border-b border-mist px-6 py-3">
        <ContentWidth size="page" className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-fog"
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <div className="text-ghost h-4 w-px bg-white/[0.08]" />
          <div className="text-text min-w-0 flex-1 truncate text-sm font-semibold">
            Publishing · {projectName}
          </div>
        </ContentWidth>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-8">
        <ContentWidth size="formWide" className="w-full">
          {state.kind === "loading" && (
            <div className="flex items-center justify-center gap-2 py-20">
              <Loader2 size={18} className="text-signal animate-spin" />
              <span className="text-dim text-sm">Loading publishing setup…</span>
            </div>
          )}

          {state.kind === "error" && (
            <div className="flex flex-col items-center gap-4 py-20 text-center">
              <p className="text-dim text-sm">{state.message}</p>
              <button
                type="button"
                onClick={refresh}
                className="text-signal hover:text-signal-dim text-sm transition"
              >
                Try again
              </button>
            </div>
          )}

          {showWizard && (
            <PublishingWizard
              projectPath={projectPath}
              initialConfig={config}
              onConfigSaved={handleConfigSaved}
            />
          )}

          {state.kind === "loaded" && !showWizard && config && (
            <PublishingStatus
              projectPath={projectPath}
              config={config}
              onConfigDeleted={handleConfigSaved}
              onEdit={() => setEditing(true)}
              onDeploy={onDeploy}
            />
          )}
        </ContentWidth>
      </div>
    </div>
  );
}
