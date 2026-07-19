// This file has been refactored into the agent-store/ directory.
// All exports are preserved for backward compatibility.
// See agent-store/ for the modular implementation.

export { useAppStore } from "./agent-store/app-store.js";
export {
  isTabAgentRunning,
  isTabWorking,
  useActiveTab,
  useActiveTabStable,
  useComposerValue,
  useIsActiveTabWorking,
  useTab,
  useTabSummaries,
  useTabs,
} from "./agent-store/hooks.js";
export { useAgentStore } from "./agent-store/store.js";
export type { AgentActions, AgentState, AppSession, Tab, WizardStep } from "./agent-store/types.js";
export { INITIAL_WIZARD_STATE } from "./agent-store/types.js";

// Side-effect: dev-only store mutation logger
import "./agent-store/dev-logger.js";
