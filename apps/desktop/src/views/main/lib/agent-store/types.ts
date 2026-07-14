import type { AdCampaign, AdPlacement, AgentEvent } from "../../../../shared/agent-protocol.js";
import type {
  AgentStatus,
  ContextStats,
  DesktopSettings,
  DiffScope,
  FileDiff,
  Message,
  ModelMetadata,
  PendingAttachment,
  PersistedSession,
  QueuedFollowUp,
  SessionWorktree,
  Session,
  TabMessageHydrationStatus,
} from "../../../../shared/rpc.js";
import type { TabId } from "../../../../shared/tab-utils.js";

export type Tab = {
  id: TabId;
  title: string;
  folderPath: string;
  projectColor: string;
  worktree?: SessionWorktree;
  messages: Message[];
  isThinking: boolean;
  currentModel?: string;
  availableModels: string[];
  connectionState: AgentStatus["state"];
  connectionError?: string;
  connectionStderr?: string;
  /** If the current connectionError has been dismissed, this holds the raw
   *  error string that was hidden. A new/different error will still show. */
  connectionErrorDismissed?: string;
  createdAt: number;
  updatedAt: number;
  composerValue: string;
  queuedMessages: QueuedFollowUp[];
  /** Files the user attached to the next prompt (picked from the dialog or
   *  pasted from the clipboard).  Rendered as preview chips above the
   *  composer and serialized into the prompt text at submission time.
   *  Optional on the wire (older sessions predate this field) — callers
   *  that need to read it should fall back to `[]`. */
  pendingAttachments?: PendingAttachment[];
  selectedMessageId?: string;
  thinkingBanner?: AdCampaign;
  sidebarAd?: AdCampaign;
  nativeAds?: AdCampaign[];
  thinkingStartedAt?: number;
  /** Whether the live context-reporter extension owns the context stats. */
  hasLiveContextReport?: boolean;
  /** Whether to render the model's thinking process in the message list. */
  showThinking: boolean;
  /** Thinking messages buffered for the current/visible session. */
  thinkingMessages: Message[];
  /** If set, all messages with id >= revertMessageId are considered reverted (hidden). */
  revertMessageId?: string;
  /** Diff summary shown in the revert dock (populated by file-level rewind). */
  revertDiffSummary?: string;
  /** Git checkpoint id captured immediately before file restore; used to undo file changes on cancel. */
  revertSafetyCheckpointId?: string;
  /** Live token / context / cost statistics for the session, populated
   *  directly by the agent's `herman/context_report` events. */
  contextStats?: ContextStats;
  /** Auto-retry state when the agent crashes or errors during a turn. */
  retryState?: {
    attempt: number;
    message: string;
    /** Unix timestamp (ms) for the next retry attempt. */
    next: number;
  };
  /** Latest resume hydration result from the main process agent snapshot. */
  messagesHydrationStatus?: "pending" | "success" | "empty" | "failed";
  messagesHydrationError?: string;
};

export type AgentState = {
  tabs: Record<TabId, Tab>;
  tabOrder: TabId[];
  activeTabId: TabId | undefined;
  projects: string[];
  sessions: PersistedSession[];
  ui: {
    sidebarOpen: boolean;
    sidebarWidth: number;
    composerValue: string;
    modelSelectorOpen: boolean;
    selectedMessageId?: string;
    view: "home" | "session" | "settings";
    selectedProject: string | null;
    /** Currently active sidebar tab ("changes" | "context" | "ads") */
    sidebarTab: "changes" | "context" | "ads";
    /** Selected diff scope */
    diffScope: "last-message" | "everything" | "working-tree";
    /** Current diff results, keyed by tab ID */
    diffFiles: Record<TabId, FileDiff[]>;
    /** Whether a diff fetch is in progress, keyed by tab ID */
    diffLoading: Record<TabId, boolean>;
    /** Optional per-model metadata keyed by "provider/modelId". */
    modelMetadata: Record<string, ModelMetadata>;
  };
  settings: DesktopSettings;
  ads: {
    focused: boolean;
    visible: boolean;
    nativeInsertionsThisSession: number;
    nativeInsertionsToday: number;
    nativeInsertionDate: string;
    lastNativeMessageIndex: number | null;
  };
  /** Whether the onboarding wizard is visible (Rookie mode) */
  onboardingVisible: boolean;
  /**
   * Shared model catalog fed by agent models_sync events (tabs + wizard).
   * ModelSelector always reads this list — not a parallel fetch.
   */
  modelCatalog: {
    availableModels: string[];
  };
  /**
   * Model selection context for the onboarding wizard (detached from tabs).
   * Selection only — the list comes from modelCatalog.
   */
  wizard: {
    /** True while OnboardingWizard is mounted. */
    active: boolean;
    currentModel?: string;
    /** Active wizard session id, if the agent has been started. */
    sessionId?: string;
  };
  // Derived views of the active tab, kept for backward compatibility with
  // existing UI components that read global session/connection state.
  session: {
    messages: Message[];
    isThinking: boolean;
    currentModel?: string;
    availableModels: string[];
  };
  connection: {
    state: AgentStatus["state"];
    error?: string;
    stderr?: string;
  };
};

