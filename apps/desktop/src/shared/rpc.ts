import { type RPCSchema } from "electrobun/bun";
import type { PreviewConsoleEntry } from "@herman/rpc/host-bridge";

import type {
  AgentCommand,
  AgentEvent,
  AgentResponse,
  AdCampaign,
  AdPlacement,
  WizardSessionEvent,
} from "./agent-protocol.js";
import type {
  GalleryTemplate,
  ProjectManifestView,
  RequirementCheckResult,
  ResolvedManifest,
} from "./herman-manifest.js";
import type {
  ToolchainEvent,
  ToolchainToolStatus,
  ToolInstallItem,
} from "./tool-registry.js";
import type {
  PreviewFleetSnapshot,
  PreviewLogEvent,
  PreviewServerSnapshot,
  PreviewStartResponse,
} from "./preview.js";
import type { WizardAskEnvelope } from "./wizard-protocol.js";

import type { ModelCatalogSnapshot, ModelMetadata } from "./model-selection.js";

export type { ModelCatalogSnapshot, ModelMetadata } from "./model-selection.js";

export type {
  PreviewFleetSnapshot,
  PreviewLogEvent,
  PreviewPhase,
  PreviewServerSnapshot,
  PreviewStartResponse,
} from "./preview.js";

/** Recovery payload for an interrupted Rookie wizard (cold start or HMR). */
export type WizardRecoveryPayload = {
  sessionId: string;
  /** True when the Bun process still has a running bridge (soft reload). */
  live: boolean;
  /** False when Continue is unavailable (missing project / pi session). */
  resumable: boolean;
  blockedReason?: string;
  templateId?: string;
  description?: string;
  preferredModel?: string;
  phase?: "planning" | "coding" | "qa" | "docs";
  projectPath?: string;
  progressLines: string[];
  lastError?: string;
  finished?: boolean;
  /** Soft-reload UI hint when `live` is true. */
  uiStep?: "working" | "questions" | "error" | "retrying" | "recovery";
  pendingRequestId?: string;
  envelope?: WizardAskEnvelope;
  retryAttempt?: number;
};

/** One doc file from <project>/herman-docs/, for the Rookie docs browser. */
export type ProjectDoc = {
  /** File name inside herman-docs/ (e.g. "01-start-here.md"). */
  fileName: string;
  /** First H1 heading (fallback: humanized file name). */
  title: string;
  /** Raw markdown. */
  content: string;
};

export type AuthMethodType = "oauth" | "apiKey";

export type AuthPrompt =
  | { type: "text"; key: string; label: string; placeholder?: string }
  | { type: "secret"; key: string; label: string; placeholder?: string }
  | {
      type: "select";
      key: string;
      label: string;
      options: { value: string; label: string }[];
    };

export type AuthMethod = {
  type: AuthMethodType;
  label: string;
  prompts?: AuthPrompt[];
};

export type ProviderSource = "builtin" | "custom" | "herman";

export type ProviderMetadata = {
  id: string;
  name: string;
  icon?: string;
  authMethods: AuthMethod[];
  isHerman?: boolean;
  source: ProviderSource;
};

export type ApiKeyCredential = {
  type: "apiKey";
  key: string;
  metadata?: Record<string, string>;
};

export type OAuthCredential = {
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

export type ProviderSettings = {
  enabled: boolean;
  authMethod?: AuthMethodType;
  options?: Record<string, string>;
};

export type HermanProviderSettings = {
  enabled: boolean;
  serverUrl?: string;
};

export type AppMode = "rookie" | "normal";

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "herman" | "user" | "project";
  /** Whether the skill is currently disabled (excluded from agent prompts). */
  disabled?: boolean;
};

export type SkillSearchResult = {
  package: string;
  installs: string;
  url: string;
};

