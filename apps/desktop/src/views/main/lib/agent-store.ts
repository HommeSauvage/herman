// This file has been refactored into the agent-store/ directory.
// All exports are preserved for backward compatibility.
// See agent-store/ for the modular implementation.

export type { Tab, AgentState, AgentActions, AppSession } from "./agent-store/types.js";

export { useAgentStore } from "./agent-store/store.js";
export { useAppStore } from "./agent-store/app-store.js";

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
} from "./agent-store/hooks.js";

// Side-effect: dev-only store mutation logger
import "./agent-store/dev-logger.js";
