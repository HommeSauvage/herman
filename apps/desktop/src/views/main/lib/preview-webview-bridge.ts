/**
 * Browser-side bridge for the preview `<electrobun-webview>` / iframe.
 *
 * Everything here executes twice, in two very different environments:
 *  - `serializeConsoleArg` runs both inside this (trusted) renderer bundle
 *    (for unit tests) AND is stringified verbatim into `PREVIEW_CONSOLE_PRELOAD`,
 *    which is injected into the *untrusted* preview page. Keep it
 *    self-contained (no closures over outer-scope variables) so `.toString()`
 *    produces valid, standalone JS.
 *  - `parsePreviewHostMessage` runs only on the host side, validating
 *    whatever the untrusted page's preload script forwards via
 *    `__electrobunSendToHost`.
 */

const MAX_MESSAGE_CHARS = 2000;

/**
 * Serialize an arbitrary console argument into a display string.
 * Defensive against circular references, throwing getters/toJSON, and other
 * hostile values a third-party preview page might log.
 *
 * Note: recursion is implemented as a nested function (rather than a
 * top-level helper) so `.toString()` on `serializeConsoleArg` alone yields a
 * complete, self-contained implementation for embedding in
 * `PREVIEW_CONSOLE_PRELOAD` below.
 */
export function serializeConsoleArg(value: unknown): string {
  // Top-level strings stay raw (unquoted) so `console.error("a", "b")`
  // reads as `a b`, not `"a" "b"`. Strings nested inside objects/arrays are
  // still JSON-quoted by `stringify` below for readability.
  if (typeof value === "string") return value;

  function stringify(v: unknown, ancestors: Set<object>): string {
    if (v instanceof Error) return v.stack || v.message || String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "function") return "[Function: " + (v.name || "anonymous") + "]";
    if (typeof v === "symbol") return v.toString();
    if (typeof v === "bigint") return v.toString() + "n";
    if (v === null || v === undefined) return String(v);
    if (typeof v !== "object") {
      var primitiveJson = JSON.stringify(v);
      return primitiveJson === undefined ? String(v) : primitiveJson;
    }

    // Only ancestors (objects currently on the recursion stack) count as
    // circular — the same object reachable via two sibling keys is fine.
    if (ancestors.has(v)) return '"[Circular]"';

    var withToJSON = v as { toJSON?: () => unknown };
    if (typeof withToJSON.toJSON === "function") {
      return stringify(withToJSON.toJSON.call(v), ancestors);
    }

    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        var items = v.map(function (item) {
          return stringify(item, ancestors);
        });
        return "[" + items.join(",") + "]";
      }
      var entries = [];
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i]!;
        var val = (v as Record<string, unknown>)[key];
        if (val === undefined || typeof val === "function" || typeof val === "symbol") continue;
        entries.push(JSON.stringify(key) + ":" + stringify(val, ancestors));
      }
      return "{" + entries.join(",") + "}";
    } finally {
      ancestors.delete(v);
    }
  }

  try {
    return stringify(value, new Set<object>());
  } catch (_err) {
    try {
      return Object.prototype.toString.call(value);
    } catch (_err2) {
      return "[Unserializable]";
    }
  }
}

/** Preload script injected into the preview webview to forward console
 *  messages, uncaught exceptions, and unhandled rejections to the host. */
export const PREVIEW_CONSOLE_PRELOAD = `
(function () {
  if (window.__hermanConsoleTap) return;
  window.__hermanConsoleTap = true;

  function send(payload) {
    try {
      if (typeof window.__electrobunSendToHost === "function") {
        window.__electrobunSendToHost(payload);
      }
    } catch (_) {}
  }
  var serializeArg = ${serializeConsoleArg.toString()};

  var levels = ["error", "warn", "info", "log", "debug"];
  for (var li = 0; li < levels.length; li++) {
    (function (level, orig) {
      console[level] = function () {
        var args = Array.prototype.slice.call(arguments);
        orig.apply(console, args);
        send({
          type: "preview-console",
          level: level,
          message: args.map(serializeArg).join(" "),
          url: location.href,
          ts: Date.now(),
        });
      };
    })(levels[li], console[levels[li]].bind(console));
  }

  window.addEventListener("error", function (e) {
    send({
      type: "preview-console",
      level: "error",
      message: e.message || "Script error",
      stack: e.error && e.error.stack ? e.error.stack : undefined,
      url: location.href,
      ts: Date.now(),
    });
  });

  window.addEventListener("unhandledrejection", function (e) {
    var reason = e.reason;
    var stack = reason instanceof Error ? reason.stack : undefined;
    send({
      type: "preview-console",
      level: "error",
      message: serializeArg(reason),
      stack: stack,
      url: location.href,
      ts: Date.now(),
    });
  });
})();
`.trim();

export type PreviewHostMessage = {
  type: "preview-console";
  level: "error" | "warn" | "info" | "log" | "debug";
  message: string;
  stack?: string;
  url?: string;
  ts?: number;
};

/**
 * Validate and sanitize an inbound `host-message` payload from the (untrusted)
 * preview webview. Returns `null` for anything that doesn't match the
 * expected shape.
 */
export function parsePreviewHostMessage(input: unknown): PreviewHostMessage | null {
  if (typeof input !== "object" || input === null) return null;
  const detail = input as Record<string, unknown>;

  if (detail.type !== "preview-console") return null;
  const level = detail.level;
  if (level !== "error" && level !== "warn" && level !== "info" && level !== "log" && level !== "debug") return null;
  if (typeof detail.message !== "string") return null;
  if (detail.message.trim().length === 0) return null;

  const message = detail.message.slice(0, MAX_MESSAGE_CHARS);
  const stack = typeof detail.stack === "string" ? detail.stack.slice(0, MAX_MESSAGE_CHARS) : undefined;
  const url = typeof detail.url === "string" ? detail.url : undefined;
  const ts = typeof detail.ts === "number" ? detail.ts : undefined;

  return {
    type: "preview-console",
    level,
    message,
    ...(stack !== undefined ? { stack } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(ts !== undefined ? { ts } : {}),
  };
}
