import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../src/views/main/app.js";

import "../src/views/main/index.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
