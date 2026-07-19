/**
 * Resolve the user's real shell environment and merge PATH into process.env.
 *
 * macOS desktop apps launched from Dock/Finder inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin). Tools installed via nvm, Homebrew,
 * or other shell-configured managers won't be found.
 */

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["herman-desktop", "shell-env"]);

let cachedShellEnv: Record<string, string> | null | undefined;

function detectShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

function extractShellEnv(): Record<string, string> | null {
  const shell = detectShell();

  try {
    const result = Bun.spawnSync([shell, "-l", "-i", "-c", "env -0"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
      timeout: 5_000,
    });

    if (result.exitCode !== 0) {
      const retryResult = Bun.spawnSync([shell, "-l", "-c", "env -0"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
        timeout: 5_000,
      });

      if (retryResult.exitCode !== 0) {
        logger.warning("Login shell exited with non-zero code", {
          exitCode: retryResult.exitCode,
        });
        return null;
      }

      return parseNullDelimitedEnv(retryResult.stdout.toString());
    }

    return parseNullDelimitedEnv(result.stdout.toString());
  } catch (err) {
    logger.warning("Failed to spawn login shell", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function parseNullDelimitedEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex > 0) {
      env[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
    }
  }
  return env;
}

export function resolveShellEnv(): boolean {
  if (process.platform === "win32") return false;

  // Return cached result on subsequent calls (idempotent).
  if (cachedShellEnv !== undefined) {
    if (cachedShellEnv?.PATH) {
      process.env.PATH = cachedShellEnv.PATH;
    }
    return cachedShellEnv !== null;
  }
  const currentPath = process.env.PATH ?? "";
  const hasUserPaths =
    currentPath.includes("/.nvm/") ||
    currentPath.includes("/homebrew/") ||
    currentPath.includes("/usr/local/bin") ||
    currentPath.includes("/.bun/");

  if (hasUserPaths) {
    logger.debug("PATH already contains user paths, skipping resolution");
    cachedShellEnv = null;
    return false;
  }

  logger.info("Resolving shell environment");
  const shellEnv = extractShellEnv();

  if (!shellEnv?.PATH) {
    logger.warning("Could not extract PATH from login shell");
    cachedShellEnv = null;
    return false;
  }

  cachedShellEnv = shellEnv;
  process.env.PATH = shellEnv.PATH;
  logger.info("Resolved shell PATH", { path: shellEnv.PATH });
  return true;
}

/**
 * Forget the cached login-shell environment so the next resolveShellEnv()
 * re-reads it. Call after Herman installs tools that modify shell rc files
 * (e.g. bun's installer), so subsequent resolves see the fresh PATH.
 */
export function invalidateShellEnvCache(): void {
  cachedShellEnv = undefined;
}

/**
 * Prepend directories to the current process PATH (children inherit it).
 * Used after Herman installs a tool whose location is known (e.g. brew,
 * bun) so requirement re-checks and spawned agents see it immediately,
 * without waiting for a login-shell re-resolve. `~` is expanded.
 */
export function augmentProcessPath(dirs: string[]): void {
  const home = process.env.HOME ?? "";
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const additions: string[] = [];
  for (const dir of dirs) {
    const expanded = dir.startsWith("~") ? home + dir.slice(1) : dir;
    if (expanded && !current.includes(expanded) && !additions.includes(expanded)) {
      additions.push(expanded);
    }
  }
  if (additions.length === 0) return;
  process.env.PATH = [...additions, ...current].join(":");
  // Keep the cache coherent: if a cached shell env exists, update it too so
  // a later resolveShellEnv() doesn't clobber the augmented PATH.
  if (cachedShellEnv?.PATH) {
    const cachedParts = cachedShellEnv.PATH.split(":").filter(Boolean);
    const missing = additions.filter((d) => !cachedParts.includes(d));
    if (missing.length > 0) cachedShellEnv.PATH = [...missing, ...cachedParts].join(":");
  }
  logger.info("Augmented process PATH", { additions });
}
