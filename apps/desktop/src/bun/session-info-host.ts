/**
 * Host-side handler for `herman_get_session_info` silent editor RPC.
 * Pure enough to unit-test without spinning AgentProcessManager.
 */

import type { AgentEvent } from "../shared/agent-protocol.js";
import { tryParseSessionInfoRequest } from "../shared/agent-protocol.js";
import type { PreviewFleetSnapshot } from "../shared/preview.js";
import type { SessionWorktree } from "../shared/rpc.js";
import {
  buildSessionInfoResponse,
  encodeSessionInfoResponse,
} from "../shared/session-info-protocol.js";

export type SessionInfoTabSnapshot = {
  folderPath?: string;
  projectRoot?: string;
  worktree?: SessionWorktree;
  mode?: "rookie" | "normal";
};

export type SessionInfoHostReply = {
  requestId: string;
  value: string;
};

/**
 * If `event` is a session-info editor request, build the silent
 * `extension_ui_response` value. Returns undefined for unrelated events.
 */
export function resolveSessionInfoHostReply(
  event: AgentEvent,
  tab: SessionInfoTabSnapshot,
  preview: PreviewFleetSnapshot,
): SessionInfoHostReply | undefined {
  const parsed = tryParseSessionInfoRequest(event);
  if (!parsed) return undefined;

  const response = buildSessionInfoResponse({
    projectPath: tab.folderPath,
    projectRoot: tab.projectRoot,
    worktree: tab.worktree,
    mode: tab.mode,
    preview,
  });

  return {
    requestId: parsed.requestId,
    value: encodeSessionInfoResponse(response),
  };
}
