import { getLogger } from "@logtape/logtape";
import { TooltipProvider } from "@herman/ui/components/tooltip";
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { configureViewLogging, getViewLogLevel } from "../../view-logging.js";
import { App } from "./app.js";
import { desktopRpc } from "./lib/desktop-rpc.js";

import "./index.css";

await configureViewLogging();

const logger = getLogger(["herman-desktop", "view", "main"]);

window.addEventListener("error", (event) => {
  logger.error("Uncaught error in renderer", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  logger.error("Unhandled rejection in renderer", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

const transport =
  typeof (desktopRpc as { request?: unknown }).request !== "undefined" ? "electrobun" : "browser";
logger.info("Renderer ready", { transport, logLevel: getViewLogLevel() });

// Dev-only: monkey-patch React to log which props/state changed on every re-render.
// Tree-shaken at production build time (import.meta.env.DEV → false).
if (import.meta.env.DEV) {
  const { default: wdyr } = await import("@welldone-software/why-did-you-render");
  wdyr(React, {
    trackAllPureComponents: false,
    trackHooks: true,
    logOnDifferentValues: true,
  });
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </StrictMode>,
  );
}
