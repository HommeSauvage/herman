import { getLogger } from "@logtape/logtape";

const logger = getLogger(["herman-desktop", "publishing", "coolify-install"]);

const COOLIFY_INSTALL_URL = "https://cdn.coollabs.io/coolify/install.sh";
const DEFAULT_TIMEOUT_MS = 10 * 60_000; // Coolify installs typically take 2-3 min
const CONNECT_TIMEOUT_S = 15;

export interface CoolifyInstallProgress {
  stream: "stdout" | "stderr";
  line: string;
}

export interface CoolifyInstallResult {
  ok: boolean;
  /** Derived dashboard URL (http://<ip>:8000) when the install completed. */
  coolifyUrl?: string;
  /** True when the dashboard answered an HTTP request after install. */
  verified?: boolean;
  error?: string;
}

/** Guard against concurrent installs targeting the same server. */
const installsInFlight = new Set<string>();

function sshArgs(serverIp: string, sshKeyPath: string, remoteCommand: string): string[] {
  return [
    "ssh",
    "-i",
    sshKeyPath,
    "-o",
    "BatchMode=yes", // never prompt (fails fast if key rejected)
    "-o",
    "StrictHostKeyChecking=accept-new", // TOFU host key, no interactive prompt
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    `root@${serverIp}`,
    remoteCommand,
  ];
}

/** Read a stream line by line, invoking `onLine` for each complete line. */
async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
        idx = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) onLine(tail);
  } catch {
    // stream cancelled (process killed) — fine
  }
}

/**
 * Quick pre-flight check: can we reach the server over SSH with the deploy
 * key? Returns a rookie-friendly error when not (key not added yet, wrong
 * IP, server still booting).
 */
export async function checkSshConnectivity(
  serverIp: string,
  sshKeyPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(sshArgs(serverIp, sshKeyPath, "echo herman-ssh-ok"), {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode === 0 && stdout.includes("herman-ssh-ok")) {
    return { ok: true };
  }

  logger.warning("SSH connectivity check failed", {
    serverIp,
    exitCode,
    stderr: stderr.trim().slice(0, 500),
  });

  return {
    ok: false,
    error:
      "Could not connect to the server. Check that the server finished booting, the IP address is correct, and the SSH public key was added to the server (on Hetzner, the key must be selected when creating the server).",
  };
}

/**
 * Install Coolify on the user's server over SSH — Herman does this for the
 * rookie; no terminal required. Streams installer output via `onProgress`.
 */
export async function installCoolify(opts: {
  serverIp: string;
  sshKeyPath: string;
  onProgress?: (progress: CoolifyInstallProgress) => void;
  timeoutMs?: number;
}): Promise<CoolifyInstallResult> {
  const { serverIp, sshKeyPath, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const coolifyUrl = `http://${serverIp}:8000`;
  const flightKey = `${sshKeyPath}@${serverIp}`;

  if (installsInFlight.has(flightKey)) {
    return { ok: false, error: "An install is already running for this server." };
  }
  installsInFlight.add(flightKey);

  try {
    // Preflight: fail fast with actionable guidance when SSH doesn't work.
    const check = await checkSshConnectivity(serverIp, sshKeyPath);
    if (!check.ok) {
      return { ok: false, error: check.error };
    }

    onProgress?.({ stream: "stdout", line: "Connected. Running the Coolify installer…" });

    // Run as root directly; fall back to non-interactive sudo for sudo users.
    const remoteCommand = `curl -fsSL ${COOLIFY_INSTALL_URL} | if [ "$(id -u)" -eq 0 ]; then bash; else sudo -n bash; fi`;

    const proc = Bun.spawn(sshArgs(serverIp, sshKeyPath, remoteCommand), {
      stdout: "pipe",
      stderr: "pipe",
    });

    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, timeoutMs);

    const lastErrorLines: string[] = [];
    await Promise.all([
      streamLines(proc.stdout, (line) => onProgress?.({ stream: "stdout", line })),
      streamLines(proc.stderr, (line) => {
        lastErrorLines.push(line);
        if (lastErrorLines.length > 20) lastErrorLines.shift();
        onProgress?.({ stream: "stderr", line });
      }),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(killer);

    if (exitCode !== 0) {
      const detail = lastErrorLines.slice(-3).join(" · ");
      logger.warning("Coolify install failed", { serverIp, exitCode, detail });
      return {
        ok: false,
        error: `The Coolify installer failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`,
      };
    }

    onProgress?.({ stream: "stdout", line: "Installer finished. Checking the dashboard…" });

    const verified = await verifyDashboard(coolifyUrl);
    logger.info("Coolify installed", { serverIp, verified });

    return { ok: true, coolifyUrl, verified };
  } finally {
    installsInFlight.delete(flightKey);
  }
}

/** Poll the dashboard a few times — Coolify takes a moment to come up. */
async function verifyDashboard(coolifyUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(coolifyUrl, {
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      });
      // Any HTTP response (even a redirect to /login) means it's up.
      if (response.status > 0) return true;
    } catch {
      // not up yet
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 4_000));
    }
  }
  return false;
}
