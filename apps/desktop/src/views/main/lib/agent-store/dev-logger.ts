import { useAgentStore } from "./store.js";
import type { Tab } from "./types.js";

// Dev-only: log every store mutation so we can trace what's causing
// periodic re-renders after streaming ends.
// Tree-shaken at production build time (import.meta.env.DEV → false).
if (import.meta.env.DEV) {
  useAgentStore.subscribe((state, prevState) => {
    const changed: string[] = [];
    if (state.activeTabId !== prevState.activeTabId) changed.push("activeTabId");
    if (state.tabs !== prevState.tabs) changed.push("tabs");
    if (state.ui !== prevState.ui) changed.push("ui");
    if (state.session !== prevState.session) changed.push("session");
    if (state.connection !== prevState.connection) changed.push("connection");
    if (state.tabOrder !== prevState.tabOrder) changed.push("tabOrder");
    if (state.projects !== prevState.projects) changed.push("projects");
    if (state.sessions !== prevState.sessions) changed.push("sessions");
    if (changed.length === 0) return;

    const tabDiffs: string[] = [];
    if (state.tabs !== prevState.tabs) {
      for (const id of Object.keys(state.tabs)) {
        const prevTab = prevState.tabs[id];
        const nextTab = state.tabs[id];
        if (!prevTab || !nextTab || prevTab === nextTab) continue;
        const fields: string[] = [];
        for (const key of Object.keys(nextTab) as (keyof Tab)[]) {
          if (key === "updatedAt") continue;
          if (nextTab[key] !== prevTab[key]) fields.push(key);
        }
        if (fields.length > 0) tabDiffs.push(`${id}: ${fields.join(",")}`);
      }
    }

    console.log(
      "[store] mutation:",
      changed.join(", "),
      tabDiffs.length > 0 ? `| ${tabDiffs.join(" | ")}` : "",
      new Date().toISOString(),
    );
  });
}
