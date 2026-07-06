import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { AlertTriangle, RefreshCcw, X, ChevronDown, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import type { TabId } from "../../../shared/rpc.js";
import { retryAgent } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";

/**
 * Max error length before truncation in the display card. Messages longer
 * than this are shown with an ellipsis and a tooltip.
 */
const MAX_ERROR_LENGTH = 100;

/**
 * ErrorBanner — inline error card shown in the message list when the agent
 * crashes or encounters an error.
 *
 * States:
 * - **retry** (has retryState with future `next`):  Shows a countdown to the
 *   next automatic retry, plus a "Retry now" button to skip the wait.
 * - **crashed** (has error, no auto-retry active):  Shows the error with a
 *   manual "Retry" button.
 * - **dismissed** (user clicked dismiss):  Hidden until the next error.
 */
export const ErrorBanner = memo(function ErrorBanner({
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
  const [dismissed, setDismissed] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [manualRetrying, setManualRetrying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const connectionStderr = useAgentStore(
    (s) => s.tabs[tabId]?.connectionStderr,
  );

  // Generate a stable key for this error instance so we can detect new errors
  // vs. the same error the user already dismissed.
  const errorKey = retryState
    ? `retry:${retryState.attempt}:${retryState.next}`
    : connectionError
      ? `error:${connectionError}`
      : null;

  // Reset dismissed state when the error changes.
  useEffect(() => {
    if (errorKey && errorKey !== dismissedKey) {
      setDismissed(false);
    }
  }, [errorKey, dismissedKey]);

  // Live countdown timer when in auto-retry mode.
  useEffect(() => {
    if (!retryState) {
      setSeconds(0);
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, Math.round((retryState.next - Date.now()) / 1000));
      setSeconds(remaining);
    };
    tick();
    timerRef.current = setInterval(tick, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [retryState?.next]);

  const handleRetry = useCallback(async () => {
    setManualRetrying(true);
    try {
      await retryAgent(tabId);
    } catch {
      // Error will surface via the store's connectionState.
    } finally {
      setManualRetrying(false);
    }
  }, [tabId]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setDismissedKey(errorKey);
    onDismiss();
  }, [errorKey, onDismiss]);

  // Determine what to show.
  const isCrashed = connectionState === "crashed";
  const isRetrying = retryState && !dismissed;
  const hasError = (connectionError || isCrashed) && !dismissed;

  if (!hasError && !isRetrying) return null;

  // Build display message.
  const message = isRetrying
    ? retryState!.message
    : connectionError ?? "Agent process stopped unexpectedly";

  const truncated = message.length > MAX_ERROR_LENGTH;
  const displayMessage = truncated ? message.slice(0, MAX_ERROR_LENGTH) + "…" : message;

  const isRetryDisabled = manualRetrying;
  const retryLabel = manualRetrying
    ? "Restarting…"
    : isRetrying
      ? seconds > 0
        ? `Retry now (${seconds}s)`
        : "Retrying…"
      : "Retry";

  return (
    <div className="mx-auto w-full max-w-3xl px-5">
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
            <AlertTriangle size={16} />
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-red-300">
                {isRetrying
                  ? `Agent error — auto-retrying (attempt ${retryState!.attempt})`
                  : "Agent error"}
              </p>
              {isRetrying && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                  {retryLabel}
                </span>
              )}
            </div>

            {/* Error message */}
            <div className="mt-1">
              {truncated ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <p className="text-sm leading-relaxed text-red-300/60 cursor-help">
                        {displayMessage}
                      </p>
                    }
                  />
                  <TooltipContent side="top" className="max-w-96 whitespace-pre-wrap text-xs">
                    {message}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <p className="text-sm leading-relaxed text-red-300/60">{displayMessage}</p>
              )}
            </div>

            {/* Actions */}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleRetry}
                disabled={isRetryDisabled}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCcw
                  size={12}
                  className={manualRetrying ? "animate-spin" : undefined}
                />
                {retryLabel}
              </button>

              <button
                type="button"
                onClick={handleDismiss}
                className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-dim transition hover:bg-white/[0.06] hover:text-text"
              >
                <X size={12} />
                Dismiss
              </button>

              {connectionStderr && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/[0.04] bg-transparent px-2 py-1.5 text-xs font-medium text-ghost transition hover:text-dim"
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Details
                </button>
              )}
            </div>

            {/* Expandable stderr */}
            {expanded && connectionStderr && (
              <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-dim whitespace-pre-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {connectionStderr}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
