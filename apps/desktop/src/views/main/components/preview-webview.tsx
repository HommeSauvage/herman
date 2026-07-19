import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";

import {
  PREVIEW_CONSOLE_PRELOAD,
  parsePreviewHostMessage,
} from "../lib/preview-webview-bridge.js";
import type { PreviewConsoleEntry } from "@herman/rpc/host-bridge";

const PREVIEW_NAV_RULES = [
  "^*",
  "*://localhost:*/*",
  "*://127.0.0.1:*/*",
  "*://[::1]:*/*",
] as const;

// Masks are holes punched through the native webview so DOM overlays can
// show (and be clicked) through it. Target `[data-sonner-toast]` rather than
// `[data-sonner-toaster]`: sonner's <ol> only exists while toasts are shown
// and all <li> toasts are position:absolute, so the toaster's own rect
// collapses to height 0 while the toast <li>s have the real visible boxes.
const PREVIEW_MASKS =
  "[data-herman-overlay],[data-slot='dialog-overlay'],[data-slot='dialog-content'],[data-sonner-toast]";

export type PreviewClientError = {
  message: string;
  stack?: string;
};

export type PreviewConsoleEntryCallback = (entry: PreviewConsoleEntry) => void;

export type PreviewWebviewHandle = {
  goBack: () => void;
  loadURL: (url: string) => void;
  canGoBack: () => Promise<boolean>;
  reload: () => void;
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
  onConsoleEntry?: PreviewConsoleEntryCallback;
  onNavigate?: (url: string) => void;
  className?: string;
  style?: CSSProperties;
};

function hasElectrobunWebview(): boolean {
  return typeof customElements !== "undefined" && Boolean(customElements.get("electrobun-webview"));
}

