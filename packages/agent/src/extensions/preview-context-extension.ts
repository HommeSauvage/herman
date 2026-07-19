import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { config } from "../env.js";
import {
  createHostBridgeClient,
  HostBridgeRequestError,
  HostBridgeUnavailableError,
} from "../host-bridge/client.js";
import { formatPreviewStateBlock } from "../prompts/preview-state.js";

const SESSION_INFO_UNAVAILABLE =
  "Session info is only available inside Herman Desktop. Do not invent a localhost port or URL — tell the user you cannot see the live preview right now.";

const SESSION_INFO_HOST_ERROR =
  "Could not fetch session info from Herman Desktop. Do not invent a localhost URL — tell the user you cannot see the live preview right now.";

const PREVIEW_LOGS_UNAVAILABLE =
  "Preview logs are only available inside Herman Desktop. Do not invent errors or log output — tell the user you cannot see the live preview logs right now.";

export default function previewContextExtension(pi: ExtensionAPI) {
  const client = createHostBridgeClient();

  // ── Tool: herman_get_session_info ──
  pi.registerTool({
    name: "herman_get_session_info",
    label: "Get Session Info",
    description:
      "Fetch the current Herman session's live project path, worktree, and preview URL/port from the desktop host. Call this before answering how to open or visit the site, or whenever you need the real localhost URL — preferred ports in herman.yaml/README may differ at runtime.",
    promptSnippet:
      "Get live preview URL, port, and project/worktree details for this Herman session",
    promptGuidelines: [
      "Call herman_get_session_info before giving the user any localhost link or telling them how to open the preview.",
      "Use the returned preview.primaryUrl (or a ready server url) — never invent ports from the manifest or docs.",
      "If preview is not ready or the tool returns an error, say so plainly; do not guess a URL.",
    ],
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    } as never,

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
      if (!client.isAvailable()) {
        return {
          content: [{ type: "text", text: SESSION_INFO_UNAVAILABLE }],
          details: { error: "unavailable" },
        };
      }

      try {
        const info = await client.getSessionInfo(config.tabId);
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
          details: info,
        };
      } catch (err) {
        if (err instanceof HostBridgeUnavailableError) {
          return {
            content: [{ type: "text", text: SESSION_INFO_UNAVAILABLE }],
            details: { error: "unavailable" },
          };
        }
        if (err instanceof HostBridgeRequestError) {
          return {
            content: [{ type: "text", text: `${SESSION_INFO_HOST_ERROR} (${err.code})` }],
            details: { error: err.code },
          };
        }
        return {
          content: [{ type: "text", text: SESSION_INFO_HOST_ERROR }],
          details: { error: "unknown" },
        };
      }
    },
  });

  // ── Tool: herman_get_preview_logs ──
  pi.registerTool({
    name: "herman_get_preview_logs",
    label: "Get Preview Logs",
    description:
      "Fetch recent logs from the running preview: the browser console in Herman's preview pane ('console') or the dev server's terminal output ('server'). Use when debugging the site, when the user reports something broken or blank, or to check what the running preview is doing.",
    promptSnippet: "Get recent browser console or dev server logs from the live preview",
    promptGuidelines: [
      "When investigating a broken or misbehaving page, call herman_get_preview_logs with environment 'server' and 'console' before asking the user for details — never ask the user to copy errors.",
      "Prefer this over re-running the dev server yourself; the preview is already running.",
      "If the tool reports unavailability, say you can't see the preview logs right now — do not invent errors or URLs.",
    ],
    parameters: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          enum: ["console", "server"],
          description:
            "'console' = browser console of the preview pane; 'server' = dev server terminal output",
        },
        maxLinesBeforeAfter: {
          type: "number",
          description: "Context lines around each error (default 25)",
        },
        maxEntries: {
          type: "number",
          description: "Max log lines/entries to return (default 50)",
        },
        serverId: {
          type: "string",
          description: "Preview server id (env=server only; defaults to the primary server)",
        },
      },
      required: ["environment"],
      additionalProperties: false,
    } as never,

    async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx: ExtensionContext) {
      const params = rawParams as Record<string, unknown>;
      if (!client.isAvailable()) {
        return {
          content: [{ type: "text", text: PREVIEW_LOGS_UNAVAILABLE }],
          details: { error: "unavailable" },
        };
      }

      try {
        const query = {
          environment: params.environment as "console" | "server",
          ...(params.serverId ? { serverId: params.serverId as string } : {}),
          ...(params.maxEntries != null ? { maxEntries: params.maxEntries as number } : {}),
          ...(params.maxLinesBeforeAfter != null
            ? { maxLinesBeforeAfter: params.maxLinesBeforeAfter as number }
            : {}),
        };

        const result = await client.getPreviewLogs(config.tabId, query);

        const phaseLabel =
          result.phase === "ready"
            ? "ready"
            : result.phase === "failed"
              ? "failed"
              : result.phase === "starting"
                ? "starting"
                : result.phase === "installing"
                  ? "installing"
                  : "not running";
        let header = `Preview: ${phaseLabel}`;
        if (result.url) header += ` — ${result.url}`;
        if (result.currentUrl && result.currentUrl !== result.url)
          header += ` · viewing ${result.currentUrl}`;

        // Service already includes the dropped-entries footer in result.text.
        const text = `${header}\n\n${result.text}`;

        return {
          content: [{ type: "text", text }],
          details: result,
        };
      } catch (err) {
        if (err instanceof HostBridgeUnavailableError) {
          return {
            content: [{ type: "text", text: PREVIEW_LOGS_UNAVAILABLE }],
            details: { error: "unavailable" },
          };
        }
        if (err instanceof HostBridgeRequestError) {
          const unavailableText =
            err.code === "tab_not_found"
              ? "No preview tab is active. Open a project to see preview logs."
              : `Could not fetch preview logs from Herman Desktop (${err.code}). Do not invent errors or log output.`;
          return {
            content: [{ type: "text", text: unavailableText }],
            details: { error: err.code },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "Could not fetch preview logs from Herman Desktop. Do not invent errors or log output.",
            },
          ],
          details: { error: "unknown" },
        };
      }
    },
  });

  // ── before_agent_start: inject preview state block (rookie only) ──
  pi.on("before_agent_start", async (event, _ctx) => {
    if (config.mode !== "rookie") return;
    if (!client.isAvailable()) return;

    try {
      const state = await client.getPreviewState(config.tabId);
      if (!state.available) return;

      const block = formatPreviewStateBlock(state);
      if (!block) return;

      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    } catch {
      // Silently skip on any error.
      return;
    }
  });
}
