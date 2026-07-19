import type { AdCampaign, AdPlacement, AgentEvent } from "../../../../shared/agent-protocol.js";
import type {
  AgentStatus,
  ContextStats,
  DesktopSettings,
  DiffScope,
  FileDiff,
  Message,
  ModelCatalogSnapshot,
  ModelMetadata,
  PendingAttachment,
  PersistedSession,
  QueuedFollowUp,
  SessionSetupState,
  SessionWorktree,
  Session,
  TabMessageHydrationStatus,
} from "../../../../shared/rpc.js";
import type { TabId } from "../../../../shared/tab-utils.js";
import type { WizardAskEnvelope, WizardInstallEnvelope } from "../../../../shared/wizard-protocol.js";

export type WizardStep =
  | "templates"
  | "describe"
  | "setup"
  | "working"
  | "questions"
  | "done"
  | "error"
  | "retrying"
  | "recovery";

export type WizardPhaseId = "planning" | "coding" | "qa" | "docs";

export const INITIAL_WIZARD_STATE = {
  active: false,
  step: "templates" as WizardStep,
  phase: "planning" as WizardPhaseId,
  description: "",
  progressLines: [] as string[],
  envelope: null as WizardAskEnvelope | null,
  pendingRequestId: null as string | null,
  installRequest: null as { requestId: string; envelope: WizardInstallEnvelope } | null,
  projectPath: null as string | null,
  wizardError: null as string | null,
  retryAttempt: 0,
  retryMax: 20,
  recoveryMode: false as false | "continue",
  recoveryBlocked: false,
};

export type Tab = {
  id: TabId;
  title: string;
  folderPath: string;
  /** Stable project identity: git root if the folder is in a repo, otherwise folderPath. */
  projectRoot: string;
  projectColor: string;
  worktree?: SessionWorktree;
  /** Session setup state machine, owned by the main process and applied
   *  wholesale from `sessionStateChanged` events. */
  setup: SessionSetupState;
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
   * Onboarding wizard UI + selection context (Rookie). Bun remains the source
   * of truth for the agent session; this slice mirrors flow for HMR / recovery.
   */
  wizard: {
    /** True while OnboardingWizard is mounted. */
    active: boolean;
    currentModel?: string;
    /** Active wizard session id, if the agent has been started. */
    sessionId?: string;
    step: WizardStep;
    /** Current agentic phase, mirrored from Bun `wizard_phase` events. */
    phase: WizardPhaseId;
    selectedTemplateId?: string;
    description: string;
    progressLines: string[];
    envelope?: WizardAskEnvelope | null;
    pendingRequestId?: string | null;
    /** Pending agent-requested tool install (herman_request_install). */
    installRequest?: { requestId: string; envelope: WizardInstallEnvelope } | null;
    projectPath?: string | null;
    wizardError?: string | null;
    retryAttempt: number;
    retryMax: number;
    /**
     * When `"continue"`, show the recovery screen (Continue / Start over)
     * after a crash or cold start from a Bun checkpoint.
     */
    recoveryMode: false | "continue";
    /** True when Continue is unavailable (missing project / pi session). */
    recoveryBlocked?: boolean;
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
  updateTab: (id: TabId, partial: Partial<Omit<Tab, "id">>) => boolean;
  renameTab: (id: TabId, title: string) => void;
  setProjectForTab: (
    id: TabId,
    project: { folderPath: string; projectRoot?: string },
  ) => void;
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
  handleProjectOpened: (projectRoot: string, projects: string[]) => void;
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
  /** Apply an authoritative catalog snapshot pushed by the main process. */
  applyModelCatalog: (snapshot: ModelCatalogSnapshot) => void;
  setWizardCurrentModel: (modelId: string) => void;
  setWizardSessionId: (sessionId: string | undefined) => void;
  setWizardActive: (active: boolean) => void;
  setWizardStep: (step: WizardStep) => void;
  setWizardDescription: (description: string) => void;
  setWizardSelectedTemplateId: (templateId: string | undefined) => void;
  setWizardProgressLines: (lines: string[] | ((prev: string[]) => string[])) => void;
  setWizardEnvelope: (envelope: WizardAskEnvelope | null) => void;
  setWizardPendingRequestId: (requestId: string | null) => void;
  setWizardProjectPath: (projectPath: string | null) => void;
  setWizardError: (error: string | null) => void;
  setWizardRetry: (attempt: number, max?: number) => void;
  patchWizard: (partial: Partial<AgentState["wizard"]>) => void;
  hydrateWizardFromRecovery: (payload: {
    sessionId: string;
    templateId?: string;
    description?: string;
    progressLines?: string[];
    projectPath?: string | null;
    wizardError?: string | null;
    recoveryBlocked?: boolean;
    preferredModel?: string;
    phase?: WizardPhaseId;
  }) => void;
  /** Clear flow state but keep currentModel. Sets active=false. */
  clearWizardState: () => void;
  /** Soft deactivate on unmount without wiping flow (HMR-friendly). */
  deactivateWizard: () => void;
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