function readNavigateUrl(detail: unknown): string | null {
  if (typeof detail === "object" && detail !== null && "url" in detail) {
    const url = (detail as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

export const PreviewWebview = forwardRef<PreviewWebviewHandle, PreviewWebviewProps>(
  function PreviewWebview(
    {
      url,
      reloadRevision = 0,
      hidden = false,
      passthrough = false,
      continuousSync = false,
      onClientError,
      onConsoleEntry,
      onNavigate,
      className,
      style,
    },
    ref,
  ) {
    const elementRef = useRef<ElectrobunWebviewElement | null>(null);
    // Separate ref for unmount cleanup: the callback ref nulls elementRef.current
    // before passive effect cleanups run in some React versions, so we keep a
    // dedicated ref that is never nulled to guarantee the native overlay is hidden.
    const cleanupElRef = useRef<ElectrobunWebviewElement | null>(null);
    // Set once the component unmounts — every imperative call into the native
    // webview no-ops afterwards so we never race the BrowserView removal
    // (which logs "BrowserView not found or has no ptr" warnings).
    const disposedRef = useRef(false);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const onClientErrorRef = useRef(onClientError);
    const onConsoleEntryRef = useRef(onConsoleEntry);
    const onNavigateRef = useRef(onNavigate);
    const detachHostMessageRef = useRef<(() => void) | undefined>(undefined);
    const detachNavigateRef = useRef<(() => void) | undefined>(undefined);
    const prevReloadRevisionRef = useRef(reloadRevision);
    const useNative = hasElectrobunWebview();

    useEffect(() => {
      onClientErrorRef.current = onClientError;
    }, [onClientError]);

    useEffect(() => {
      onConsoleEntryRef.current = onConsoleEntry;
    }, [onConsoleEntry]);

    useEffect(() => {
      onNavigateRef.current = onNavigate;
    }, [onNavigate]);

    const attachHostMessageListener = useCallback(
      (el: ElectrobunWebviewElement): (() => void) | undefined => {
        if (typeof el.on !== "function") return undefined;

        const listener = (event: CustomEvent) => {
          const parsed = parsePreviewHostMessage(event.detail);
          if (!parsed) return;
          const entry: PreviewConsoleEntry = {
            level: parsed.level,
            message: parsed.message,
            stack: parsed.stack,
            url: parsed.url ?? "",
            ts: parsed.ts ?? Date.now(),
          };
          onConsoleEntryRef.current?.(entry);
          if (parsed.level === "error") {
            onClientErrorRef.current?.({ message: parsed.message, stack: parsed.stack });
          }
        };

        el.on("host-message", listener);
        return () => {
          el.off?.("host-message", listener);
        };
      },
      [],
    );

    const attachNavigateListener = useCallback(
      (el: ElectrobunWebviewElement): (() => void) | undefined => {
        if (typeof el.on !== "function") return undefined;

        const handleNavigate = (event: CustomEvent) => {
          const nextUrl = readNavigateUrl(event.detail);
          if (nextUrl) onNavigateRef.current?.(nextUrl);
        };

        el.on("did-navigate", handleNavigate);
        el.on("did-navigate-in-page", handleNavigate);
        return () => {
          el.off?.("did-navigate", handleNavigate);
          el.off?.("did-navigate-in-page", handleNavigate);
        };
      },
      [],
    );

    const webviewRefCallback = useCallback(
      (node: ElectrobunWebviewElement | null) => {
        detachHostMessageRef.current?.();
        detachHostMessageRef.current = undefined;
        detachNavigateRef.current?.();
        detachNavigateRef.current = undefined;
        elementRef.current = node;
        // Keep cleanupElRef alive so the unmount effect can always reach the
        // element regardless of whether React calls the ref callback before or
        // after passive effect cleanups.
        if (node) cleanupElRef.current = node;
        if (!node) return;

        detachHostMessageRef.current = attachHostMessageListener(node);
        detachNavigateRef.current = attachNavigateListener(node);
        if (typeof node.setNavigationRules === "function") {
          node.setNavigationRules([...PREVIEW_NAV_RULES]);
        }
      },
      [attachHostMessageListener, attachNavigateListener],
    );

    useImperativeHandle(
      ref,
      () => ({
        goBack: () => {
          if (disposedRef.current) return;
          if (useNative) {
            elementRef.current?.goBack();
            return;
          }
          // iframe fallback: no history API access
        },
        loadURL: (nextUrl: string) => {
          if (disposedRef.current) return;
          if (useNative) {
            elementRef.current?.loadURL(nextUrl);
            return;
          }
          if (iframeRef.current) {
            iframeRef.current.src = nextUrl;
          }
        },
        canGoBack: async () => {
          if (disposedRef.current) return false;
          if (!useNative || typeof elementRef.current?.canGoBack !== "function") {
            return false;
          }
          return elementRef.current.canGoBack();
        },
        reload: () => {
          if (disposedRef.current) return;
          if (useNative) {
            elementRef.current?.reload();
            return;
          }
          const iframe = iframeRef.current;
          if (!iframe) return;
          try {
            iframe.contentWindow?.location.reload();
          } catch {
            const src = iframe.getAttribute("src");
            if (src) iframe.src = src;
          }
        },
      }),
      [useNative],
    );

    // On unmount, hide the native BrowserView before the DOM element is
    // removed.  This prevents the native overlay from lingering as an
    // orphaned view after the anchor element is gone.
    //
    // Uses cleanupElRef (never nulled) instead of elementRef because React
    // may call the callback ref with null before passive effect cleanups.
    // No loadURL("about:blank") here — navigating after disconnect races the
    // native view removal and logs "BrowserView not found" warnings.
    useEffect(() => {
      return () => {
        disposedRef.current = true;
        detachHostMessageRef.current?.();
        detachNavigateRef.current?.();
        if (useNative) {
          const el = cleanupElRef.current;
          if (el) {
            // Hide the native overlay immediately so it doesn't flash stale
            // content while the async webviewTagRemove message is in flight.
            try {
              el.toggleHidden(true);
            } catch {
              // The native view may already be torn down.
            }
          }
        }
      };
    }, [useNative]);

    // Hidden / passthrough are independent toggles the native webview exposes;
    // keep them in sync with props without needing an imperative parent ref.
    useEffect(() => {
      if (!useNative || disposedRef.current) return;
      elementRef.current?.toggleHidden(hidden);
    }, [useNative, hidden]);

    useEffect(() => {
      if (!useNative || disposedRef.current) return;
      elementRef.current?.togglePassthrough(passthrough);
    }, [useNative, passthrough]);

    // Bumping reloadRevision (restart, "try again", etc.) triggers a reload —
    // skip the very first render so mounting doesn't reload immediately.
    useEffect(() => {
      if (reloadRevision === prevReloadRevisionRef.current) return;
      prevReloadRevisionRef.current = reloadRevision;
      if (disposedRef.current) return;
      if (useNative) {
        elementRef.current?.reload();
      }
      // The iframe fallback reloads by remounting via `key={reloadRevision}`.
    }, [reloadRevision, useNative]);

    // Keep the native overlay's bounds glued to the host element's box —
    // covers device-mode changes, split-pane resizes, and window resizes.
    useEffect(() => {
      if (!useNative || disposedRef.current) return;
      const el = elementRef.current;
      if (!el) return;

      el.syncDimensions(true);

      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        if (disposedRef.current) return;
        el.syncDimensions();
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [useNative, url]);

    // While a split divider is being actively dragged, layout can change every
    // frame faster than ResizeObserver callbacks land — run a RAF loop instead.
    useEffect(() => {
      if (!useNative || !continuousSync || disposedRef.current) return;
      let raf = 0;
      const tick = () => {
        if (disposedRef.current) return;
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
        // sandbox
        partition="preview"
        masks={PREVIEW_MASKS}
        preload={PREVIEW_CONSOLE_PRELOAD}
        hidden={hidden}
        className={className}
        style={mergedStyle}
      />
    );
  },
);
