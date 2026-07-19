/**
 * Settings → Tools — every tool in Herman's curated registry with its
 * detection status and one-click install/repair. Normal-mode surface;
 * rookies reach the same install engine through the gated flows instead.
 */

import { Check, AlertCircle, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@herman/ui/lib/utils";

import type { ToolchainToolStatus } from "../../../../shared/tool-registry.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";
import { useToolchainInstall } from "../../lib/use-toolchain-install.js";

function tierLabel(tier: ToolchainToolStatus["tier"]): string {
  switch (tier) {
    case 0:
      return "Required";
    case 1:
      return "Common";
    default:
      return "Optional";
  }
}

export function ToolsTab() {
  const [tools, setTools] = useState<ToolchainToolStatus[] | null>(null);
  const { state, runInstall } = useToolchainInstall();

  const refresh = useCallback(async () => {
    const status = await desktopRpc.request.getToolchainStatus().catch(() => null);
    if (status) setTools(status.tools);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-detect once an install run completes.
  useEffect(() => {
    if (!state.running && state.tools.length > 0) void refresh();
  }, [state.running, state.tools.length, refresh]);

  const handleInstall = useCallback(
    (tool: ToolchainToolStatus) => {
      void runInstall([{ toolId: tool.id, label: tool.label }]);
    },
    [runInstall],
  );

  if (!tools) {
    return (
      <div className="text-dim flex items-center gap-2 text-sm">
        <Loader2 size={14} className="animate-spin" />
        Checking installed tools…
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h3 className="text-text text-sm font-semibold">Tools &amp; environment</h3>
      <p className="text-dim mt-1 text-xs leading-relaxed">
        The tools Herman uses to build and run your projects. Install or repair them here —
        everything comes from its official source.
      </p>

      <div className="mt-4 divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-white/[0.02]">
        {tools.map((tool) => {
          const progress = state.tools.find((t) => t.toolId === tool.id);
          const busy = progress?.state === "running" || progress?.state === "waiting";
          const failed = progress?.state === "failed";
          return (
            <div key={tool.id} className="flex items-center gap-3 px-4 py-3">
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                  tool.installed
                    ? "bg-emerald-500/10 text-emerald-400"
                    : "bg-white/[0.04] text-ghost",
                  failed && "bg-red-500/10 text-red-400",
                )}
              >
                {busy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : tool.installed ? (
                  <Check size={14} strokeWidth={2.5} />
                ) : (
                  <AlertCircle size={13} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-text text-sm font-medium">{tool.label}</span>
                  <span className="text-ghost text-[10px] tracking-wide uppercase">
                    {tierLabel(tool.tier)}
                  </span>
                </div>
                <p className="text-dim mt-0.5 truncate text-xs">
                  {tool.installed ? (tool.detail ?? "Installed") : tool.why}
                </p>
                {failed && progress?.note && (
                  <p className="mt-0.5 text-[11px] text-red-400">{progress.note}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {tool.manualUrl && !tool.installed ? (
                  <a
                    href={tool.manualUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-signal hover:underline flex items-center gap-1 text-xs"
                  >
                    Download <ExternalLink size={11} />
                  </a>
                ) : (
                  !tool.installed &&
                  tool.supported && (
                    <button
                      type="button"
                      disabled={busy || state.running}
                      onClick={() => handleInstall(tool)}
                      className="text-signal hover:bg-signal/10 flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition disabled:opacity-50"
                    >
                      <Download size={11} />
                      Install
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => void refresh()}
        className="text-ghost hover:text-dim mt-3 flex items-center gap-1.5 text-xs transition"
      >
        <RefreshCw size={11} />
        Re-check all
      </button>
    </div>
  );
}
