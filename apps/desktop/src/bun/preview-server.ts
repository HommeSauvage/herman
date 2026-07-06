import { getLogger } from "@logtape/logtape";
import { spawn, type Subprocess } from "bun";

const logger = getLogger(["herman-desktop", "preview"]);

type PreviewInstance = {
  folderPath: string;
  process: Subprocess;
  port: number;
  url: string;
};

const previews = new Map<string, PreviewInstance>();

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
  const command = devCommand ?? "npm run dev";

  // Parse the command into shell-compatible parts
  const [cmd, ...args] = command.split(" ");

  logger.info("Starting dev server", { folderPath, command, port });

  const proc = spawn([cmd, ...args], {
    cwd: folderPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
    },
  });

  const instance: PreviewInstance = {
    folderPath,
    process: proc,
    port,
    url: `http://localhost:${port}`,
  };

  previews.set(folderPath, instance);

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
  });

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
