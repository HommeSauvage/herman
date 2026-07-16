import { describe, expect, it } from "vitest";

import { PreviewManager } from "../../../src/bun/preview/preview-manager.js";
import { waitForReady } from "../../../src/bun/preview/preview-readiness.js";
import type {
  PreviewChildProcess,
  PreviewManagerDeps,
  PreviewProbeResult,
  PreviewServerSnapshot,
  SpawnChildOpts,
} from "../../../src/bun/preview/types.js";
import type { PreviewLogEvent } from "../../../src/shared/preview.js";
import type { DevServer } from "../../../src/shared/herman-manifest.js";

function createFakeChild(opts?: {
  exitCode?: number;
  exitAfterMs?: number;
  stdoutLines?: string[];
  stderrLines?: string[];
}): PreviewChildProcess & { triggerExit: (code: number) => void } {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let killed = false;

  const encode = (lines: string[]) => {
    const text = lines.map((l) => l + "\n").join("");
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  };

  if (opts?.exitAfterMs != null) {
    setTimeout(() => resolveExit(opts.exitCode ?? 0), opts.exitAfterMs);
  }

  return {
    get killed() {
      return killed;
    },
    exited,
    stdout: encode(opts?.stdoutLines ?? []),
    stderr: encode(opts?.stderrLines ?? []),
    kill: () => {
      killed = true;
      resolveExit(0);
    },
    triggerExit: (code) => resolveExit(code),
  };
}

function createDeps(overrides?: Partial<PreviewManagerDeps>): {
  deps: PreviewManagerDeps;
  statuses: PreviewServerSnapshot[];
  logs: PreviewLogEvent[];
  spawns: SpawnChildOpts[];
  installs: string[];
} {
  const statuses: PreviewServerSnapshot[] = [];
  const logs: PreviewLogEvent[] = [];
  const spawns: SpawnChildOpts[] = [];
  const installs: string[] = [];
  let nextPort = 5000;

  const deps: PreviewManagerDeps = {
    spawnChild: (opts) => {
      spawns.push(opts);
      return createFakeChild();
    },
    probe: async () => ({ ok: false } satisfies PreviewProbeResult),
    findFreePort: async () => nextPort++,
    allocatePorts: async (servers) => {
      const map = new Map<string, number>();
      for (const s of servers) {
        map.set(s.id, nextPort++);
      }
      return map;
    },
    runInstall: async (_folder, cmd) => {
      installs.push(cmd);
    },
    shouldInstall: (_folder, cmd) => Boolean(cmd),
    emitStatus: (s) => statuses.push(s),
    emitLog: (e) => logs.push(e),
    now: () => Date.now(),
    sleep: async (ms, signal) => {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const t = setTimeout(resolve, Math.min(ms, 5));
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    },
    ...overrides,
  };

  return { deps, statuses, logs, spawns, installs };
}

