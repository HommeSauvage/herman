/** Wire protocol for the Herman host bridge (desktop bun ↔ agent, HTTP JSON). */

export const HOST_BRIDGE_PROTOCOL_VERSION = 1;
export const HOST_BRIDGE_AUTH_SCHEME = "Bearer";

/** Route builders — both sides construct URLs through these, never by hand. */
export const HOST_BRIDGE_ROUTES = {
  health: "/v1/health",
  sessionInfo: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/session-info`,
  previewState: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/preview/state`,
  previewLogs: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/preview/logs`,
  browserGoto: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/browser/goto`,
  browserScreenshot: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/browser/screenshot`,
  browserAct: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/browser/act`,
  publishingConfig: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/publishing/config`,
} as const;

export type HostBridgeErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "tab_not_found"
  | "no_preview"
  | "browser_unavailable"
  | "no_publishing_config"
  | "internal";

export type HostBridgeErrorBody = { error: string; code: HostBridgeErrorCode };

/** Mirrors apps/desktop/src/shared/preview.ts PreviewPhase (kept as a literal
 *  union here because @herman/rpc must stay desktop-independent). */
export type HostBridgePreviewPhase = "stopped" | "installing" | "starting" | "ready" | "failed";

export type HostBridgePreviewServer = {
  serverId: string;
  phase: HostBridgePreviewPhase;
  url?: string;
  port?: number;
  error?: string;
};

/** GET /v1/tabs/:tabId/session-info — superset of the legacy sentinel payload
 *  (same fields minus the sentinel/version ceremony, plus currentUrl). */
export type HostBridgeSessionInfo = {
  version: 1;
  projectPath: string;
  projectRoot?: string;
  worktree?: { folderPath: string; mainFolderPath: string; branch: string; baseBranch?: string };
  mode?: "rookie" | "normal";
  preview: {
    phase: HostBridgePreviewPhase;
    primaryUrl?: string;
    servers: HostBridgePreviewServer[];
  };
  /** Page currently shown in the preview pane (post-navigation). */
  currentUrl?: string;
  error?: string;
};

/** GET /v1/tabs/:tabId/preview/state — compact structured state for the
 *  agent's per-turn prompt injection. */
export type HostBridgePreviewState = {
  version: 1;
  /** false when the tab is unknown / has no project. */
  available: boolean;
  phase: HostBridgePreviewPhase;
  primaryServerId?: string;
  primaryUrl?: string;
  port?: number;
  servers: HostBridgePreviewServer[];
  currentUrl?: string;
  /** Errors observed in the last RECENT_ERRORS_WINDOW_MS, per environment. */
  recentErrors: { server: number; console: number };
  /** First line of the failure when phase === "failed". */
  error?: string;
};

export type PreviewLogEnvironment = "console" | "server";

/** Query params for GET …/preview/logs (all optional except environment). */
export type PreviewLogsQuery = {
  environment: PreviewLogEnvironment;
  /** env=server only; defaults to the primary server. */
  serverId?: string;
  /** Tail size cap. Default 50, max 200. */
  maxEntries?: number;
  /** Lines of context around each detected error. Default 25, max 100. */
  maxLinesBeforeAfter?: number;
};

export type PreviewLogEntry = {
  ts: number;
  /** "stdout"|"stderr" for env=server; "console" for env=console. */
  source: "stdout" | "stderr" | "console";
  /** Console level (env=console only). */
  level?: "error" | "warn" | "info" | "log" | "debug";
  line: string;
  stack?: string;
  /** Page URL the console entry was logged on (env=console only). */
  url?: string;
  /** Line matched the server-error heuristic / console level === "error". */
  isError: boolean;
};

export type HostBridgePreviewLogs = {
  version: 1;
  environment: PreviewLogEnvironment;
  /** Resolved server id (env=server). */
  serverId?: string;
  phase: HostBridgePreviewPhase;
  /** Live server URL at answer time. */
  url?: string;
  currentUrl?: string;
  /** Pre-formatted, pre-truncated log text, ready to embed in a tool result. */
  text: string;
  entries: PreviewLogEntry[];
  /** Entries dropped by ring overflow / rate limiting since process start. */
  droppedEntries: number;
  truncated: boolean;
};

/** A console entry as captured by the preview webview preload and forwarded
 *  renderer → bun. Also the console ring element. */
export type PreviewConsoleEntry = {
  level: "error" | "warn" | "info" | "log" | "debug";
  message: string; // ≤ 2000 chars
  stack?: string; // ≤ 2000 chars
  url: string;
  ts: number;
};

/** Result of a headless browser navigation (load + settle). */
export type BrowserGotoResult = {
  ok: boolean;
  status?: number;
  url: string;
  pageErrors: string[];
  consoleErrors: string[];
};

/** One step in a headless browser interaction sequence. */
export type BrowserActionStep =
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; text: string }
  | { action: "press"; key: string }
  | { action: "scroll"; y: number };

/** POST /v1/tabs/:tabId/browser/goto — body: `{ url?: string; path?: string }`. */
export type HostBridgeBrowserGoto = BrowserGotoResult & { available: boolean };

/** GET /v1/tabs/:tabId/browser/screenshot */
export type HostBridgeBrowserScreenshot = {
  available: boolean;
  data?: string;
  mediaType?: "image/jpeg";
  url?: string;
};

/** POST /v1/tabs/:tabId/browser/act — body: `{ steps: BrowserActionStep[] }`. */
export type HostBridgeBrowserAct = {
  available: boolean;
  ok: boolean;
  error?: string;
  url?: string;
};

/** Mirrors apps/desktop/src/shared/publishing.ts PublishingStatus (kept as a
 *  literal union here because @herman/rpc must stay desktop-independent). */
export type HostBridgePublishingStatus =
  | "none"
  | "server_ready"
  | "coolify_installed"
  | "project_created"
  | "deployed";

/**
 * GET /v1/tabs/:tabId/publishing/config — the full publishing configuration
 * for the tab's project, INCLUDING the Coolify API token. The agent runs
 * locally as the user and needs the token to drive the Coolify CLI; the
 * desktop strips it only from renderer-facing views.
 */
export type HostBridgePublishingConfig = {
  version: 1;
  projectPath: string;
  serverIp?: string;
  sshKeyPath?: string;
  sshPublicKey?: string;
  coolifyUrl?: string;
  coolifyApiToken?: string;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyApplicationId?: string;
  domain?: string;
  status: HostBridgePublishingStatus;
  createdAt: number;
  updatedAt: number;
};

/**
 * POST /v1/tabs/:tabId/publishing/config — agent write-back after deploying.
 * Only deployment results are writable by the agent (connection fields are
 * owned by the Publishing screen). Field semantics: absent = unchanged,
 * null = clear, string = set. `status` can only advance in the pipeline.
 */
export type HostBridgePublishingUpdate = {
  coolifyProjectId?: string | null;
  coolifyProjectName?: string | null;
  coolifyApplicationId?: string | null;
  domain?: string | null;
  status?: HostBridgePublishingStatus;
};

/** Defaults shared by both sides (client fills them; host clamps them). */
export const PREVIEW_LOGS_DEFAULT_MAX_ENTRIES = 50;
export const PREVIEW_LOGS_MAX_ENTRIES = 200;
export const PREVIEW_LOGS_DEFAULT_CONTEXT = 25; // == ERROR_CONTEXT_LINES precedent
export const PREVIEW_LOGS_MAX_CONTEXT = 100;
export const PREVIEW_TOOL_TEXT_MAX_CHARS = 12_000; // matches preview-errors.ts MAX_FORMATTED_ERRORS_CHARS
export const RECENT_ERRORS_WINDOW_MS = 5 * 60_000;