export type PromptTemplateInfo = {
  /** Template name (filename without .md). */
  name: string;
  /** Short description from frontmatter or first line. */
  description: string;
  /** Argument hint from frontmatter (e.g. "<file>"). */
  argumentHint?: string;
  /** Absolute path to the .md file. */
  filePath: string;
  /** Where the template came from. */
  source: "global" | "project";
};

export type DesktopSettings = {
  providers: {
    herman: HermanProviderSettings;
    custom: Record<string, ProviderSettings | undefined>;
  };
  models: {
    /**
     * @deprecated Migrated to `lastUsedModel` on load. Kept for
     * back-compat with older settings files.
     */
    defaultModel?: string;
    /**
     * The last model the user explicitly selected in any tab. Seeds the
     * model of fresh tabs. Written only by the main process.
     */
    lastUsedModel?: string;
    hiddenModels?: string[];
  };
  mode?: AppMode;
  settingsActiveTab?: "providers" | "models" | "general" | "skills" | "tools";
  /** Transient error from the credential store; not persisted to disk. */
  credentialStoreError?: string;
  /** Skill names that should not be sent to the agent. */
  disabledSkills?: string[];
};

export type SessionUser = {
  id: string;
  email?: string;
};

export type Session = {
  token: string;
  user?: SessionUser;
};

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type OAuthLoginStatus =
  | { status: "pending" }
  | { status: "authorized"; credential: OAuthCredential }
  | { status: "error"; error: string };

export type DeviceTokenResponse = {
  status: "pending" | "authorized" | "expired" | "error" | "unauthorized";
  accessToken?: string;
  error?: string;
};

export type AgentStatus = {
  state: "idle" | "starting" | "running" | "crashed";
  stderr?: string;
};

export type TabId = string;

export type SessionWorktree = {
  branch: string;
  baseBranch: string;
  mainFolderPath: string;
};

/** How a session's workspace is isolated. Fixed at creation and persisted. */
export type SessionIsolation = "worktree" | "direct";

export type SessionSetupStepStatus =
  | "pending"
  | "running"
  | "done"
  | "warning"
  | "failed"
  | "skipped";

export type SessionSetupStepSnapshot = {
  id: string;
  label: string;
  status: SessionSetupStepStatus;
};

/**
 * Explicit session setup state machine, owned by the main-process session
 * bootstrapper and pushed to the renderer via `sessionStateChanged`.
 */
export type SessionSetupState =
  | { phase: "none" } // normal-mode, non-git, or direct-on-main by policy
  | { phase: "pending"; step?: string; label?: string; steps?: SessionSetupStepSnapshot[] }
  | { phase: "ready" }
  | { phase: "error"; step?: string; error: string; retryable: boolean; output?: string };

export type QueuedFollowUp = {
  id: string;
  text: string;
};

/** A file the user picked from the native file dialog or pasted from the
 *  clipboard.  We keep the absolute path so the agent can be sent a stable
 *  reference to the file via the prompt text.  An optional previewDataUrl is
 *  included for small image attachments so the renderer can show a
 *  thumbnail without having to read the file again. */
export type PickedFile = {
  path: string;
  name: string;
  size: number;
  mime: string;
  /** Base64 data URL (data:image/...) for image previews; only set for
   *  small image files.  Undefined for other file types. */
  previewDataUrl?: string;
};

export type OpenFilePickerOptions = {
  multiple?: boolean;
  title?: string;
  /** Absolute path of the folder the dialog should open in. */
  defaultPath?: string;
};

export type PendingAttachment = PickedFile & {
  /** Stable client-side id used to key React lists and identify attachments
   *  for removal.  Independent from the file path so the same file can be
   *  attached twice (e.g. in different turns) without collisions. */
  id: string;
  /** Unix timestamp (ms) when the attachment was added. */
  addedAt: number;
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type Message =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      isStreaming?: boolean;
      stopReason?: string;
      errorMessage?: string;
      model?: string;
      provider?: string;
      usage?: Usage;
    }
  | {
      id: string;
      role: "tool";
      toolName: string;
      toolCallId: string;
      status: "running" | "done" | "error";
      output?: string;
      args?: unknown;
    }
  | {
      id: string;
      role: "thinking";
      content: string;
      isStreaming?: boolean;
      parentId?: string;
    };

