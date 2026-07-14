import { getLogger } from "@logtape/logtape";
import { spawn, type Subprocess } from "bun";
import { createServer } from "node:net";

import type { DevServer } from "../shared/herman-manifest.js";
import { ensureWorktreeDependencies } from "./worktree.js";

const logger = getLogger(["herman-desktop", "preview"]);

type PreviewInstance = {
  folderPath: string;
  serverId: string;
  process: Subprocess;
  port: number;
  url: string;
  primary: boolean;
};

/** Keyed by `${folderPath}::${serverId}` */
const previews = new Map<string, PreviewInstance>();

let previewStatusHandler:
  | ((payload: {
      folderPath: string;
      serverId?: string;
      url?: string;
      running: boolean;
      port?: number;
    }) => void)
  | undefined;

function previewKey(folderPath: string, serverId: string): string {
  return `${folderPath}::${serverId}`;
}

export function setPreviewStatusHandler(
  handler: (payload: {
    folderPath: string;
    serverId?: string;
    url?: string;
    running: boolean;
    port?: number;
  }) => void,
) {
  previewStatusHandler = handler;
}

export async function findFreePort(startPort: number): Promise<number> {
  let port = startPort;
  while (port < startPort + 200) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
    port += 1;
  }
  throw new Error(`No free preview port found near ${startPort}`);
}

export async function waitForReady(url: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Preview server did not become ready at ${url}`);
}

function buildCommand(command: string, port: number): string[] {
  const parts = command.split(" ");
  if (command.includes(" run dev") || command.endsWith(" dev") || command.includes("dev:")) {
    return [...parts, "--", "--port", String(port)];
  }
  return parts;
}

/**
 * Start a single named dev server for a project folder.
 */
export async function startDevServer(
  folderPath: string,
  opts?: {
    serverId?: string;
    label?: string;
    command?: string;
    port?: number;
    primary?: boolean;
  },
): Promise<{ url?: string; port: number; serverId: string }> {
  const serverId = opts?.serverId ?? "web";
  const key = previewKey(folderPath, serverId);
  const existing = previews.get(key);
  if (existing) {
    await stopDevServer(folderPath, serverId);
  }

  const preferredPort = opts?.port ?? 4321;
  const resolvedPort = await findFreePort(preferredPort);
  const command = opts?.command ?? "npm run dev";
  await ensureWorktreeDependencies(folderPath);

  const [cmd, ...args] = buildCommand(command, resolvedPort);

  logger.info("Starting dev server", {
    folderPath,
    serverId,
    command,
    port: resolvedPort,
  });

  const proc = spawn([cmd, ...args], {
    cwd: folderPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(resolvedPort),
    },
  });

  const instance: PreviewInstance = {
    folderPath,
    serverId,
    process: proc,
    port: resolvedPort,
    url: `http://localhost:${resolvedPort}`,
    primary: Boolean(opts?.primary ?? serverId === "web"),
  };

  previews.set(key, instance);
  previewStatusHandler?.({
    folderPath,
    serverId,
    running: true,
    url: instance.url,
    port: instance.port,
  });

  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          logger.debug(`[preview stderr] ${folderPath}/${serverId}`, {
            msg: decoder.decode(value),
          });
        }
      }
    } catch {
      // Ignore read errors
    }
  })();

  void proc.exited.then((exitCode) => {
    logger.info("Dev server exited", { folderPath, serverId, exitCode });
    previews.delete(key);
    previewStatusHandler?.({ folderPath, serverId, running: false });
  });

  await waitForReady(instance.url);
  return { url: instance.url, port: resolvedPort, serverId };
}

/**
 * Start all servers from a HERMAN.md / project manifest.
 * Returns the primary server's URL/port.
 */
export async function startAllDevServers(
  folderPath: string,
  servers: DevServer[],
): Promise<{ url?: string; port: number; serverId: string }> {
  if (servers.length === 0) {
    return startDevServer(folderPath, { serverId: "web", primary: true });
  }

  const primary = servers.find((s) => s.primary) ?? servers[0]!;
  let primaryResult: { url?: string; port: number; serverId: string } | undefined;

  for (const server of servers) {
    const result = await startDevServer(folderPath, {
      serverId: server.id,
      label: server.label,
      command: server.command,
      port: server.port,
      primary: server.id === primary.id,
    });
    if (server.id === primary.id) {
      primaryResult = result;
    }
  }

  return primaryResult ?? {
    serverId: primary.id,
    port: primary.port ?? 3000,
  };
}

/**
 * Stops a specific server, or all servers for the folder when serverId omitted.
 */
export async function stopDevServer(folderPath: string, serverId?: string): Promise<void> {
  const keys = [...previews.keys()].filter((key) => {
    if (!key.startsWith(`${folderPath}::`)) return false;
    if (!serverId) return true;
    return key === previewKey(folderPath, serverId);
  });

  for (const key of keys) {
    const instance = previews.get(key);
    if (!instance) continue;
    logger.info("Stopping dev server", {
      folderPath,
      serverId: instance.serverId,
    });
    try {
      instance.process.kill();
    } catch {
      // Process may already be dead
    }
    previews.delete(key);
    previewStatusHandler?.({
      folderPath,
      serverId: instance.serverId,
      running: false,
    });
  }
}

export function getDevServerStatus(
  folderPath: string,
  serverId?: string,
): {
  running: boolean;
  url?: string;
  port?: number;
  serverId?: string;
  servers?: { serverId: string; running: boolean; url?: string; port?: number }[];
} {
  const instances = [...previews.values()].filter((p) => p.folderPath === folderPath);
  if (serverId) {
    const instance = instances.find((p) => p.serverId === serverId);
    if (!instance) return { running: false, serverId };
    return {
      running: !instance.process.killed,
      url: instance.url,
      port: instance.port,
      serverId: instance.serverId,
    };
  }

  const primary =
    instances.find((p) => p.primary) ?? (instances.length > 0 ? instances[0] : undefined);

  return {
    running: Boolean(primary && !primary.process.killed),
    url: primary?.url,
    port: primary?.port,
    serverId: primary?.serverId,
    servers: instances.map((p) => ({
      serverId: p.serverId,
      running: !p.process.killed,
      url: p.url,
      port: p.port,
    })),
  };
}

export async function stopAllDevServers(): Promise<void> {
  const folders = new Set([...previews.values()].map((p) => p.folderPath));
  for (const folder of folders) {
    await stopDevServer(folder);
  }
}
