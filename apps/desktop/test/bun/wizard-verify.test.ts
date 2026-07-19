import { describe, expect, it } from "vitest";
import { type GateDeps, runCodingGate, runQaGate } from "../../src/bun/wizard-verify.js";
import type { CheckCommand, DevServer } from "../../src/shared/herman-manifest.js";
import type { PreviewFleetSnapshot, PreviewStartResponse } from "../../src/shared/preview.js";

function fleet(
  phase: PreviewFleetSnapshot["phase"],
  opts: { url?: string; error?: string } = {},
): PreviewFleetSnapshot {
  return {
    scope: "wizard:test",
    folderPath: "/tmp/project",
    primaryServerId: "web",
    phase,
    servers: [
      {
        scope: "wizard:test",
        folderPath: "/tmp/project",
        serverId: "web",
        phase,
        ...(opts.url ? { url: opts.url } : {}),
        port: 8000,
        ...(opts.error ? { error: opts.error } : {}),
      },
    ],
  };
}

const servers: DevServer[] = [
  { id: "web", label: "Website", command: "composer run dev", port: 8000, primary: true },
];

type TrackedDeps = GateDeps & {
  stopCalls: number;
  ensureCalls: number;
  runCommands: string[];
};

function makeDeps(
  opts: {
    phases?: PreviewFleetSnapshot["phase"][];
    checkExitCode?: number;
    checkOutput?: string;
    fetchStatus?: number;
    getServerLogTail?: (scope: string, serverId: string, maxLines: number) => string;
  } = {},
): TrackedDeps {
  const phases = opts.phases ?? ["ready"];
  let i = 0;
  const tracked: TrackedDeps = {
    stopCalls: 0,
    ensureCalls: 0,
    runCommands: [],
    ensurePreviewStarted: async () => {
      tracked.ensureCalls++;
      return {
        scope: "wizard:test",
        folderPath: "/tmp/project",
        serverId: "web",
        phase: "ready",
        url: "http://127.0.0.1:8000",
        port: 8000,
        starting: false,
      } satisfies PreviewStartResponse;
    },
    stopPreviewsForScope: async () => {
      tracked.stopCalls++;
    },
    getDevServerStatus: () => {
      const phase = phases[Math.min(i, phases.length - 1)];
      if (!phase) throw new Error("test precondition: expected phase");
      i++;
      return fleet(phase, {
        url: phase === "ready" ? "http://127.0.0.1:8000" : undefined,
        error: phase === "failed" ? "boot exploded\nmore" : undefined,
      });
    },
    runCommand: async (cmd) => {
      tracked.runCommands.push(cmd);
      return {
        exitCode: opts.checkExitCode ?? 0,
        output: opts.checkOutput ?? "ok",
      };
    },
    sleep: async () => undefined,
    now: (() => {
      let t = 0;
      return () => {
        t += 1000;
        return t;
      };
    })(),
    fetchImpl: async () => new Response("body", { status: opts.fetchStatus ?? 200 }),
    ...(opts.getServerLogTail ? { getServerLogTail: opts.getServerLogTail } : {}),
  };
  return tracked;
}

describe("wizard-verify", () => {
  it("passes coding gate when checks and cold boot succeed, then stops preview", async () => {
    const deps = makeDeps();
    const result = await runCodingGate(
      { scope: "wizard:test", projectPath: "/tmp/project", servers, checks: [] },
      deps,
    );
    expect(result.passed).toBe(true);
    expect(result.report).toBe("");
    expect(deps.ensureCalls).toBe(1);
    expect(deps.stopCalls).toBeGreaterThanOrEqual(2); // cold-boot stop + final stop
  });

  it("fails with check report shape when a check exits non-zero", async () => {
    const deps = makeDeps({ checkExitCode: 1, checkOutput: "type error on line 1" });
    const checks: CheckCommand[] = [
      { id: "types", label: "Frontend type check", run: "bunx tsc --noEmit" },
    ];
    const result = await runCodingGate(
      { scope: "wizard:test", projectPath: "/tmp/project", servers: [], checks },
      deps,
    );
    expect(result.passed).toBe(false);
    expect(result.report).toContain("### Check failed: Frontend type check");
    expect(result.report).toContain("type error on line 1");
    expect(result.report).toContain("Fix these, then call herman_complete_wizard again.");
    expect(deps.runCommands).toEqual(["bunx tsc --noEmit"]);
  });

  it("fails coding gate when cold boot fleet is failed", async () => {
    const deps = makeDeps({
      phases: ["failed"],
      getServerLogTail: () => "[stderr] Fatal error",
    });
    const result = await runCodingGate(
      { scope: "wizard:test", projectPath: "/tmp/project", servers, checks: [] },
      deps,
    );
    expect(result.passed).toBe(false);
    expect(result.report).toContain("### Cold boot failed");
    expect(result.report).toContain("boot exploded");
    expect(result.report).toContain("Fatal error");
  });

  it("QA route sweep fails on HTTP 500 without browser", async () => {
    const deps = makeDeps({ fetchStatus: 500 });
    const result = await runQaGate(
      {
        scope: "wizard:test",
        projectPath: "/tmp/project",
        servers,
        checks: [],
        routes: ["/admin"],
      },
      deps,
    );
    expect(result.passed).toBe(false);
    expect(result.report).toContain("### Route failed: `/admin`");
    expect(result.report).toContain("HTTP 500");
    expect(deps.ensureCalls).toBe(1);
  });

  it("QA route sweep uses browser when available", async () => {
    const deps = makeDeps();
    let gotoCalls = 0;
    const browser = {
      isAvailable: async () => true,
      goto: async () => {
        gotoCalls++;
        return {
          ok: false,
          status: 200,
          url: "http://127.0.0.1:8000/",
          pageErrors: ["Uncaught TypeError"],
          consoleErrors: [] as string[],
        };
      },
    };
    const result = await runQaGate(
      {
        scope: "wizard:test",
        projectPath: "/tmp/project",
        servers,
        checks: [],
        routes: ["/"],
        browser,
      },
      deps,
    );
    expect(result.passed).toBe(false);
    expect(result.report).toContain("page errors");
    expect(gotoCalls).toBe(1);
  });
});