export type PersistedSession = {
  id: TabId;
  title: string;
  folderPath: string;
  /** Stable project identity: git root if the folder is in a repo, otherwise folderPath. */
  projectRoot: string;
  projectColor: string;
  /** Latest PI session UUID observed for this tab. */
  piSessionId?: string;
  worktree?: SessionWorktree;
  /** Isolation policy fixed at creation. Undefined (legacy) means "direct". */
  isolation?: SessionIsolation;
  /** When the workspace setup runner last completed successfully. */
  setupCompletedAt?: number;
  /** Hash of the setup plan that was last applied (manifest changes invalidate). */
  setupPlanHash?: string;
  /** User explicitly stopped the preview; auto-start stays off until a manual start. */
  previewManuallyStopped?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Revert point: messages at or after this ID are considered reverted. */
  revertMessageId?: string;
  /** Model the user last selected for this session. Restored on reopen. */
  currentModel?: string;
};

/** A browseable pi session (from pi session JSONL headers), for the home screen. */
export type PiSessionSummary = {
  /** Pi session UUID (the `{timestamp}_{uuid}.jsonl` suffix). */
  id: string;
  /** Absolute project folder the session was started in. */
  cwd: string;
  /** User-defined display name, if any. */
  name?: string;
  created: number;
  modified: number;
  messageCount: number;
  firstMessage: string;
};

/** Aggregated token / context / cost statistics for a tab. */
export type ContextStats = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  contextLimit: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  modelId?: string;
  providerId?: string;
  updatedAt: number;
  /**
   * True when the agent reported the context is unknown (post-compaction,
   * before next LLM response). The desktop should render a "?" in the
   * gauge. Only meaningful when the agent sends `herman/context_report`.
   */
  isCompacted?: boolean;
  /** Running output estimate for the in-flight assistant turn. */
  currentTurnOutput?: number;
  /** True while the agent is mid-turn (between `agent_start` and `agent_end`). */
  isStreaming?: boolean;
};

/** A single file's diff information, used by the changes panel. */
export type FileDiff = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string;
};

export type DiffScope = "last-message" | "everything" | "working-tree";

/** Result of fetching conversation history from the agent on tab resume. */
export type TabMessageHydrationStatus = "pending" | "success" | "empty" | "failed";

export type TabMessagesHydrated = {
  tabId: TabId;
  status: TabMessageHydrationStatus;
  messages: Message[];
  contextStats?: ContextStats;
  error?: string;
};

export type Tab = {
  id: TabId;
  title: string;
  folderPath: string;
  /** Stable project identity: git root if the folder is in a repo, otherwise folderPath. */
  projectRoot: string;
  projectColor: string;
  worktree?: SessionWorktree;
  /** Session setup state machine (worktree provisioning + manifest setup steps).
   *  Owned by the main process; the renderer only renders it. */
  setup: SessionSetupState;
  messages: Message[];
  isThinking: boolean;
  currentModel?: string;
  availableModels: string[];
  connectionState: AgentStatus["state"];
  connectionError?: string;
  connectionStderr?: string;
  createdAt: number;
  updatedAt: number;
  composerValue: string;
  queuedMessages: QueuedFollowUp[];
  /** Files attached to the next prompt in the composer.  Optional on the
   *  wire (older sessions predate this field) and ephemeral — the renderer
   *  clears it on submission so the main process never has to reason
   *  about it. */
  pendingAttachments?: PendingAttachment[];
  selectedMessageId?: string;
  /** If set, all messages with id >= revertMessageId are considered reverted (hidden). */
  revertMessageId?: string;
  /** Diff summary shown in the revert dock (populated by file-level rewind). */
  revertDiffSummary?: string;
  /** Git checkpoint id captured immediately before file restore; used to undo file changes on cancel. */
  revertSafetyCheckpointId?: string;
  /** Estimated token / context / cost statistics for the session. */
  contextStats?: ContextStats;
  /** Whether to render the model's thinking process in the message list. */
  showThinking: boolean;
  /** Thinking messages buffered for the current/visible session. */
  thinkingMessages: Message[];
};

