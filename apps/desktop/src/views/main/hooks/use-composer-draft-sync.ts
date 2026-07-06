import { useCallback, useEffect, useRef } from "react";

import type { TabId } from "../../../shared/rpc.js";
import { desktopRpc } from "../lib/desktop-rpc.js";

const DEBOUNCE_MS = 250;

/**
 * Debounced sync of the composer textarea value to the main process
 * (persisted draft).  Flushes on unmount and provides explicit schedule /
 * cancel controls for submit flows.
 */
export function useComposerDraftSync(tabId: TabId | undefined) {
  const pendingValue = useRef<string | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (tabId && pendingValue.current !== undefined) {
      void desktopRpc.request.setComposerDraft({
        tabId,
        value: pendingValue.current,
      });
      pendingValue.current = undefined;
    }
  }, [tabId]);

  const schedule = useCallback(
    (value: string) => {
      pendingValue.current = value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    pendingValue.current = undefined;
  }, []);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  return { schedule, cancel, flush };
}
