import {
  HOST_BRIDGE_ROUTES,
  type HostBridgePublishingConfig,
  type HostBridgePublishingUpdate,
} from "@herman/rpc/host-bridge";
import { applyAgentPublishingUpdate, getPublishingConfig } from "../../publishing/store.js";
import type { PublishingConfig } from "../../publishing/types.js";
import { HostBridgeError, type HostBridgeRoute } from "../server.js";

export type PublishingRoutesDeps = {
  /** Resolve a tab to the project root its publishing config is scoped to. */
  getProjectRootForTab(tabId: string): string | undefined;
};

function toWire(config: PublishingConfig): HostBridgePublishingConfig {
  return {
    version: 1,
    projectPath: config.projectPath,
    serverIp: config.serverIp,
    sshKeyPath: config.sshKeyPath,
    sshPublicKey: config.sshPublicKey,
    coolifyUrl: config.coolifyUrl,
    coolifyApiToken: config.coolifyApiToken,
    coolifyProjectId: config.coolifyProjectId,
    coolifyProjectName: config.coolifyProjectName,
    coolifyApplicationId: config.coolifyApplicationId,
    domain: config.domain,
    status: config.status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function requireProjectRoot(deps: PublishingRoutesDeps, tabId: string): string {
  const projectRoot = deps.getProjectRootForTab(tabId);
  if (!projectRoot) {
    throw new HostBridgeError(404, "tab_not_found", "Unknown tab or tab has no project");
  }
  return projectRoot;
}

/**
 * Agent-facing publishing routes. The agent reads the full config (including
 * the API token — it acts locally on the user's behalf and needs it to drive
 * the Coolify CLI) and writes back deployment results (project/application
 * IDs, domain, pipeline status).
 */
export function publishingRoutes(deps: PublishingRoutesDeps): HostBridgeRoute[] {
  return [
    {
      method: "GET",
      pattern: HOST_BRIDGE_ROUTES.publishingConfig(":tabId"),
      handler: async ({ params }: { params: Record<string, string> }) => {
        const projectRoot = requireProjectRoot(deps, params.tabId as string);
        const config = await getPublishingConfig(projectRoot);
        if (!config) {
          throw new HostBridgeError(
            404,
            "no_publishing_config",
            "No publishing setup for this project yet — the user can create one from the Publishing screen.",
          );
        }
        return toWire(config);
      },
    },
    {
      method: "POST",
      pattern: HOST_BRIDGE_ROUTES.publishingConfig(":tabId"),
      handler: async ({ params, body }: { params: Record<string, string>; body: unknown }) => {
        const projectRoot = requireProjectRoot(deps, params.tabId as string);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new HostBridgeError(400, "bad_request", "Expected a JSON object body");
        }

        const update = body as HostBridgePublishingUpdate;
        try {
          const config = await applyAgentPublishingUpdate(projectRoot, update);
          if (!config) {
            throw new HostBridgeError(
              404,
              "no_publishing_config",
              "No publishing setup for this project yet — nothing to update.",
            );
          }
          return toWire(config);
        } catch (err) {
          if (err instanceof HostBridgeError) throw err;
          // Validation errors from the store surface as plain Errors.
          throw new HostBridgeError(
            400,
            "bad_request",
            err instanceof Error ? err.message : "Invalid publishing update",
          );
        }
      },
    },
  ];
}
