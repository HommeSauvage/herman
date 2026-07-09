import { getLogger } from "@logtape/logtape";
import { spawn, type Subprocess } from "bun";
import { createServer } from "node:net";

import { ensureWorktreeDependencies } from "./worktree.js";

const logger = getLogger(["herman-desktop", "preview"]);

type PreviewInstance = {
  folderPath: string;
  process: Subprocess;
  port: number;
  url: string;
};

const previews = new Map<string, PreviewInstance>();
let previewStatusHandler:
  | ((payload: { folderPath: string; url?: string; running: boolean; port?: number }) => void)
  | undefined;

export function setPreviewStatusHandler(
  handler: (payload: { folderPath: string; url?: string; running: boolean; port?: number }) => void,
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
  if (command.includes(" run dev") || command.endsWith(" dev")) {
    return [...parts, "--", "--port", String(port)];
  }
  return parts;
}

/**
 * Starts a dev server for the given project folder.
 * Watches stdout for the port/URL and resolves once the server is ready.
 */
export async function startDevServer(
  folderPath: string,
  devCommand?: string,
  devPort?: number,
): Promise<{ url?: string; port: number }> {
  // Stop any existing preview for this folder
  const existing = previews.get(folderPath);
  if (existing) {
    await stopDevServer(folderPath);
  }

  const port = devPort ?? 4321;
  const resolvedPort = await findFreePort(port);
  const command = devCommand ?? "npm run dev";
  await ensureWorktreeDependencies(folderPath);

  // Parse the command into shell-compatible parts
  const [cmd, ...args] = buildCommand(command, resolvedPort);

  logger.info("Starting dev server", { folderPath, command, port: resolvedPort });

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
    process: proc,
    port: resolvedPort,
    url: `http://localhost:${resolvedPort}`,
  };

  previews.set(folderPath, instance);
  previewStatusHandler?.({
    folderPath,
    running: true,
    url: instance.url,
    port: instance.port,
  });

  // Log stderr for debugging
  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          logger.debug(`[preview stderr] ${folderPath}`, { msg: decoder.decode(value) });
        }
      }
    } catch {
      // Ignore read errors
    }
  })();

  // Handle process exit
  void proc.exited.then((exitCode) => {
    logger.info("Dev server exited", { folderPath, exitCode });
    previews.delete(folderPath);
    previewStatusHandler?.({ folderPath, running: false });
  });

  await waitForReady(instance.url);
  return { url: instance.url, port };
}

/**
 * Stops the dev server for a given project folder.
 */
export async function stopDevServer(folderPath: string): Promise<void> {
  const instance = previews.get(folderPath);
  if (!instance) return;

  logger.info("Stopping dev server", { folderPath });

  try {
    instance.process.kill();
  } catch {
    // Process may already be dead
  }

  previews.delete(folderPath);
  previewStatusHandler?.({ folderPath, running: false });
}

/**
 * Returns the current status of a dev server for a project folder.
 */
export function getDevServerStatus(
  folderPath: string,
): { running: boolean; url?: string; port?: number } {
  const instance = previews.get(folderPath);
  if (!instance) return { running: false };

  return {
    running: !instance.process.killed,
    url: instance.url,
    port: instance.port,
  };
}

/**
 * Stops all running dev servers.
 */
export async function stopAllDevServers(): Promise<void> {
  const paths = [...previews.keys()];
  for (const path of paths) {
    await stopDevServer(path);
  }
}