describe("PreviewManager", () => {
  it("single-flights concurrent ensures for one server", async () => {
    let probeCount = 0;
    const { deps, spawns } = createDeps({
      probe: async () => {
        probeCount += 1;
        return probeCount > 2 ? { ok: true, status: 200 } : { ok: false };
      },
    });
    const manager = new PreviewManager(deps);

    const [a, b] = await Promise.all([
      manager.ensureStarted({ folderPath: "/proj", serverId: "web", command: "echo hi" }),
      manager.ensureStarted({ folderPath: "/proj", serverId: "web", command: "echo hi" }),
    ]);

    await manager.awaitStartFlight("/proj", "web", false);
    expect(spawns.length).toBe(1);
    expect(a.starting || a.phase === "ready").toBe(true);
    expect(b.starting || b.phase === "ready").toBe(true);
    await manager.stopAll();
  });

  it("starts missing fleet siblings when primary is already ready", async () => {
    let probeOk = false;
    const { deps, spawns } = createDeps({
      probe: async () => (probeOk ? { ok: true, status: 200 } : { ok: false }),
      shouldInstall: () => false,
    });
    const manager = new PreviewManager(deps);
    const servers: DevServer[] = [
      { id: "api", label: "API", command: "api", port: 3010 },
      { id: "web", label: "Web", command: "web", port: 3000, primary: true },
    ];

    // Start only web first.
    probeOk = true;
    await manager.ensureStarted({
      folderPath: "/fleet",
      serverId: "web",
      command: "web",
      all: false,
    });
    await manager.awaitStartFlight("/fleet", "web", false);
    // Wait for ready settle.
    await new Promise((r) => setTimeout(r, 30));

    const before = spawns.length;
    expect(before).toBe(1);

    // Fleet ensure should start the missing api sibling.
    await manager.ensureStarted({
      folderPath: "/fleet",
      servers,
      all: true,
    });
    await manager.awaitStartFlight("/fleet", undefined, true);

    expect(spawns.length).toBeGreaterThan(before);
    expect(spawns.some((s) => s.command === "api")).toBe(true);
    await manager.stopAll();
  });

  it("stop during install prevents later spawn", async () => {
    let resolveInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      resolveInstall = resolve;
    });
    const { deps, spawns, installs } = createDeps({
      shouldInstall: () => true,
      runInstall: async () => {
        installs.push("npm install");
        await installGate;
      },
    });
    const manager = new PreviewManager(deps);

    const startPromise = manager.ensureStarted({
      folderPath: "/proj",
      serverId: "web",
      command: "echo hi",
      installCommand: "npm install",
    });
    await startPromise;

    // Give the flight time to enter install.
    await new Promise((r) => setTimeout(r, 10));
    await manager.stop("/proj");
    resolveInstall();
    await manager.awaitStartFlight("/proj", "web", false);

    expect(spawns.length).toBe(0);
    await manager.stopAll();
  });

  it("restart(all) replaces the whole fleet", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
      shouldInstall: () => false,
    });
    const manager = new PreviewManager(deps);
    const servers: DevServer[] = [
      { id: "api", label: "API", command: "api" },
      { id: "web", label: "Web", command: "web", primary: true },
    ];

    await manager.ensureStarted({ folderPath: "/fleet", servers, all: true });
    await manager.awaitStartFlight("/fleet", undefined, true);
    const firstCount = spawns.length;
    expect(firstCount).toBe(2);

    await manager.restart({ folderPath: "/fleet", servers, all: true });
    await manager.awaitStartFlight("/fleet", undefined, true);
    expect(spawns.length).toBe(firstCount + 2);
    await manager.stopAll();
  });

  it("passes command intact to spawnChild (quoted args)", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
      shouldInstall: () => false,
    });
    const manager = new PreviewManager(deps);
    const command = `bun script.ts --label "hello world"`;
    await manager.ensureStarted({
      folderPath: "/proj",
      serverId: "web",
      command,
      resolvedPort: 5555,
    });
    await manager.awaitStartFlight("/proj", "web", false);
    expect(spawns[0]?.command).toBe(command);
    await manager.stopAll();
  });

  it("does not emit failed on intentional stop", async () => {
    const { deps, statuses } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
      shouldInstall: () => false,
    });
    const manager = new PreviewManager(deps);
    await manager.ensureStarted({
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      resolvedPort: 5556,
    });
    await manager.awaitStartFlight("/proj", "web", false);
    await new Promise((r) => setTimeout(r, 20));
    await manager.stop("/proj");
    expect(statuses.some((s) => s.phase === "failed")).toBe(false);
    expect(statuses.some((s) => s.phase === "stopped")).toBe(true);
  });

  it("emits failed with stderr on unexpected exit", async () => {
    const child = createFakeChild({ stderrLines: ["Error: boom"] });
    const { deps, statuses } = createDeps({
      spawnChild: () => child,
      probe: async () => ({ ok: false }),
      shouldInstall: () => false,
    });
    const manager = new PreviewManager(deps);
    await manager.ensureStarted({
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      resolvedPort: 5557,
      readyTimeoutMs: 5_000,
    });
    await manager.awaitStartFlight("/proj", "web", false);
    child.triggerExit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(statuses.some((s) => s.phase === "failed" && s.error?.includes("boom"))).toBe(true);
    await manager.stopAll();
  });

  it("awaits process exit before findFreePort on restart", async () => {
    const events: string[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let killed = false;

    const slowChild: PreviewChildProcess = {
      get killed() {
        return killed;
      },
      exited,
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      kill: () => {
        events.push("kill");
        setTimeout(() => {
          killed = true;
          events.push("exited");
          resolveExit(0);
        }, 30);
      },
    };

    let spawnCount = 0;
    const { deps } = createDeps({
      spawnChild: (opts) => {
        spawnCount += 1;
        events.push(`spawn:${opts.port}`);
        // First instance exits slowly on kill; later spawns exit immediately.
        if (spawnCount === 1) return slowChild;
        return createFakeChild();
      },
      probe: async () => ({ ok: true, status: 200 }),
      shouldInstall: () => false,
      findFreePort: async (start) => {
        events.push(`findFreePort:${start}`);
        return start;
      },
    });
    const manager = new PreviewManager(deps);

    await manager.ensureStarted({
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      port: 3000,
    });
    await manager.awaitStartFlight("/proj", "web", false);

    await manager.restart({
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      port: 3000,
    });
    await manager.awaitStartFlight("/proj", "web", false);

    const killIdx = events.indexOf("kill");
    const exitedIdx = events.indexOf("exited");
    const findIndices = events
      .map((e, i) => (e === "findFreePort:3000" ? i : -1))
      .filter((i) => i >= 0);
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(exitedIdx).toBeGreaterThan(killIdx);
    expect(findIndices.length).toBeGreaterThanOrEqual(2);
    expect(findIndices[1]!).toBeGreaterThan(exitedIdx);
    await manager.stopAll();
  });
});

