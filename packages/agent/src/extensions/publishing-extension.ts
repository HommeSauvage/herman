import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HostBridgePublishingStatus } from "@herman/rpc/host-bridge";

import { config } from "../env.js";
import {
  createHostBridgeClient,
  HostBridgeRequestError,
  HostBridgeUnavailableError,
} from "../host-bridge/client.js";
import { formatPublishingStateBlock } from "../prompts/publishing-state.js";

const UNAVAILABLE =
  "Publishing config is only available inside Herman Desktop. Tell the user you cannot access the publishing setup right now.";

const NO_CONFIG =
  "No publishing setup exists for this project yet. The user can create one from the Publishing screen in Herman (preview pane toolbar). Do NOT ask the user for a Coolify token or server credentials in chat — point them to the Publishing screen instead.";

const STATUS_VALUES: HostBridgePublishingStatus[] = [
  "none",
  "server_ready",
  "coolify_installed",
  "project_created",
  "deployed",
];

export default function publishingExtension(pi: ExtensionAPI) {
  const client = createHostBridgeClient();

  // ── Tool: herman_get_publishing_config ──
  pi.registerTool({
    name: "herman_get_publishing_config",
    label: "Get Publishing Config",
    description:
      "Fetch this project's publishing configuration from Herman Desktop: server IP, SSH key path, Coolify URL, and the Coolify API token (a secret — never print it in full to the user), plus any Coolify project/application IDs recorded from previous deploys. Call this BEFORE doing any Coolify work — the user already set this up in the Publishing screen, so never ask them for these credentials in chat.",
    promptSnippet: "Get server/Coolify connection details and API token for deploying this project",
    promptGuidelines: [
      "Always call herman_get_publishing_config before any Coolify deploy/ops work — the token and server details come from Herman, not from asking the user.",
      "The coolifyApiToken is a secret: use it in commands (e.g. coolify context add) but never repeat it back to the user in full.",
      "If the tool reports no config, direct the user to the Publishing screen instead of asking for credentials.",
    ],
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    } as never,

    async execute() {
      if (!client.isAvailable()) {
        return {
          content: [{ type: "text", text: UNAVAILABLE }],
          details: { error: "unavailable" },
        };
      }

      try {
        const publishingConfig = await client.getPublishingConfig(config.tabId);
        return {
          content: [{ type: "text", text: JSON.stringify(publishingConfig, null, 2) }],
          details: publishingConfig as unknown as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof HostBridgeUnavailableError) {
          return {
            content: [{ type: "text", text: UNAVAILABLE }],
            details: { error: "unavailable" },
          };
        }
        if (err instanceof HostBridgeRequestError) {
          const text =
            err.code === "no_publishing_config"
              ? NO_CONFIG
              : err.code === "tab_not_found"
                ? "No active project tab — cannot resolve the publishing config."
                : `Could not fetch the publishing config from Herman Desktop (${err.code}).`;
          return { content: [{ type: "text", text }], details: { error: err.code } };
        }
        return {
          content: [
            { type: "text", text: "Could not fetch the publishing config from Herman Desktop." },
          ],
          details: { error: "unknown" },
        };
      }
    },
  });

  // ── Tool: herman_update_publishing ──
  pi.registerTool({
    name: "herman_update_publishing",
    label: "Update Publishing State",
    description:
      "Report deployment results back to Herman so the Publishing screen stays accurate: the Coolify project ID/name and application ID after creating them, the domain once assigned, and the pipeline status ('project_created' after creating the app, 'deployed' once live). The status can only advance, never go backwards.",
    promptSnippet:
      "Record Coolify project/application IDs, domain, and deploy status back to Herman",
    promptGuidelines: [
      "Call herman_update_publishing immediately after creating Coolify resources (project, application) with their real UUIDs — never invent IDs.",
      "Set status 'deployed' only after the app is actually live and reachable on its domain.",
      "Use real values from `coolify ... list --format=json` output, never guesses.",
    ],
    parameters: {
      type: "object",
      properties: {
        coolifyProjectId: {
          type: "string",
          description: "Coolify project UUID (from coolify project list)",
        },
        coolifyProjectName: { type: "string", description: "Coolify project name" },
        coolifyApplicationId: {
          type: "string",
          description: "Coolify application UUID (from coolify app list)",
        },
        domain: {
          type: "string",
          description: "Domain assigned to the app (e.g. my-site.example.com)",
        },
        status: {
          type: "string",
          enum: STATUS_VALUES,
          description:
            "Pipeline status — can only advance: 'project_created' after creating the app, 'deployed' once live",
        },
      },
      required: [],
      additionalProperties: false,
    } as never,

    async execute(_toolCallId, rawParams) {
      if (!client.isAvailable()) {
        return {
          content: [{ type: "text", text: UNAVAILABLE }],
          details: { error: "unavailable" },
        };
      }

      const params = rawParams as Record<string, unknown>;
      const update: Record<string, unknown> = {};
      for (const key of [
        "coolifyProjectId",
        "coolifyProjectName",
        "coolifyApplicationId",
        "domain",
        "status",
      ]) {
        if (params[key] !== undefined) update[key] = params[key];
      }
      if (Object.keys(update).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Nothing to update — pass at least one field (coolifyProjectId, coolifyApplicationId, domain, status…).",
            },
          ],
          details: { error: "empty_update" },
        };
      }

      try {
        const result = await client.updatePublishingConfig(config.tabId, update);
        return {
          content: [
            { type: "text", text: `Publishing state recorded. Current status: ${result.status}.` },
          ],
          details: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof HostBridgeUnavailableError) {
          return {
            content: [{ type: "text", text: UNAVAILABLE }],
            details: { error: "unavailable" },
          };
        }
        if (err instanceof HostBridgeRequestError) {
          const text =
            err.code === "no_publishing_config"
              ? NO_CONFIG
              : `Could not record the publishing state (${err.code}: ${err.message}).`;
          return { content: [{ type: "text", text }], details: { error: err.code } };
        }
        return {
          content: [{ type: "text", text: "Could not record the publishing state." }],
          details: { error: "unknown" },
        };
      }
    },
  });

  // ── before_agent_start: inject publishing state block (rookie only) ──
  pi.on("before_agent_start", async (event) => {
    if (config.mode !== "rookie") return;
    if (!client.isAvailable()) return;

    try {
      const publishingConfig = await client.getPublishingConfig(config.tabId);
      const block = formatPublishingStateBlock(publishingConfig);
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    } catch {
      // No publishing config (or bridge hiccup) — skip silently.
      return;
    }
  });
}
