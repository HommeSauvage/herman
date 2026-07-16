import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";

const PREVIEW_NAV_RULES = [
  "^*",
  "*://localhost:*/*",
  "*://127.0.0.1:*/*",
  "*://[::1]:*/*",
] as const;

const PREVIEW_MASKS =
  "[data-herman-overlay],[data-slot='dialog-overlay'],[data-slot='dialog-content']";

export type PreviewWebviewHandle = {
  reload: () => void;
  syncNow: () => void;
  setPassthrough: (enabled: boolean) => void;
  setHidden: (hidden: boolean) => void;
};

type PreviewWebviewProps = {
  url: string;
  className?: string;
  style?: CSSProperties;
};

function hasElectrobunWebview(): boolean {
  return typeof customElements !== "undefined" && Boolean(customElements.get("electrobun-webview"));
}

export const PreviewWebview = forwardRef<PreviewWebviewHandle, PreviewWebviewProps>(
  function PreviewWebview({ url, className, style }, ref) {
    const elementRef = useRef<ElectrobunWebviewElement | null>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const useNative = hasElectrobunWebview();

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          if (useNative) {
            elementRef.current?.reload();
          } else if (iframeRef.current) {
            iframeRef.current.src = iframeRef.current.src;
          }
        },
        syncNow: () => {
          elementRef.current?.syncDimensions(true);
        },
        setPassthrough: (enabled) => {
          elementRef.current?.togglePassthrough(enabled);
        },
        setHidden: (hidden) => {
          elementRef.current?.toggleHidden(hidden);
        },
      }),
      [useNative],
    );

    useEffect(() => {
      if (!useNative) return;
      const el = elementRef.current;
      if (!el || typeof el.setNavigationRules !== "function") return;
      el.setNavigationRules([...PREVIEW_NAV_RULES]);
    }, [useNative, url]);

    const mergedStyle: CSSProperties = {
      width: "100%",
      height: "100%",
      display: "block",
      ...style,
    };

    if (!useNative) {
      return (
        <iframe
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
        ref={elementRef}
        src={url}
        sandbox
        partition="preview"
        masks={PREVIEW_MASKS}
        className={className}
        style={mergedStyle}
      />
    );
  },
);
