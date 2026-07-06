import { PROTECTED_PROVIDER_KEY_SET } from "@herman/agent/protected-keys";
import type { Subprocess } from "bun";

import { AgentRpcClient } from "./agent-rpc.js";
import { resolveShellEnv } from "./shell-env.js";
import { waitForSubprocessExit } from "./subprocess-exit.js";

export type AgentProcessState = "idle" | "starting" | "running" | "stopped" | "crashed";

export type AgentProcessOptions = {
  binaryPath: string;
  packageDir: string;
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
    env.PI_PACKAGE_DIR = this.options.packageDir;

    try {
      const spawnArgs = [this.options.binaryPath, "--mode", "rpc"];
      if (this.options.args) {
        spawnArgs.push(...this.options.args);
      }
      this.subprocess = Bun.spawn(spawnArgs, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.options.cwd ?? process.cwd(),
        env,
      });
    } catch (error) {
      this.processState = "crashed";
      throw new Error(
        `Failed to spawn agent process: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.client.attach(this.subprocess);
    this.processState = "running";
  }

  async stop() {
    if (this.processState !== "running" || !this.subprocess) {
      return;
    }

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
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await waitForSubprocessExit(proc.exited, SIGKILL_TIMEOUT_MS);
    }
  }
}
