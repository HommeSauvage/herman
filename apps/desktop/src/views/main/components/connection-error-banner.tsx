import { AlertTriangle, RefreshCcw, X } from "lucide-react";
import { memo, useCallback } from "react";

import type { TabId } from "../../../shared/rpc.js";
import { retryAgent } from "../lib/agent-actions.js";

/**
 * ConnectionErrorBanner — a compact error banner shown above the composer
 * when the agent connection is in a crashed/error state.  This is always
 * visible (not inline in the scroll area) so the user never misses it.
 *
 * During auto-retry (retryState is set), the Retry button is replaced with
 * an animated "Retrying…" label to avoid concurrent restart calls.
 *
 * Pattern adapted from T3Code's ComposerBannerStack / ThreadErrorBanner.
 */
export const ConnectionErrorBanner = memo(function ConnectionErrorBanner({
  tabId,
  connectionState,
  connectionError,
  retryState,
  onDismiss,
}: {
  tabId: TabId;
  connectionState: string;
  connectionError?: string;
  retryState?: { attempt: number; message: string; next: number };
  onDismiss: () => void;
}) {
  const isCrashed = connectionState === "crashed";
  const hasError = !!connectionError || isCrashed;
  const isRetrying = !!retryState;

  if (!hasError) return null;

  const message = connectionError ?? "Agent process stopped unexpectedly";
  // Keep the composer banner compact — one line with a tooltip.
  const shortMessage =
    message.length > 70 ? message.slice(0, 70) + "…" : message;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-3 py-2">
        <AlertTriangle size={13} className="shrink-0 text-red-400" />
        <p className="min-w-0 flex-1 truncate text-xs text-red-300/70" title={message}>
          {shortMessage}
        </p>
        {isRetrying ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            Retrying…
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void retryAgent(tabId)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-300 transition hover:bg-red-500/20"
          >
            <RefreshCcw size={10} />
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1 text-ghost transition hover:text-dim"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
});
