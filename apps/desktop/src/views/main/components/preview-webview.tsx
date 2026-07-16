import { useCallback, useEffect, useRef, type CSSProperties } from "react";

import {
  PREVIEW_CONSOLE_PRELOAD,
  parsePreviewHostMessage,
} from "../lib/preview-webview-bridge.js";

const PREVIEW_NAV_RULES = [
  "^*",
  "*://localhost:*/*",
  "*://127.0.0.1:*/*",
  "*://[::1]:*/*",
] as const;

const PREVIEW_MASKS =
  "[data-herman-overlay],[data-slot='dialog-overlay'],[data-slot='dialog-content'],[data-herman-preview-error-banner]";

export type PreviewClientError = {
  message: string;
  stack?: string;
};

type PreviewWebviewProps = {
  url: string;
  /** Bump to force a reload (native webview `.reload()` / iframe remount). */
  reloadRevision?: number;
  /** Hides the webview without unmounting it (overlays, dialogs, etc.). */
  hidden?: boolean;
  /** Lets clicks pass through to elements below (e.g. while resizing a split). */
  passthrough?: boolean;
  /** Runs a RAF loop that keeps the native webview's bounds in sync every
   *  frame — needed while a split divider is actively being dragged. */
  continuousSync?: boolean;
  onClientError?: (error: PreviewClientError) => void;
  className?: string;
  style?: CSSProperties;
};

function hasElectrobunWebview(): boolean {
  return typeof customElements !== "undefined" && Boolean(customElements.get("electrobun-webview"));
}

export function PreviewWebview({
  url,
  reloadRevision = 0,
  hidden = false,
  passthrough = false,
  continuousSync = false,
  onClientError,
  className,
  style,
}: PreviewWebviewProps) {
  const elementRef = useRef<ElectrobunWebviewElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onClientErrorRef = useRef(onClientError);
  const detachHostMessageRef = useRef<(() => void) | undefined>(undefined);
  const prevReloadRevisionRef = useRef(reloadRevision);
  const useNative = hasElectrobunWebview();

  useEffect(() => {
    onClientErrorRef.current = onClientError;
  }, [onClientError]);

  const attachHostMessageListener = useCallback(
    (el: ElectrobunWebviewElement): (() => void) | undefined => {
      if (typeof el.on !== "function") return undefined;

      const listener = (event: CustomEvent) => {
        const parsed = parsePreviewHostMessage(event.detail);
        if (!parsed) return;
        onClientErrorRef.current?.({ message: parsed.message, stack: parsed.stack });
      };

      el.on("host-message", listener);
      return () => {
        el.off?.("host-message", listener);
      };
    },
    [],
  );

  const webviewRefCallback = useCallback(
    (node: ElectrobunWebviewElement | null) => {
      detachHostMessageRef.current?.();
      detachHostMessageRef.current = undefined;
      elementRef.current = node;
      if (!node) return;

      detachHostMessageRef.current = attachHostMessageListener(node);
      if (typeof node.setNavigationRules === "function") {
        node.setNavigationRules([...PREVIEW_NAV_RULES]);
      }
    },
    [attachHostMessageListener],
  );

  useEffect(() => {
    return () => {
      detachHostMessageRef.current?.();
    };
  }, []);

  // Hidden / passthrough are independent toggles the native webview exposes;
  // keep them in sync with props without needing an imperative parent ref.
  useEffect(() => {
    if (!useNative) return;
    elementRef.current?.toggleHidden(hidden);
  }, [useNative, hidden]);

  useEffect(() => {
    if (!useNative) return;
    elementRef.current?.togglePassthrough(passthrough);
  }, [useNative, passthrough]);

  // Bumping reloadRevision (restart, "try again", etc.) triggers a reload —
  // skip the very first render so mounting doesn't reload immediately.
  useEffect(() => {
    if (reloadRevision === prevReloadRevisionRef.current) return;
    prevReloadRevisionRef.current = reloadRevision;
    if (useNative) {
      elementRef.current?.reload();
    }
    // The iframe fallback reloads by remounting via `key={reloadRevision}`.
  }, [reloadRevision, useNative]);

  // Keep the native overlay's bounds glued to the host element's box —
  // covers device-mode changes, split-pane resizes, and window resizes.
  useEffect(() => {
    if (!useNative) return;
    const el = elementRef.current;
    if (!el) return;

    el.syncDimensions(true);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      el.syncDimensions();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [useNative, url]);

  // While a split divider is being actively dragged, layout can change every
  // frame faster than ResizeObserver callbacks land — run a RAF loop instead.
  useEffect(() => {
    if (!useNative || !continuousSync) return;
    let raf = 0;
    const tick = () => {
      elementRef.current?.syncDimensions(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [useNative, continuousSync]);

  const mergedStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    display: "block",
    ...style,
  };

  if (!useNative) {
    return (
      <iframe
        key={reloadRevision}
        ref={iframeRef}
        src={url}
        className={className}
        style={mergedStyle}
        title="Site preview"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    );
  }

  return (
    <electrobun-webview
      ref={webviewRefCallback}
      src={url}
      sandbox
      partition="preview"
      masks={PREVIEW_MASKS}
      preload={PREVIEW_CONSOLE_PRELOAD}
      hidden={hidden}
      className={className}
      style={mergedStyle}
    />
  );
}
