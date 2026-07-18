/**
 * Wire protocol for `herman_get_session_info`.
 *
 * Shared by:
 *  - the agent herman-extension which PRODUCES a request envelope via
 *    `ctx.ui.editor()` and CONSUMES the response JSON,
 *  - the bun AgentProcessManager which intercepts the `editor`
 *    extension_ui_request carrying the sentinel and replies silently
 *    (no UI) with live preview / project / worktree details.
 *
 * The on-the-wire format is JSON carried as the `prefill`/`value` string of a
 * pi `ctx.ui.editor()` dialog round-trip. The sentinel `__herman_session_info__`
 * lets the bridge distinguish this from a real editor request or a wizard ask.
 *
 * NOTE: the agent extension keeps its own inline copy of the request/response
 * shapes (it cannot import from herman desktop src at runtime). Keep them in sync.
 */

import type { PreviewFleetSnapshot, PreviewPhase } from "./preview.js";
import type { SessionWorktree } from "./rpc.js";

export const SESSION_INFO_SENTINEL = "__herman_session_info__" as const;
export const SESSION_INFO_PROTOCOL_VERSION = 1;

export type SessionInfoRequestEnvelope = {
  __herman_session_info__: true;
  version: 1;
};

export type SessionInfoPreviewServer = {
  serverId: string;
  phase: PreviewPhase;
  url?: string;
  port?: number;
  error?: string;
};

export type SessionInfoPreview = {
  phase: PreviewPhase;
  primaryUrl?: string;
  servers: SessionInfoPreviewServer[];
};

export type SessionInfoWorktree = {
  folderPath: string;
  mainFolderPath: string;
  branch: string;
  baseBranch?: string;
};

export type SessionInfoResponse = {
  __herman_session_info__: true;
  version: 1;
  projectPath: string;
  projectRoot?: string;
  worktree?: SessionInfoWorktree;
  mode?: "rookie" | "normal";
  preview: SessionInfoPreview;
  /** Present when the host could not gather session details. */
  error?: string;
};

export function encodeSessionInfoRequest(envelope: SessionInfoRequestEnvelope = {
  __herman_session_info__: true,
  version: SESSION_INFO_PROTOCOL_VERSION,
}): string {
  return JSON.stringify(envelope);
}

/** Detect + parse a session-info request from an `editor` request's prefill. */
export function tryParseSessionInfoRequestEnvelope(
  prefill: string | undefined,
): SessionInfoRequestEnvelope | undefined {
  if (!prefill) return undefined;
  const trimmed = prefill.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (obj.__herman_session_info__ !== true) return undefined;
    if (obj.version !== SESSION_INFO_PROTOCOL_VERSION) return undefined;
    return { __herman_session_info__: true, version: 1 };
  } catch {
    return undefined;
  }
}

export function encodeSessionInfoResponse(response: SessionInfoResponse): string {
  return JSON.stringify(response);
}

export function parseSessionInfoResponse(
  value: string | undefined,
): SessionInfoResponse | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (obj.__herman_session_info__ !== true) return undefined;
    if (obj.version !== SESSION_INFO_PROTOCOL_VERSION) return undefined;
    if (typeof obj.projectPath !== "string") return undefined;
    const preview = obj.preview;
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) return undefined;
    return obj as unknown as SessionInfoResponse;
  } catch {
    return undefined;
  }
}

export type BuildSessionInfoInput = {
  projectPath?: string;
  projectRoot?: string;
  worktree?: SessionWorktree;
  mode?: "rookie" | "normal";
  preview: PreviewFleetSnapshot;
  error?: string;
};

/** Build the host response payload from tab + preview manager state. */
export function buildSessionInfoResponse(input: BuildSessionInfoInput): SessionInfoResponse {
  const projectPath = input.projectPath ?? "";
  const primary =
    input.preview.servers.find((s) => s.serverId === input.preview.primaryServerId) ??
    input.preview.servers.find((s) => s.phase === "ready" && s.url) ??
    input.preview.servers[0];

  const response: SessionInfoResponse = {
    __herman_session_info__: true,
    version: 1,
    projectPath,
    preview: {
      phase: input.preview.phase,
      ...(primary?.url ? { primaryUrl: primary.url } : {}),
      servers: input.preview.servers.map((s) => ({
        serverId: s.serverId,
        phase: s.phase,
        ...(s.url ? { url: s.url } : {}),
        ...(s.port != null ? { port: s.port } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
    },
  };

  if (input.projectRoot) {
    response.projectRoot = input.projectRoot;
  }

  if (input.worktree && projectPath) {
    response.worktree = {
      folderPath: projectPath,
      mainFolderPath: input.worktree.mainFolderPath,
      branch: input.worktree.branch,
      ...(input.worktree.baseBranch ? { baseBranch: input.worktree.baseBranch } : {}),
    };
  }

  if (input.mode) {
    response.mode = input.mode;
  }

  if (input.error) {
    response.error = input.error;
  } else if (!projectPath) {
    response.error = "No project is open in this tab.";
  }

  return response;
}
