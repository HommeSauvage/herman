import { TooltipProvider } from "@herman/ui/components/tooltip";
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { configureViewLogging } from "../../view-logging.js";
import { App } from "./app.js";

import "./index.css";

await configureViewLogging();

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
