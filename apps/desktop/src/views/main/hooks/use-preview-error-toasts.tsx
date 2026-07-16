import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

import type { PreviewRuntimeError } from "../components/preview-error-banner";
import { formatRuntimeErrors, usePreviewStore } from "../lib/preview-store";

/**
 * Syncs `runtimeErrors` from the preview store to Sonner toasts. Each error
 * becomes an independently dismissible, non-auto-closing toast that stacks
 * with other toasts. The "Ask Herman" action reads the latest error snapshot
 * from the store so it always captures every current error.
 */
export function usePreviewErrorToasts(
  runtimeErrors: PreviewRuntimeError[],
  show: boolean,
) {
  const toastIdsRef = useRef<Map<string, string | number>>(new Map());
  // Track which error IDs the user has manually dismissed so we don't
  // recreate toasts for them on the next render cycle.
  const dismissedIdsRef = useRef<Set<string>>(new Set());

  // Stable callback that always reads the freshest errors from the store.
  const onAskFixRef = useRef(() => {
    const errors = usePreviewStore.getState().runtimeErrors;
    if (errors.length === 0) return;
    usePreviewStore.getState().askHermanToFix(
      formatRuntimeErrors(errors),
      "runtime",
    );
  });

  useEffect(() => {
    if (!show) {
      // Dismiss every toast and reset tracking.
      for (const id of toastIdsRef.current.values()) {
        toast.dismiss(id);
      }
      toastIdsRef.current.clear();
      dismissedIdsRef.current.clear();
      return;
    }

    const currentIds = new Set(runtimeErrors.map((e) => e.id));

    // Remove toasts for errors no longer in the list.
    for (const [errorId, toastId] of toastIdsRef.current) {
      if (!currentIds.has(errorId)) {
        toast.dismiss(toastId);
        toastIdsRef.current.delete(errorId);
      }
    }

    // Create toasts for new errors, but skip ones the user dismissed.
    for (const err of runtimeErrors) {
      if (toastIdsRef.current.has(err.id)) continue;
      if (dismissedIdsRef.current.has(err.id)) continue;

      const toastId = toast.error(err.message, {
        description:
          err.source === "client" ? "Browser runtime error" : "Server log error",
        duration: Infinity,
        closeButton: true,
        action: {
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={12} />
              Ask Herman
            </span>
          ),
          onClick: () => onAskFixRef.current(),
        },
        onDismiss: () => {
          // Mark this error as manually dismissed so it won't reappear.
          dismissedIdsRef.current.add(err.id);
          toastIdsRef.current.delete(err.id);
          // When the user dismisses the last visible toast, tell the
          // store so `selectShowRuntimeBanner` flips to false and the
          // effect stops running on every render.
          if (toastIdsRef.current.size === 0) {
            usePreviewStore.getState().dismissRuntimeErrors();
          }
        },
      });
      toastIdsRef.current.set(err.id, toastId);
    }
  }, [runtimeErrors, show]);

  // Cleanup on unmount so stale toasts never outlive the pane.
  useEffect(() => {
    return () => {
      for (const id of toastIdsRef.current.values()) {
        toast.dismiss(id);
      }
      toastIdsRef.current.clear();
      dismissedIdsRef.current.clear();
    };
  }, []);
}
