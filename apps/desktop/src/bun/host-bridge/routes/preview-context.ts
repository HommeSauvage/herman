import { HOST_BRIDGE_ROUTES, type PreviewLogsQuery } from "@herman/rpc/host-bridge";
import type { PreviewContextService } from "../../preview-context/service.js";
import { HostBridgeError, type HostBridgeRoute } from "../server.js";

export function previewContextRoutes(service: PreviewContextService): HostBridgeRoute[] {
  return [
    {
      method: "GET",
      pattern: HOST_BRIDGE_ROUTES.sessionInfo(":tabId"),
      handler: ({ params }: { params: Record<string, string> }) => {
        return service.getSessionInfo(params.tabId as string);
      },
    },
    {
      method: "GET",
      pattern: HOST_BRIDGE_ROUTES.previewState(":tabId"),
      handler: ({ params }: { params: Record<string, string> }) => {
        return service.getPreviewState(params.tabId as string);
      },
    },
    {
      method: "GET",
      pattern: HOST_BRIDGE_ROUTES.previewLogs(":tabId"),
      handler: ({ params, query }: { params: Record<string, string>; query: URLSearchParams }) => {
        const tabId = params.tabId as string;
        const environment = query.get("environment");
        if (!environment || (environment !== "console" && environment !== "server")) {
          throw new HostBridgeError(
            400,
            "bad_request",
            "Missing or invalid 'environment' query parameter (must be 'console' or 'server')",
          );
        }

        const q: PreviewLogsQuery = {
          environment,
          ...(query.has("serverId") ? { serverId: query.get("serverId") as string } : {}),
          ...(query.has("maxEntries")
            ? { maxEntries: parseOptionalInt(query.get("maxEntries")) }
            : {}),
          ...(query.has("maxLinesBeforeAfter")
            ? { maxLinesBeforeAfter: parseOptionalInt(query.get("maxLinesBeforeAfter")) }
            : {}),
        };

        return service.getPreviewLogs(tabId, q);
      },
    },
  ];
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
