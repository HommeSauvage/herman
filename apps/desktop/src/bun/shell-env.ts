/**
 * Resolve the user's real shell environment and merge PATH into process.env.
 *
 * macOS desktop apps launched from Dock/Finder inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin). Tools installed via nvm, Homebrew,
 * or other shell-configured managers won't be found.
 */

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
        console.warn(`[ShellEnv] Login shell exited with code ${retryResult.exitCode}`);
        return null;
      }

      return parseNullDelimitedEnv(retryResult.stdout.toString());
    }

    return parseNullDelimitedEnv(result.stdout.toString());
  } catch (err) {
    console.warn("[ShellEnv] Failed to spawn login shell:", err);
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
    console.log("[ShellEnv] PATH already contains user paths, skipping resolution");
    cachedShellEnv = null;
    return false;
  }

  console.log("[ShellEnv] Resolving shell environment...");
  const shellEnv = extractShellEnv();

  if (!shellEnv || !shellEnv.PATH) {
    console.warn("[ShellEnv] Could not extract PATH from login shell");
    cachedShellEnv = null;
    return false;
  }

  cachedShellEnv = shellEnv;
  process.env.PATH = shellEnv.PATH;
  console.log(`[ShellEnv] Resolved PATH: ${shellEnv.PATH}`);
  return true;
}