export type OutgoingMessages = {
  sessionChanged: Session | undefined;
  updateStatus: { status: string; message: string };
  tabsRestored: {
    tabs: Tab[];
    activeTabId?: TabId;
    projects: string[];
    sessions: PersistedSession[];
  };
  tabCreated: { tab: Tab };
  tabMessagesHydrated: TabMessagesHydrated;
  tabClosed: { tabId: TabId };
  tabActivated: { tabId: TabId };
  /** Authoritative session setup/folder push from the session bootstrapper. */
  sessionStateChanged: {
    tabId: TabId;
    setup: SessionSetupState;
    folderPath?: string;
    projectRoot?: string;
    worktree?: SessionWorktree;
  };
  projectsChanged: { projects: string[] };
  sessionsChanged: { sessions: PersistedSession[] };
  projectOpened: { folderPath: string; projectRoot: string; projects: string[] };
  agentEvent: { tabId: TabId; event: AgentEvent };
  wizardEvent: { event: WizardSessionEvent };
  toolchainEvent: { event: ToolchainEvent };
  agentStatusChanged: { tabId: TabId; state: AgentStatus["state"]; stderr?: string };
  adEvent: { tabId: TabId; placement: AdPlacement; campaign: AdCampaign };
  adVisibilityChanged: { focused: boolean; visible: boolean };
  activationComplete: Session;
  /** Authoritative model catalog push (seeded on startup via getModelCatalog). */
  modelCatalogChanged: ModelCatalogSnapshot;
  /** A tab's desired model changed (user selection or agent reconciliation). */
  tabModelChanged: { tabId: TabId; currentModel?: string };
  /** Settings were mutated by the main process (e.g. lastUsedModel recorded). */
  settingsChanged: DesktopSettings;
  /** Complete snapshot — renderer reduces one event atomically. */
  previewStatusChanged: PreviewServerSnapshot;
  previewLog: PreviewLogEvent;
};

