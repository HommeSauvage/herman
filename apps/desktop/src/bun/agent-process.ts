import { PROTECTED_PROVIDER_KEY_SET } from "@herman/agent/protected-keys";
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { getLogger } from "@logtape/logtape";

import { AgentRpcClient } from "./agent-rpc.js";
import { resolveShellEnv } from "./shell-env.js";
import { waitForSubprocessExit } from "./subprocess-exit.js";

const logger = getLogger(["herman-desktop", "agent-process"]);

export type AgentProcessState = "idle" | "starting" | "running" | "stopped" | "crashed";

/** Why a spawn attempt failed before (or while) the process was created. */
export type AgentSpawnFailureReason = "binary-missing" | "cwd-missing" | "spawn-failed";

/**
 * Spawn failure with a machine-readable reason. `binary-missing` and
 * `cwd-missing` are deterministic pre-flight failures — retrying the same
 * spawn cannot fix them, so callers (e.g. the wizard) should fail fast
 * instead of backing off. `spawn-failed` covers errors from posix_spawn
 * itself and may be transient.
 */
export class AgentSpawnError extends Error {
  readonly reason: AgentSpawnFailureReason;
  readonly binaryPath: string;
  readonly cwd: string;

  constructor(
    message: string,
    reason: AgentSpawnFailureReason,
    paths: { binaryPath: string; cwd: string },
  ) {
    super(message);
    this.name = "AgentSpawnError";
    this.reason = reason;
    this.binaryPath = paths.binaryPath;
    this.cwd = paths.cwd;
  }
}

export type AgentProcessOptions = {
  binaryPath: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Additional CLI arguments passed to the agent binary (e.g. --skill). */
  args?: string[];
  commandTimeout?: number;
};

type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const SIGTERM_TIMEOUT_MS = 3_000;
const SIGKILL_TIMEOUT_MS = 2_000;

export class AgentProcess {
  private subprocess: PipedSubprocess | null = null;
  private client: AgentRpcClient;
  private processState: AgentProcessState = "idle";

  constructor(private options: AgentProcessOptions) {
    this.client = new AgentRpcClient(options.commandTimeout);
    this.client.onExit((code) => {
      logger.info("Agent process exited", { pid: this.subprocess?.pid, code });
      if (this.processState === "running") {
        this.processState = code === 0 ? "stopped" : "crashed";
      }
    });
  }

  get state(): AgentProcessState {
    return this.processState;
  }

  get pid(): number | null {
    return this.subprocess?.pid ?? null;
  }

  get rpc() {
    return this.client;
  }

  get stderr(): string {
    return this.client.stderr;
  }

  async start() {
    if (this.processState !== "idle") {
      await this.stop();
    }

    this.processState = "starting";
    resolveShellEnv();

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PROTECTED_PROVIDER_KEY_SET.has(key)) {
        env[key] = value;
      }
    }
    if (this.options.env) {
      for (const [key, value] of Object.entries(this.options.env)) {
        if (value !== undefined) env[key] = value;
      }
    }

    // Pre-flight validation. posix_spawn reports ENOENT against the binary
    // path even when the missing component is actually the cwd, which makes
    // spawn errors dangerously misleading — check both explicitly so the
    // error names the real cause, and so callers can tell deterministic
    // setup failures (don't retry) apart from transient ones.
    const cwd = this.options.cwd ?? process.cwd();
    if (!existsSync(this.options.binaryPath)) {
      this.processState = "crashed";
      throw new AgentSpawnError(
        `Agent binary not found: ${this.options.binaryPath}`,
        "binary-missing",
        { binaryPath: this.options.binaryPath, cwd },
      );
    }
    if (!existsSync(cwd)) {
      this.processState = "crashed";
      throw new AgentSpawnError(
        `Agent working directory does not exist: ${cwd}`,
        "cwd-missing",
        { binaryPath: this.options.binaryPath, cwd },
      );
    }

    try {
      const spawnArgs = [this.options.binaryPath, "--mode", "rpc"];
      if (this.options.args) {
        spawnArgs.push(...this.options.args);
      }
      this.subprocess = Bun.spawn(spawnArgs, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd,
        env,
      });
    } catch (error) {
      this.processState = "crashed";
      throw new AgentSpawnError(
        `Failed to spawn agent process: ${error instanceof Error ? error.message : String(error)}`,
        "spawn-failed",
        { binaryPath: this.options.binaryPath, cwd },
      );
    }

    this.client.attach(this.subprocess);
    this.processState = "running";
    logger.info("Agent process started", {
      pid: this.subprocess.pid,
      binaryPath: this.options.binaryPath,
      cwd: this.options.cwd ?? process.cwd(),
    });
  }

  async stop() {
    if (this.processState !== "running" || !this.subprocess) {
      return;
    }

    const pid = this.subprocess.pid;
    logger.info("Stopping agent process", { pid });

    this.processState = "stopped";
    const proc = this.subprocess;
    this.subprocess = null;

    try {
      await this.client.close();
    } catch {
      // ignore
    }

    try {
      proc.stdin.end();
    } catch {
      // ignore
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    const exitedAfterSigterm = await waitForSubprocessExit(proc.exited, SIGTERM_TIMEOUT_MS);

    if (!exitedAfterSigterm) {
      logger.warning("Agent process did not exit after SIGTERM; sending SIGKILL", { pid });
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await waitForSubprocessExit(proc.exited, SIGKILL_TIMEOUT_MS);
    }
    logger.info("Agent process stopped", { pid });
  }
}