export type AgentActions = {
  setMode: (mode: "rookie" | "normal") => void;
  setOnboardingVisible: (visible: boolean) => void;
  createTab: (folderPath?: string, title?: string) => TabId;
  closeTab: (id: TabId) => void;
  activateTab: (id: TabId) => void;
  reorderTabs: (order: TabId[]) => void;
  updateTab: (id: TabId, partial: Partial<Omit<Tab, "id">>) => void;
  renameTab: (id: TabId, title: string) => void;
  setProjectForTab: (id: TabId, folderPath: string) => void;
  appendUserMessage: (tabId: TabId, content: string, messageId?: string) => string | undefined;
  startAssistantMessage: (tabId: TabId) => void;
  appendAssistantDelta: (tabId: TabId, delta: string) => void;
  finalizeAssistantMessage: (tabId: TabId) => void;
  stopStreaming: (tabId: TabId) => void;
  updateTool: (
    tabId: TabId,
    toolCallId: string,
    update: Partial<Extract<Message, { role: "tool" }>>,
  ) => void;
  setThinking: (tabId: TabId, isThinking: boolean) => void;
  setShowThinking: (tabId: TabId, enabled: boolean) => void;
  setModels: (tabId: TabId, currentModel?: string, availableModels?: string[]) => void;
  clearTab: (id: TabId) => void;
  setConnectionState: (tabId: TabId, status: AgentStatus) => void;
  restoreTabs: (
    tabs: Tab[],
    activeTabId?: TabId,
    projects?: string[],
    sessions?: PersistedSession[],
  ) => void;
  applyMessagesHydration: (
    tabId: TabId,
    status: TabMessageHydrationStatus,
    messages: Message[],
    error?: string,
    contextStats?: ContextStats,
  ) => void;
  addTab: (tab: Tab) => void;
  setProjects: (projects: string[]) => void;
  setSessions: (sessions: PersistedSession[]) => void;
  setView: (view: "home" | "session" | "settings") => void;
  setSelectedProject: (folderPath: string | null) => void;
  setSettings: (settings: DesktopSettings) => void;
  handleProjectOpened: (folderPath: string, projects: string[]) => void;
  setComposerValue: ((value: string) => void) & ((tabId: TabId, value: string) => void);
  revertTab: (tabId: TabId, messageId: string) => void;
  unrevertTab: (tabId: TabId) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setSidebarTab: (tab: "changes" | "context" | "ads") => void;
  setDiffScope: (scope: DiffScope) => void;
  fetchDiff: (tabId: TabId, scope: DiffScope) => Promise<void>;
  setModelSelectorOpen: (open: boolean) => void;
  setModelCatalog: (models: string[], opts?: { merge?: boolean }) => void;
  setWizardCurrentModel: (modelId: string) => void;
  setWizardSessionId: (sessionId: string | undefined) => void;
  setWizardActive: (active: boolean) => void;
  clearWizardState: () => void;
  setAdVisibility: (focused: boolean, visible: boolean) => void;
  setTabAd: (tabId: TabId, placement: AdPlacement, campaign?: AdCampaign) => void;
  clearTabAds: (tabId: TabId) => void;
  recordAgentEvent: (tabId: TabId, event: AgentEvent) => void;
  queueMessage: (tabId: TabId, text: string) => void;
  removeQueuedMessage: (tabId: TabId, id: string) => void;
  editQueuedMessage: (tabId: TabId, id: string, text: string) => void;
  dequeueMessage: (tabId: TabId) => QueuedFollowUp | undefined;
  addAttachment: (tabId: TabId, attachment: PendingAttachment) => void;
  removeAttachment: (tabId: TabId, id: string) => void;
  clearAttachments: (tabId: TabId) => void;
  clearSession: () => void;
};

export type AppSession = {
  session?: Session;
};
