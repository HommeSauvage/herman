import { describe, expect, it } from "vitest";

import { PortRegistry } from "../../../src/bun/preview/port-registry.js";
import { PreviewManager } from "../../../src/bun/preview/preview-manager.js";
import { waitForReady } from "../../../src/bun/preview/preview-readiness.js";
import type {
  PreviewChildProcess,
  PreviewManagerDeps,
  PreviewProbeResult,
  PreviewServerSnapshot,
  SpawnChildOpts,
} from "../../../src/bun/preview/types.js";
import type { DevServer } from "../../../src/shared/herman-manifest.js";
import type { PreviewLogEvent } from "../../../src/shared/preview.js";
import { tabScope } from "../../../src/shared/preview.js";

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
    const text = lines.map((l) => `${l}\n`).join("");
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
} {
  const statuses: PreviewServerSnapshot[] = [];
  const logs: PreviewLogEvent[] = [];
  const spawns: SpawnChildOpts[] = [];
  let nextPort = 5000;

  const deps: PreviewManagerDeps = {
    spawnChild: (opts) => {
      spawns.push(opts);
      return createFakeChild();
    },
    probe: async () => ({ ok: false }) satisfies PreviewProbeResult,
    findFreePort: async (start) => Math.max(start, nextPort++),
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

  return { deps, statuses, logs, spawns };
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
    const scope = tabScope("tab-1");

    const [a, b] = await Promise.all([
      manager.ensureStarted({ scope, folderPath: "/proj", serverId: "web", command: "echo hi" }),
      manager.ensureStarted({ scope, folderPath: "/proj", serverId: "web", command: "echo hi" }),
    ]);

    await manager.awaitStartFlight(scope, "web", false);
    expect(spawns.length).toBe(1);
    expect(a.starting || a.phase === "ready").toBe(true);
    expect(b.starting || b.phase === "ready").toBe(true);
    await manager.stopAll();
  });

  it("starts missing fleet siblings when primary is already ready", async () => {
    let probeOk = false;
    const { deps, spawns } = createDeps({
      probe: async () => (probeOk ? { ok: true, status: 200 } : { ok: false }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-fleet");
    const servers: DevServer[] = [
      { id: "api", label: "API", command: "api", port: 3010 },
      { id: "web", label: "Web", command: "web", port: 3000, primary: true },
    ];

    // Start only web first.
    probeOk = true;
    await manager.ensureStarted({
      scope,
      folderPath: "/fleet",
      serverId: "web",
      command: "web",
      all: false,
    });
    await manager.awaitStartFlight(scope, "web", false);
    // Wait for ready settle.
    await new Promise((r) => setTimeout(r, 30));

    const before = spawns.length;
    expect(before).toBe(1);

    // Fleet ensure should start the missing api sibling.
    await manager.ensureStarted({
      scope,
      folderPath: "/fleet",
      servers,
      all: true,
    });
    await manager.awaitStartFlight(scope, undefined, true);

    expect(spawns.length).toBeGreaterThan(before);
    expect(spawns.some((s) => s.command === "api")).toBe(true);
    await manager.stopAll();
  });

  it("stop during an in-flight start emits no failed afterwards", async () => {
    const { deps, statuses, spawns } = createDeps({
      probe: async () => ({ ok: false }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-stop");

    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo hi",
    });
    // Let the spawn happen; the flight stays inside the early-exit window.
    await new Promise((r) => setTimeout(r, 30));
    expect(spawns.length).toBe(1);
    await manager.stop(scope);
    await manager.awaitStartFlight(scope, "web", false);
    await new Promise((r) => setTimeout(r, 30));

    expect(statuses.some((s) => s.phase === "failed")).toBe(false);
    expect(statuses.some((s) => s.phase === "stopped")).toBe(true);
    await manager.stopAll();
  });

  it("restart(all) replaces the whole fleet", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-restart");
    const servers: DevServer[] = [
      { id: "api", label: "API", command: "api" },
      { id: "web", label: "Web", command: "web", primary: true },
    ];

    await manager.ensureStarted({ scope, folderPath: "/fleet", servers, all: true });
    await manager.awaitStartFlight(scope, undefined, true);
    const firstCount = spawns.length;
    expect(firstCount).toBe(2);

    await manager.restart({ scope, folderPath: "/fleet", servers, all: true });
    await manager.awaitStartFlight(scope, undefined, true);
    expect(spawns.length).toBe(firstCount + 2);
    await manager.stopAll();
  });

  it("passes command intact to spawnChild (quoted args)", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-cmd");
    const command = `bun script.ts --label "hello world"`;
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command,
      resolvedPort: 5555,
    });
    await manager.awaitStartFlight(scope, "web", false);
    expect(spawns[0]?.command).toBe(command);
    await manager.stopAll();
  });

  it("substitutes {port} and {url} in commands", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-tpl");
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "serve --port {port} --public {url}",
      resolvedPort: 5999,
    });
    await manager.awaitStartFlight(scope, "web", false);
    expect(spawns[0]?.command).toBe("serve --port 5999 --public http://localhost:5999");
    await manager.stopAll();
  });

  it("injects portEnv and exportUrlAs into the spawn environment", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-laravel");
    // The Laravel case: artisan serve reads SERVER_PORT.
    const servers: DevServer[] = [
      {
        id: "web",
        label: "Website",
        command: "composer run dev",
        port: 8000,
        portEnv: ["SERVER_PORT"],
        primary: true,
      },
    ];
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      servers,
      all: true,
      reservedPorts: new Map([["web", { port: 8123, release: async () => {} }]]),
    });
    await manager.awaitStartFlight(scope, undefined, true);
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.port).toBe(8123);
    expect(spawns[0]?.env.SERVER_PORT).toBe("8123");
    await manager.stopAll();
  });

  it("releases the reservation hold right before spawning", async () => {
    const order: string[] = [];
    const { deps } = createDeps({
      spawnChild: (opts) => {
        order.push(`spawn:${opts.port}`);
        return createFakeChild();
      },
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-hold");
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      reservedPorts: new Map([
        [
          "web",
          {
            port: 8200,
            release: async () => {
              order.push("release");
            },
          },
        ],
      ]),
    });
    await manager.awaitStartFlight(scope, "web", false);
    expect(order).toEqual(["release", "spawn:8200"]);
    await manager.stopAll();
  });

  it("respawns once on the next port when the child dies instantly with EADDRINUSE", async () => {
    let spawnCount = 0;
    const { deps, spawns, statuses } = createDeps({
      spawnChild: (opts) => {
        spawnCount += 1;
        spawns.push(opts);
        if (spawnCount === 1) {
          return createFakeChild({
            exitAfterMs: 5,
            exitCode: 1,
            stderrLines: ["Error: listen EADDRINUSE: address already in use"],
          });
        }
        return createFakeChild();
      },
      probe: async () => ({ ok: true, status: 200 }),
      findFreePort: async (start) => start,
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-addrinuse");
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      resolvedPort: 8300,
    });
    await manager.awaitStartFlight(scope, "web", false);
    await new Promise((r) => setTimeout(r, 50));

    expect(spawns.length).toBe(2);
    expect(spawns[0]?.port).toBe(8300);
    expect(spawns[1]?.port).toBe(8301);
    expect(statuses.some((s) => s.phase === "failed" && /EADDRINUSE/.test(s.error ?? ""))).toBe(
      false,
    );
    await manager.stopAll();
  });

  it("keys fleets by tab: two tabs on the same folder are isolated", async () => {
    const { deps, spawns } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scopeA = tabScope("tab-a");
    const scopeB = tabScope("tab-b");

    await manager.ensureStarted({
      scope: scopeA,
      folderPath: "/shared",
      serverId: "web",
      command: "echo",
    });
    await manager.ensureStarted({
      scope: scopeB,
      folderPath: "/shared",
      serverId: "web",
      command: "echo",
    });
    await manager.awaitStartFlight(scopeA, "web", false);
    await manager.awaitStartFlight(scopeB, "web", false);
    expect(spawns.length).toBe(2);

    // Stopping one tab's fleet leaves the other untouched.
    await manager.stop(scopeA);
    const statusA = manager.getStatus(scopeA);
    const statusB = manager.getStatus(scopeB);
    expect(statusA.servers.length).toBe(0);
    expect(statusB.servers.length).toBe(1);
    await manager.stopAll();
  });

  it("does not emit failed on intentional stop", async () => {
    const { deps, statuses } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-intentional");
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      resolvedPort: 5556,
    });
    await manager.awaitStartFlight(scope, "web", false);
    await new Promise((r) => setTimeout(r, 20));
    await manager.stop(scope);
    expect(statuses.some((s) => s.phase === "failed")).toBe(false);
    expect(statuses.some((s) => s.phase === "stopped")).toBe(true);
  });

  it("emits failed with stderr on unexpected exit", async () => {
    const child = createFakeChild({ stderrLines: ["Error: boom"] });
    const { deps, statuses } = createDeps({
      spawnChild: () => child,
      probe: async () => ({ ok: false }),
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-boom");
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      resolvedPort: 5557,
      readyTimeoutMs: 5_000,
    });
    await manager.awaitStartFlight(scope, "web", false);
    child.triggerExit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(statuses.some((s) => s.phase === "failed" && s.error?.includes("boom"))).toBe(true);
    await manager.stopAll();
  });

  it("fails readiness when the probed port is owned by another scope", async () => {
    const ports = new PortRegistry();
    // Pre-register ownership of the port to a different scope.
    const reservation = await ports.reserve(5590, tabScope("tab-other"));
    const { deps, statuses } = createDeps({
      probe: async () => ({ ok: true, status: 200 }),
      ports,
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-clash");
    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      resolvedPort: 5590,
    });
    await manager.awaitStartFlight(scope, "web", false);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      statuses.some((s) => s.phase === "failed" && /owned by another/.test(s.error ?? "")),
    ).toBe(true);
    await reservation.release();
    await ports.freeOwner(tabScope("tab-other"));
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
      findFreePort: async (start) => {
        events.push(`findFreePort:${start}`);
        return start;
      },
    });
    const manager = new PreviewManager(deps);
    const scope = tabScope("tab-restart-port");

    await manager.ensureStarted({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      port: 3000,
    });
    await manager.awaitStartFlight(scope, "web", false);

    await manager.restart({
      scope,
      folderPath: "/proj",
      serverId: "web",
      command: "echo",
      port: 3000,
    });
    await manager.awaitStartFlight(scope, "web", false);

    const killIdx = events.indexOf("kill");
    const exitedIdx = events.indexOf("exited");
    const findIndices = events
      .map((e, i) => (e === "findFreePort:3000" ? i : -1))
      .filter((i) => i >= 0);
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(exitedIdx).toBeGreaterThan(killIdx);
    expect(findIndices.length).toBeGreaterThanOrEqual(2);
    const secondFind = findIndices[1];
    if (secondFind === undefined) throw new Error("test precondition: expected second find index");
    expect(secondFind).toBeGreaterThan(exitedIdx);
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
