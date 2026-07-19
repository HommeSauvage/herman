import { shallowEqual } from "./compare.js";
import type { AgentState, Tab } from "./types.js";

export function deriveSession(activeTab: Tab | undefined): AgentState["session"] {
  return {
    messages: activeTab?.messages ?? [],
    isThinking: activeTab?.isThinking ?? false,
    currentModel: activeTab?.currentModel,
    availableModels: activeTab?.availableModels ?? [],
  };
}

export function deriveConnection(activeTab: Tab | undefined): AgentState["connection"] {
  return {
    state: activeTab?.connectionState ?? "idle",
    error: activeTab?.connectionError,
    stderr: activeTab?.connectionStderr,
  };
}

export function deriveUi(state: AgentState, activeTab: Tab | undefined): AgentState["ui"] {
  return {
    ...state.ui,
    composerValue: activeTab?.composerValue ?? "",
    selectedMessageId: activeTab?.selectedMessageId,
  };
}

export function rebuildDerived(
  state: AgentState,
  tabs: Record<string, Tab>,
): Pick<AgentState, "session" | "connection" | "ui"> {
  const activeTab = state.activeTabId ? tabs[state.activeTabId] : undefined;
  const session = deriveSession(activeTab);
  const connection = deriveConnection(activeTab);
  const ui = deriveUi(state, activeTab);

  return {
    session: shallowEqual(session, state.session) ? state.session : session,
    connection: shallowEqual(connection, state.connection) ? state.connection : connection,
    ui: shallowEqual(ui, state.ui) ? state.ui : ui,
  };
}