describe("waitForReady", () => {
  it("does not busy-spin when processExited is omitted", async () => {
    let sleepCalls = 0;
    const started = Date.now();
    await expect(
      waitForReady({
        url: "http://localhost:1",
        timeoutMs: 40,
        pollMs: 10,
        probe: async () => ({ ok: false }),
        sleep: async () => {
          sleepCalls += 1;
          await new Promise((r) => setTimeout(r, 10));
        },
        now: () => Date.now(),
      }),
    ).rejects.toThrow(/did not become ready/);
    const elapsed = Date.now() - started;
    expect(sleepCalls).toBeGreaterThanOrEqual(2);
    expect(sleepCalls).toBeLessThan(20);
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it("treats HTTP 4xx and 5xx as ready", async () => {
    await waitForReady({
      url: "http://localhost:1",
      timeoutMs: 100,
      pollMs: 5,
      probe: async () => ({ ok: false, status: 404 }),
      sleep: async () => undefined,
    });

    await waitForReady({
      url: "http://localhost:1",
      timeoutMs: 100,
      pollMs: 5,
      probe: async () => ({ ok: false, status: 500 }),
      sleep: async () => undefined,
    });
  });

  it("keeps polling when probe has no HTTP status", async () => {
    await expect(
      waitForReady({
        url: "http://localhost:1",
        timeoutMs: 30,
        pollMs: 5,
        probe: async () => ({ ok: false }),
        sleep: async () => new Promise((r) => setTimeout(r, 5)),
      }),
    ).rejects.toThrow(/did not become ready/);
  });

  it("aborts when signal is aborted", async () => {
    const abort = new AbortController();
    const promise = waitForReady({
      url: "http://localhost:1",
      timeoutMs: 5_000,
      pollMs: 50,
      signal: abort.signal,
      probe: async () => ({ ok: false }),
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    });
    abort.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