export type HermanDesktopRPC = {
  bun: RPCSchema<{
    requests: {
      startDeviceActivation: {
        params: undefined;
        response: DeviceCodeResponse;
      };
      checkDeviceActivation: {
        params: { deviceCode: string };
        response: DeviceTokenResponse;
      };
      getSession: {
        params: undefined;
        response: Session | undefined;
      };
      signOut: {
        params: undefined;
        response: undefined;
      };
      copyToClipboard: {
        params: { text: string };
        response: undefined;
      };
      openExternal: {
        params: { url: string };
        response: undefined;
      };
      getVersion: {
        params: undefined;
        response: { version: string; hash: string; channel: string };
      };
      getDevMode: {
        params: undefined;
        response: boolean;
      };
      checkForUpdate: {
        params: undefined;
        response: {
          updateAvailable: boolean;
          version: string;
          error: string;
        };
      };
      downloadUpdate: {
        params: undefined;
        response: undefined;
      };
      applyUpdate: {
        params: undefined;
        response: undefined;
      };
      createTab: {
        params: { folderPath?: string; title?: string };
        response: Tab;
      };
      closeTab: {
        params: { tabId: TabId };
        response: undefined;
      };
      activateTab: {
        params: { tabId: TabId };
        response: undefined;
      };
      setTabFolder: {
        params: { tabId: TabId; folderPath?: string };
        response: { folderPath?: string; projectRoot?: string };
      };
      selectTabProject: {
        params: { tabId: TabId; folderPath: string };
        response: { folderPath: string };
      };
      getTabs: {
        params: undefined;
        response: { tabs: Tab[]; activeTabId?: TabId };
      };
      getProjectsAndSessions: {
        params: undefined;
        response: { projects: string[]; sessions: PersistedSession[] };
      };
      /** List real pi sessions for a project folder (native pi SessionManager.list). */
      getProjectSessions: {
        params: { folderPath: string };
        response: { sessions: PiSessionSummary[] };
      };
      /** List every pi session across all projects + the derived project list. */
      getAllPiSessions: {
        params: undefined;
        response: { projects: string[]; sessions: PiSessionSummary[] };
      };
      openProject: {
        params: { folderPath?: string };
        response: { folderPath?: string; projectRoot?: string };
      };
      closeProject: {
        params: { folderPath: string };
        response: undefined;
      };
      openSession: {
        params: { sessionId: TabId };
        response: Tab | undefined;
      };
      /** Open a native pi session (by UUID) as a new tab, resuming that conversation. */
      openPiSession: {
        params: { folderPath: string; piSessionId: string };
        response: Tab;
      };
      retryTabMessageHydration: {
        params: { tabId: TabId };
        response: TabMessagesHydrated;
      };
      setComposerDraft: {
        params: { tabId: TabId; value: string };
        response: undefined;
      };
      findProjectFiles: {
        params: { folderPath: string; query: string; includeDirectories?: boolean };
        response: { paths: string[] };
      };
      openFilePicker: {
        params: OpenFilePickerOptions;
        response: { files: PickedFile[] };
      };
      agentRequest: {
        params: { tabId: TabId; command: AgentCommand };
        response: AgentResponse;
      };
      abortAgent: {
        params: { tabId: TabId };
        response: undefined;
      };
      restartAgent: {
        params: { tabId: TabId };
        response: undefined;
      };
      revertTab: {
        params: { tabId: TabId; messageIndex: number };
        response: { tab: Tab; diffSummary?: string };
      };
      unrevertTab: {
        params: { tabId: TabId };
        response: { tab: Tab };
      };
      commitRevertTab: {
        params: { tabId: TabId; messageIndex: number };
        response: { tab: Tab };
      };
      previewRevertTab: {
        params: { tabId: TabId; messageIndex: number };
        response: { diffSummary?: string; messageCount: number };
      };
      getDiff: {
        params: { tabId: TabId; scope: DiffScope };
        response: { diffs: FileDiff[] };
      },
      getAgentStatus: {
        params: { tabId: TabId };
        response: AgentStatus;
      };
      getRecentAgentEvents: {
        params: { tabId: TabId };
        response: AgentEvent[];
      };
      reportImpression: {
        params: {
          campaignId: string;
          placement: AdPlacement;
          durationMs: number;
          wasFocused: boolean;
          wasVisible: boolean;
          thinkingDurationMs?: number;
        };
        response: undefined;
      };
      reportAdClick: {
        params: { campaignId: string; placement: AdPlacement };
        response: { destinationUrl?: string };
      };
      getSettings: {
        params: undefined;
        response: DesktopSettings;
      };
      saveSettings: {
        params: { settings: DesktopSettings };
        response: undefined;
      };
      getProviderCredentials: {
        params: { providerId: string };
        response: ProviderCredential | undefined;
      };
      saveProviderCredentials: {
        params: { providerId: string; credential: ProviderCredential; skipRefresh?: boolean };
        response: undefined;
      };
      removeProviderCredentials: {
        params: { providerId: string; skipRefresh?: boolean };
        response: undefined;
      };
      startOAuthLogin: {
        params: { providerId: string };
        response: { authUrl: string; state: string };
      };
      pollOAuthLogin: {
        params: { providerId: string; state: string };
        response: OAuthLoginStatus;
      };
      cancelOAuthLogin: {
        params: { providerId: string };
        response: undefined;
      };
      getAvailableProviders: {
        params: undefined;
        response: ProviderMetadata[];
      };
      /**
       * Current model catalog (herman + custom), seeded from the disk cache
       * at startup and refreshed from the server in the background.
       */
      getModelCatalog: {
        params: undefined;
        response: ModelCatalogSnapshot;
      };
      /**
       * Force a refresh of the Herman model list from the server. Never
       * wipes the cached catalog on failure — safe to call offline.
       */
      refreshModelCatalog: {
        params: undefined;
        response: ModelCatalogSnapshot;
      };
      /**
       * Select the model for a tab. Persists the selection for the session
       * (survives restarts and agent crashes), records it as the global
       * last-used model, and applies it to the agent — immediately when the
       * agent's registry is ready, otherwise as soon as it becomes ready.
       */
      setTabModel: {
        params: { tabId: TabId; modelId: string };
        response: { ok: boolean; model?: string; applied: boolean; error?: string };
      };
      /**
       * Record an explicit model selection not tied to a tab (e.g. the
       * wizard's pre-start picker) as the global last-used model.
       */
      setLastUsedModel: {
        params: { modelId: string };
        response: undefined;
      };
      getGalleryTemplates: {
        params: undefined;
        response: GalleryTemplate[];
      };
      /** @deprecated Use getGalleryTemplates */
      getTemplates: {
        params: undefined;
        response: GalleryTemplate[];
      };
      resolveTemplateManifest: {
        params: { templateId: string };
        response: ResolvedManifest;
      };
      checkTemplateRequirements: {
        params: { templateId: string };
        response: { results: RequirementCheckResult[] };
      };
      /** Requirements of an already-created project (herman.yaml / HERMAN.md). */
      checkProjectRequirements: {
        params: { folderPath: string };
        response: { results: RequirementCheckResult[] };
      };
      /** Detection status of every curated tool + the platform's tier-0 ids. */
      getToolchainStatus: {
        params: undefined;
        response: { tools: ToolchainToolStatus[]; required: string[] };
      };
      /**
       * Start an install run (single-flight). Progress streams back as
       * `toolchainEvent` messages tagged with `runId`; completion is the
       * `all-done` event, not this response.
       */
      installTools: {
        params: { runId: string; items: ToolInstallItem[] };
        response: { accepted: boolean; reason?: string };
      };
      /** Approve/decline an agent-requested tool install in the wizard. */
      respondWizardInstall: {
        params: { wizardSessionId: string; requestId: string; approved: boolean };
        response: undefined;
      };
      startWizardSession: {
        params: { templateId: string; description: string; modelId?: string };
        response: { wizardSessionId: string };
      };
      setWizardModel: {
        params: { wizardSessionId: string; modelId: string };
        response: undefined;
      };
      resumeWizardSession: {
        params: { wizardSessionId: string };
        response: undefined;
      };
      getWizardRecovery: {
        params: undefined;
        response: WizardRecoveryPayload | null;
      };
      discardWizardRecovery: {
        params: undefined;
        response: undefined;
      };
      respondWizardQuestions: {
        params: {
          wizardSessionId: string;
          requestId: string;
          answers: { id: string; value: string; values?: string[] }[];
        };
        response: undefined;
      };
      cancelWizard: {
        params: { wizardSessionId: string };
        response: undefined;
      };
      adoptWizardSession: {
        params: { projectPath: string; wizardSessionId: string };
        response: Tab;
      };
      getProjectDocs: {
        params: { projectPath: string };
        response: { docs: ProjectDoc[] };
      };
      getSessionChanges: {
        params: { tabId: TabId };
        response: { isWorktree: boolean; changedFiles: number; canApply: boolean };
      };
      applySession: {
        params: { tabId: TabId };
        response: { status: "applied" | "resolving" | "error"; error?: string };
      };
      discardSession: {
        params: { tabId: TabId };
        response: undefined;
      };
      /** Re-run the workspace setup pipeline for a tab after a setup failure. */
      retrySessionSetup: {
        params: { tabId: TabId };
        response: { ok: boolean; error?: string };
      };
      focusWindow: {
        params: undefined;
        response: undefined;
      };
      showNativeNotification: {
        params: { title: string; body?: string; subtitle?: string; tabId: TabId };
        response: undefined;
      };
      /**
       * Start preview servers for a scope. Pass `tabId` for session-owned
       * previews (preferred); `folderPath` is the folder scope used by callers
       * without a tab (e.g. the wizard).
       */
      startPreview: {
        params: {
          tabId?: TabId;
          folderPath?: string;
          serverId?: string;
          devCommand?: string;
          devPort?: number;
          /** When true (default for HERMAN.md projects), start all configured servers. */
          all?: boolean;
        };
        response: PreviewStartResponse;
      };
      stopPreview: {
        params: { tabId?: TabId; folderPath?: string; serverId?: string };
        response: undefined;
      };
      restartPreview: {
        params: {
          tabId?: TabId;
          folderPath?: string;
          serverId?: string;
          devCommand?: string;
          devPort?: number;
          all?: boolean;
        };
        response: PreviewStartResponse;
      };
      getPreviewStatus: {
        params: { tabId?: TabId; folderPath?: string; serverId?: string };
        response: PreviewFleetSnapshot;
      };
      getProjectManifest: {
        params: { folderPath: string; projectRoot?: string };
        response: ProjectManifestView | undefined;
      };
      getSkills: {
        params: { projectDir?: string };
        response: { skills: SkillInfo[] };
      };
      getPromptTemplates: {
        params: { projectDir?: string };
        response: { templates: PromptTemplateInfo[] };
      };
      installSkill: {
        params: { name: string; content: string };
        response: { path: string };
      };
      searchSkills: {
        params: { query: string };
        response: { results: SkillSearchResult[] };
      };
      installSkillFromCommand: {
        params: { command: string };
        response: { path: string; name: string };
      };
      removeSkill: {
        params: { name: string };
        response: undefined;
      };
      setSkillEnabled: {
        params: { name: string; enabled: boolean };
        response: undefined;
      };
    };
    messages: {
      requestActivation: undefined;
      cancelActivation: undefined;
      copyUserCode: undefined;
      openVerificationUrl: undefined;
      signOut: undefined;
      checkForUpdate: undefined;
      downloadUpdate: undefined;
      applyUpdate: undefined;
      openProject: undefined;
      previewConsoleBatch: { tabId: TabId; folderPath: string; entries: PreviewConsoleEntry[]; dropped: number };
      previewNavigated: { tabId: TabId; folderPath: string; url: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<never, never>;
    messages: OutgoingMessages;
  }>;
};

/** Renderer-facing RPC shape derived from the full HermanDesktopRPC schema.
 *  This keeps the browser mock and the electrobun implementation aligned. */
export type DesktopRpc = {
  request: {
    [K in keyof HermanDesktopRPC["bun"]["requests"]]: (
      ...args: HermanDesktopRPC["bun"]["requests"][K]["params"] extends undefined
        ? []
        : [HermanDesktopRPC["bun"]["requests"][K]["params"]]
    ) => Promise<HermanDesktopRPC["bun"]["requests"][K]["response"]>;
  };
  addMessageListener: <K extends keyof HermanDesktopRPC["webview"]["messages"]>(
    name: K,
    handler: (payload: HermanDesktopRPC["webview"]["messages"][K]) => void,
  ) => void;
  removeMessageListener: <K extends keyof HermanDesktopRPC["webview"]["messages"]>(
    name: K,
    handler: (payload: HermanDesktopRPC["webview"]["messages"][K]) => void,
  ) => void;
  send: {
    [K in keyof HermanDesktopRPC["bun"]["messages"]]:
      HermanDesktopRPC["bun"]["messages"][K] extends undefined
        ? () => void
        : (payload: HermanDesktopRPC["bun"]["messages"][K]) => void;
  };
};
