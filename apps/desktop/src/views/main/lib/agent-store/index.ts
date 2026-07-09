// Re-export everything from the split modules so existing imports from
// "./agent-store.js" continue to work without changes.

export type { Tab, AgentState, AgentActions, AppSession } from "./types.js";

export { useAgentStore } from "./store.js";
export { useAppStore } from "./app-store.js";

export {
  useActiveTab,
  useActiveTabStable,
  useComposerValue,
  isTabWorking,
  isTabAgentRunning,
  useTab,
  useTabs,
  useTabSummaries,
  useIsActiveTabWorking,
} from "./hooks.js";

// Kept for backward compatibility — only used internally now but was
// previously exported from the monolithic file.
export { applyAgentEventToThinkingMessages } from "./thinking.js";

// Side-effect: dev-only store mutation logger
import "./dev-logger.js";
