/** Lifecycle phase for a single preview server process. */
export type PreviewPhase = "stopped" | "starting" | "ready" | "failed";

// Type-only re-export so renderer code has one import site.
export type { PreviewConsoleEntry } from "@herman/rpc/host-bridge";

/**
 * Preview ownership scope: servers are owned per tab (`tab:<tabId>`), with
 * synthetic scopes for folder-only callers (wizard QA, manual folder starts).
 */
export type PreviewScope = string;

export function tabScope(tabId: string): PreviewScope {
  return `tab:${tabId}`;
}

export function folderScope(folderPath: string): PreviewScope {
  return `folder:${folderPath}`;
}

export function wizardScope(wizardId: string): PreviewScope {
  return `wizard:${wizardId}`;
}

/**
 * Complete snapshot of one preview server.
 * `previewStatusChanged` always carries a full snapshot so the renderer can
 * reduce one event atomically.
 */
export type PreviewServerSnapshot = {
  /** Owning scope (see {@link tabScope} / {@link folderScope} / {@link wizardScope}). */
  scope: PreviewScope;
  folderPath: string;
  serverId: string;
  phase: PreviewPhase;
  url?: string;
  port?: number;
  /** Present when phase === "failed". */
  error?: string;
};

/** Aggregate status for a scope's preview fleet (primary + siblings). */
export type PreviewFleetSnapshot = {
  scope: PreviewScope;
  folderPath: string;
  primaryServerId?: string;
  phase: PreviewPhase;
  servers: PreviewServerSnapshot[];
};

/** Filtered server log line forwarded to the renderer. */
export type PreviewLogEvent = {
  scope: PreviewScope;
  folderPath: string;
  serverId: string;
  source: "stdout" | "stderr";
  line: string;
  ts: number;
};

/** RPC response for startPreview / restartPreview. */
export type PreviewStartResponse = PreviewServerSnapshot & {
  /** True when spawn/readiness is still in progress. */
  starting: boolean;
};

export function isPreviewReady(snapshot: PreviewServerSnapshot): boolean {
  return snapshot.phase === "ready" && Boolean(snapshot.url) && snapshot.port != null;
}

export function isPreviewFailed(snapshot: PreviewServerSnapshot): boolean {
  return snapshot.phase === "failed" && Boolean(snapshot.error);
}

export function isPreviewStarting(snapshot: PreviewServerSnapshot): boolean {
  return snapshot.phase === "starting";
}

/** A single server log line captured by the preview context service. */
export type PreviewServerLogLine = {
  scope: PreviewScope;
  folderPath: string;
  serverId: string;
  source: "stdout" | "stderr";
  line: string;
  ts: number;
};

export const MAX_LOG_LINE_CHARS = 1000;
