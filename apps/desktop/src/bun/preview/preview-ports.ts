import { createServer } from "node:net";

import { normalizeExportUrlAs, type DevServer } from "../../shared/herman-manifest.js";

/** Probe URL — same host as the webview display URL. */
export function probeUrlForPort(port: number): string {
  return `http://localhost:${port}`;
}

export function displayUrlForPort(port: number): string {
  return `http://localhost:${port}`;
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(startPort: number): Promise<number> {
  let port = startPort;
  while (port < startPort + 200) {
    if (await isPortFree(port)) return port;
    port += 1;
  }
  throw new Error(`No free preview port found near ${startPort}`);
}

/** Pre-allocate distinct free ports for a list of servers. */
export async function allocatePorts(
  servers: { id: string; port?: number }[],
): Promise<Map<string, number>> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const server of servers) {
    let candidate = await findFreePort(server.port ?? 4321);
    while (used.has(candidate)) {
      candidate += 1;
      if (!(await isPortFree(candidate))) {
        candidate = await findFreePort(candidate + 1);
      }
    }
    used.add(candidate);
    out.set(server.id, candidate);
  }
  return out;
}

/** Build env map of exportUrlAs aliases → resolved localhost URLs. */
export function buildExportEnv(
  servers: DevServer[],
  ports: Map<string, number>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const server of servers) {
    const port = ports.get(server.id);
    if (port == null) continue;
    const url = displayUrlForPort(port);
    for (const key of normalizeExportUrlAs(server.exportUrlAs)) {
      env[key] = url;
    }
  }
  return env;
}
