/** Lifecycle phase for a single preview server process. */
export type PreviewPhase = "stopped" | "installing" | "starting" | "ready" | "failed";

/**
 * Complete snapshot of one preview server.
 * `previewStatusChanged` always carries a full snapshot so the renderer can
 * reduce one event atomically.
 */
export type PreviewServerSnapshot = {
  folderPath: string;
  serverId: string;
  phase: PreviewPhase;
  url?: string;
  port?: number;
  /** Present when phase === "failed". */
  error?: string;
};

/** Aggregate status for a folder's preview fleet (primary + siblings). */
export type PreviewFleetSnapshot = {
  folderPath: string;
  primaryServerId?: string;
  phase: PreviewPhase;
  servers: PreviewServerSnapshot[];
};

/** Filtered server log line forwarded to the renderer. */
export type PreviewLogEvent = {
  folderPath: string;
  serverId: string;
  source: "stdout" | "stderr";
  line: string;
  ts: number;
};

/** RPC response for startPreview / restartPreview. */
export type PreviewStartResponse = PreviewServerSnapshot & {
  /** True when install/spawn/readiness is still in progress. */
  starting: boolean;
};

export function isPreviewReady(snapshot: PreviewServerSnapshot): boolean {
  return snapshot.phase === "ready" && Boolean(snapshot.url) && snapshot.port != null;
}

export function isPreviewFailed(snapshot: PreviewServerSnapshot): boolean {
  return snapshot.phase === "failed" && Boolean(snapshot.error);
}

export function isPreviewStarting(snapshot: PreviewServerSnapshot): boolean {
  return snapshot.phase === "installing" || snapshot.phase === "starting";
}
