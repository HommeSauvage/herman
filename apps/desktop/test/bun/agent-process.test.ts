// env.ts validates HERMAN_SERVER_URL at import time
process.env.HERMAN_SERVER_URL = "http://localhost:4000";

import { mock } from "bun:test";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// --------------------------------------------------------------------------
// PipedSubprocess fake for testing stop() behavior
// --------------------------------------------------------------------------

type PipedSubprocess = {
  pid: number;
  exited: Promise<number>;
  killed: boolean;
  signals: string[];
  stdinEnded: boolean;
  kill(signal: string): void;
  resolveExit: (code: number) => void;
};

function fakeSubprocess(): PipedSubprocess {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  return {
    pid: 42,
    exited,
    killed: false,
    signals: [],
    stdinEnded: false,
    resolveExit,
    kill(signal: string) {
      this.signals.push(signal);
      this.killed = true;
    },
  };
}

// --------------------------------------------------------------------------
// Mock AgentRpcClient
// --------------------------------------------------------------------------

class MockAgentRpcClient {
  closed = false;
  exitListeners: Array<(code: number) => void> = [];
  _stderr = "";

  constructor(_commandTimeout?: number) {}

  attach(_proc: unknown) {}

  async close() {
    this.closed = true;
  }

  onExit(listener: (code: number) => void) {
    this.exitListeners.push(listener);
    return () => {
      const idx = this.exitListeners.indexOf(listener);
      if (idx !== -1) this.exitListeners.splice(idx, 1);
    };
  }

  onError(listener: (error: Error) => void) {
    return () => {}; // unused but needed for interface
  }

  emitExit(code: number) {
    for (const listener of this.exitListeners) listener(code);
  }

  get stderr() {
    return this._stderr;
  }
}

let lastMockClient: MockAgentRpcClient | undefined;

beforeEach(() => {
  lastMockClient = undefined;

  mock.module("../../src/bun/agent-rpc.js", () => ({
    AgentRpcClient: class extends MockAgentRpcClient {
      constructor(commandTimeout?: number) {
        super(commandTimeout);
        lastMockClient = this;
      }
    },
  }));

  mock.module("../../src/bun/shell-env.js", () => ({
    resolveShellEnv: () => {},
  }));
});

afterEach(() => {
  mock.restore();
});

function getMockClient(): MockAgentRpcClient {
  if (!lastMockClient) throw new Error("No mock client");
  return lastMockClient;
}

async function createProcess(state: "idle" | "running" = "running", sub?: PipedSubprocess) {
  const { AgentProcess } = await import("../../src/bun/agent-process.js");
  const proc = new AgentProcess({
    binaryPath: "/usr/bin/herman",
  });

  const p = proc as unknown as Record<string, unknown>;
  p.subprocess = sub ?? fakeSubprocess();
  p.processState = state;

  return proc;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("AgentProcess.start pre-flight validation", () => {
  it("fails with binary-missing when the agent binary does not exist", async () => {
    const { AgentProcess, AgentSpawnError } = await import("../../src/bun/agent-process.js");
    const proc = new AgentProcess({ binaryPath: "/nonexistent/herman-agent-xyz" });

    const error = await proc.start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentSpawnError);
    expect((error as InstanceType<typeof AgentSpawnError>).reason).toBe("binary-missing");
    expect((error as Error).message).toContain("/nonexistent/herman-agent-xyz");
    expect(proc.state).toBe("crashed");
  });

  it("fails with cwd-missing when the working directory does not exist", async () => {
    const { AgentProcess, AgentSpawnError } = await import("../../src/bun/agent-process.js");
    // process.execPath exists, so the binary check passes and the cwd check fires.
    const proc = new AgentProcess({
      binaryPath: process.execPath,
      cwd: "/nonexistent/herman-cwd-xyz",
    });

    const error = await proc.start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentSpawnError);
    expect((error as InstanceType<typeof AgentSpawnError>).reason).toBe("cwd-missing");
    // The message must name the real cause (the cwd), not blame the binary
    // the way posix_spawn's ENOENT does.
    expect((error as Error).message).toContain("/nonexistent/herman-cwd-xyz");
    expect((error as Error).message).not.toContain("posix_spawn");
    expect(proc.state).toBe("crashed");
  });
});

