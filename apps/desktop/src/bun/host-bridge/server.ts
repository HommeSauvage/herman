import type { HostBridgeErrorBody, HostBridgeErrorCode } from "@herman/rpc/host-bridge";
import { HOST_BRIDGE_AUTH_SCHEME, HOST_BRIDGE_PROTOCOL_VERSION } from "@herman/rpc/host-bridge";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["herman-desktop", "host-bridge"]);

export type HostBridgeRequest = {
  params: Record<string, string>; // from :segments in the pattern
  query: URLSearchParams;
  /** Parsed JSON body for POST; undefined for GET or unparseable bodies. */
  body: unknown;
};

export type HostBridgeRoute = {
  method: "GET" | "POST";
  /** Path pattern, e.g. "/v1/tabs/:tabId/preview/logs". */
  pattern: string;
  handler: (req: HostBridgeRequest) => unknown | Promise<unknown>;
};

/** Throw inside a handler to control status + error body. */
export class HostBridgeError extends Error {
  constructor(
    public status: number,
    public code: HostBridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type HostBridgeServer = { url: string; token: string; stop(): Promise<void> };

let activeBridge: HostBridgeServer | undefined;

export function getActiveHostBridge(): HostBridgeServer | undefined {
  return activeBridge;
}

function matchRoute(
  pathname: string,
  routes: HostBridgeRoute[],
): { route: HostBridgeRoute; params: Record<string, string> } | undefined {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    const patternSegments = route.pattern.split("/").filter(Boolean);
    if (segments.length !== patternSegments.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const pat = patternSegments[i] as string;
      const seg = segments[i] as string;
      if (pat.startsWith(":")) {
        try {
          params[pat.slice(1)] = decodeURIComponent(seg);
        } catch {
          // Malformed percent-encoding in URL segment.
          matches = false;
          break;
        }
      } else if (pat !== seg) {
        matches = false;
        break;
      }
    }
    if (matches) return { route, params };
  }
  return undefined;
}

export async function startHostBridgeServer(routes: HostBridgeRoute[]): Promise<HostBridgeServer> {
  const token = crypto.randomUUID();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);

      // Health is unauthenticated.
      if (url.pathname === "/v1/health" && request.method === "GET") {
        return Response.json({ ok: true, version: HOST_BRIDGE_PROTOCOL_VERSION });
      }

      // All other routes require Bearer auth.
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `${HOST_BRIDGE_AUTH_SCHEME} ${token}`) {
        return Response.json(
          { error: "Unauthorized", code: "unauthorized" } satisfies HostBridgeErrorBody,
          { status: 401 },
        );
      }

      const match = matchRoute(url.pathname, routes);
      if (!match || match.route.method !== request.method) {
        return Response.json(
          { error: "Not found", code: "not_found" } satisfies HostBridgeErrorBody,
          { status: 404 },
        );
      }

      logger.debug("Host bridge request", {
        method: request.method,
        path: url.pathname,
      });

      try {
        const body =
          request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        const result = await match.route.handler({
          params: match.params,
          query: url.searchParams,
          body,
        });
        return Response.json(result);
      } catch (err) {
        if (err instanceof HostBridgeError) {
          return Response.json(
            { error: err.message, code: err.code } satisfies HostBridgeErrorBody,
            { status: err.status },
          );
        }
        logger.error("Unhandled host bridge error", {
          error: err instanceof Error ? err.message : String(err),
          path: url.pathname,
        });
        return Response.json(
          { error: "Internal error", code: "internal" } satisfies HostBridgeErrorBody,
          { status: 500 },
        );
      }
    },
  });

  const hostBridge: HostBridgeServer = {
    url: `http://127.0.0.1:${server.port}`,
    token,
    async stop() {
      if (activeBridge === hostBridge) {
        activeBridge = undefined;
      }
      server.stop();
    },
  };

  activeBridge = hostBridge;
  logger.info("Host bridge server started", { url: hostBridge.url });

  return hostBridge;
}
