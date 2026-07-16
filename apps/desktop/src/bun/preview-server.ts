import { getLogger } from "@logtape/logtape";
import { spawn, type Subprocess } from "bun";
import { createServer } from "node:net";

import {
  normalizeExportUrlAs,
  type DevServer,
} from "../shared/herman-manifest.js";
import { runInstallCommand } from "./worktree.js";

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
      error?: string;
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
    error?: string;
  }) => void,
) {
  previewStatusHandler = handler;
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
        // Incremented port is also taken — fall back to a full scan.
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
    const url = `http://localhost:${port}`;
    for (const key of normalizeExportUrlAs(server.exportUrlAs)) {
      env[key] = url;
    }
  }
  return env;
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

type StartDevServerOpts = {
  serverId?: string;
  label?: string;
  command?: string;
  /** Preferred port; used when `resolvedPort` is not set. */
  port?: number;
  /** Pre-resolved port; skips findFreePort when set. */
  resolvedPort?: number;
  /** Extra env (e.g. sibling exportUrlAs aliases). */
  extraEnv?: Record<string, string>;
  /** Own exportUrlAs aliases when starting a single server. */
  exportUrlAs?: string | string[];
  primary?: boolean;
  /** Shell command to install dependencies (e.g. from herman.yaml dev.install). Run before dev server. */
  installCommand?: string;
};

/**
 * Start a single named dev server for a project folder.
 */
export async function startDevServer(
  folderPath: string,
  opts?: StartDevServerOpts,
): Promise<{ url?: string; port: number; serverId: string }> {
  const serverId = opts?.serverId ?? "web";
  const key = previewKey(folderPath, serverId);
  const existing = previews.get(key);
  if (existing) {
    await stopDevServer(folderPath, serverId);
  }

  if (opts?.installCommand) {
    await runInstallCommand(folderPath, opts.installCommand);
  }

  const resolvedPort =
    opts?.resolvedPort ?? (await findFreePort(opts?.port ?? 4321));
  const command = opts?.command ?? "npm run dev";

  const ownExportEnv: Record<string, string> = {};
  const ownUrl = `http://localhost:${resolvedPort}`;
  for (const keyName of normalizeExportUrlAs(opts?.exportUrlAs)) {
    ownExportEnv[keyName] = ownUrl;
  }

  const [cmd, ...args] = command.split(" ");

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
      ...opts?.extraEnv,
      ...ownExportEnv,
      PORT: String(resolvedPort),
    },
  });

  const instance: PreviewInstance = {
    folderPath,
    serverId,
    process: proc,
    port: resolvedPort,
    url: ownUrl,
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
  const stderrChunks: string[] = [];
  const reader = proc.stderr.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const text = decoder.decode(value);
          stderrChunks.push(text);
          logger.debug(`[preview stderr] ${folderPath}/${serverId}`, { msg: text });
        }
      }
    } catch {
      // Ignore read errors
    }
  })();

  void proc.exited.then((exitCode) => {
    const error = exitCode !== 0
      ? stderrChunks.join("").slice(0, 800)
      : undefined;
    if (error) {
      logger.warning("Dev server exited with error", {
        folderPath,
        serverId,
        exitCode,
        stderr: error,
      });
    } else {
      logger.info("Dev server exited", { folderPath, serverId, exitCode });
    }
    previews.delete(key);
    previewStatusHandler?.({ folderPath, serverId, running: false, error });
  });

  await waitForReady(instance.url);
  return { url: instance.url, port: resolvedPort, serverId };
}

/**
 * Start all servers from a project manifest (herman.yaml / HERMAN.md).
 * Pre-allocates ports and injects exportUrlAs sibling URL env aliases.
 * Runs installCommand once before starting any servers.
 * Returns the primary server's URL/port.
 */
export async function startAllDevServers(
  folderPath: string,
  servers: DevServer[],
  installCommand?: string,
): Promise<{ url?: string; port: number; serverId: string }> {
  if (servers.length === 0) {
    return startDevServer(folderPath, { serverId: "web", primary: true, installCommand });
  }

  if (installCommand) {
    await runInstallCommand(folderPath, installCommand);
  }

  const primary = servers.find((s) => s.primary) ?? servers[0]!;
  const ports = await allocatePorts(servers);
  const exportEnv = buildExportEnv(servers, ports);
  let primaryResult: { url?: string; port: number; serverId: string } | undefined;
  const startedIds: string[] = [];

  try {
    for (const server of servers) {
      const resolvedPort = ports.get(server.id);
      if (resolvedPort == null) {
        throw new Error(`No port allocated for server ${server.id}`);
      }
      const result = await startDevServer(folderPath, {
        serverId: server.id,
        label: server.label,
        command: server.command,
        resolvedPort,
        extraEnv: exportEnv,
        primary: server.id === primary.id,
      });
      startedIds.push(server.id);
      if (server.id === primary.id) {
        primaryResult = result;
      }
    }
  } catch (error) {
    // Roll back any servers already started so we don't leave a partial fleet.
    for (const id of startedIds) {
      await stopDevServer(folderPath, id).catch(() => undefined);
    }
    throw error;
  }

  return primaryResult ?? {
    serverId: primary.id,
    port: ports.get(primary.id) ?? primary.port ?? 3000,
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