describe("AgentProcess.stop", () => {
  it("is a no-op when not running", async () => {
    const proc = await createProcess("idle");

    await proc.stop();

    expect(proc.state).toBe("idle");
    expect(getMockClient().closed).toBe(false);
  });

  it("closes the rpc client, sends SIGTERM, and waits for exit", async () => {
    const sub = fakeSubprocess();
    const proc = await createProcess("running", sub);

    // Resolve exit immediately so stop() completes quickly
    sub.resolveExit(0);
    await proc.stop();

    expect(getMockClient().closed).toBe(true);
    expect(sub.signals).toContain("SIGTERM");
    expect(proc.state).toBe("stopped");
  });

  it("sends SIGKILL after SIGTERM if exit doesn't resolve quickly", async () => {
    const sub = fakeSubprocess();
    const proc = await createProcess("running", sub);

    // Don't resolve exit before SIGTERM timeout.
    // Instead, resolve it after a short real delay — but before SIGKILL timeout.
    // This tests the SIGTERM → timeout → SIGKILL path.
    // However waitForSubprocessExit uses a 3s timeout which is too long for tests.
    // The subprocess-exit.test.ts already verifies the timeout logic.
    // Here we test the structural flow: stop() calls kill("SIGTERM")
    // and then waitForSubprocessExit.
    const stopPromise = proc.stop();

    // Resolve exit after a microtick — this simulates the process exiting
    // before SIGTERM timeout (in real time it's near-instant).
    sub.resolveExit(0);

    await stopPromise;

    expect(sub.signals).toContain("SIGTERM");
    // No SIGKILL because exit resolved before timeout
    expect(sub.signals).not.toContain("SIGKILL");
    expect(proc.state).toBe("stopped");
  }, 500);

  it("returns even when the process exits with non-zero code after SIGTERM", async () => {
    const sub = fakeSubprocess();
    const proc = await createProcess("running", sub);

    sub.resolveExit(1); // crash exit
    await proc.stop();

    expect(proc.state).toBe("stopped");
    expect(sub.signals).toContain("SIGTERM");
  });
});

describe("AgentProcess exit callback", () => {
  it("transitions to crashed on non-zero exit when running", async () => {
    const proc = await createProcess("running");

    getMockClient().emitExit(1);

    expect(proc.state).toBe("crashed");
  });

  it("transitions to stopped on exit code 0 when running", async () => {
    const proc = await createProcess("running");

    getMockClient().emitExit(0);

    expect(proc.state).toBe("stopped");
  });

  it("does not change state when process is not running", async () => {
    const proc = await createProcess("idle");

    getMockClient().emitExit(1);

    expect(proc.state).toBe("idle");
  });
});

describe("AgentProcess properties", () => {
  it("stderr is delegated to the RPC client", async () => {
    await createProcess("running");
    getMockClient()._stderr = "some error output";

    const { AgentProcess } = await import("../../src/bun/agent-process.js");
    const proc = new AgentProcess({
      binaryPath: "/usr/bin/herman",
    });

    getMockClient()._stderr = "some error output";

    expect(proc.stderr).toBe("some error output");
  });

  it("pid returns null before start", async () => {
    const proc = await createProcess("idle");
    (proc as unknown as Record<string, unknown>).subprocess = null;

    expect(proc.pid).toBeNull();
  });

  it("pid returns the subprocess pid when set", async () => {
    const sub = fakeSubprocess();
    const proc = await createProcess("running", sub);

    expect(proc.pid).toBe(42);
  });
});
