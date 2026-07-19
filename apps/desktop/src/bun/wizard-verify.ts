/**
 * Host-enforced verification for wizard coding/QA completion gates.
 *
 * Runs manifest `checks[]`, cold-boots the managed preview under a wizard
 * scope, and (for QA) sweeps inventoried routes. Returns a markdown report
 * the agent sees when the gate fails.
 */

import { PREVIEW_TOOL_TEXT_MAX_CHARS } from "@herman/rpc/host-bridge";
import { getLogger } from "@logtape/logtape";

import type { CheckCommand, DevServer } from "../shared/herman-manifest.js";
import type { PreviewFleetSnapshot } from "../shared/preview.js";
import {
  ensurePreviewStarted,
  getDevServerStatus,
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  stopPreviewsForScope,
} from "./preview/index.js";

const logger = getLogger(["herman-desktop", "wizard-verify"]);

const DEFAULT_CHECK_TIMEOUT_S = 300;
const MAX_CHECK_TIMEOUT_S = 900;
const OUTPUT_TAIL_CHARS = 8_192;
const REPORT_CAP = PREVIEW_TOOL_TEXT_MAX_CHARS;

export type GateResult = {
  passed: boolean;
  report: string;
  warnings: string[];
};

/** Minimal browser surface used by the QA route sweep (Stage 3+). */
export type GateBrowser = {
  isAvailable(): Promise<boolean>;
  goto(
    ownerId: string,
    url: string,
    opts?: { settleMs?: number; timeoutMs?: number },
  ): Promise<{
    ok: boolean;
    status?: number;
    url: string;
    pageErrors: string[];
    consoleErrors: string[];
  }>;
};

export type GateDeps = {
  ensurePreviewStarted: typeof ensurePreviewStarted;
  stopPreviewsForScope: typeof stopPreviewsForScope;
  getDevServerStatus: typeof getDevServerStatus;
  runCommand: (
    cmd: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ exitCode: number; output: string }>;
  /** Optional: last N server log lines for a failed boot report. */
  getServerLogTail?: (scope: string, serverId: string, maxLines: number) => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const defaultGateDeps: GateDeps = {
  ensurePreviewStarted,
  stopPreviewsForScope,
  getDevServerStatus,
  runCommand: runShellCommand,
};

/** Milestone/coding gate: checks + cold boot, then stop the server. */
export async function runCodingGate(
  opts: {
    scope: string;
    projectPath: string;
    servers: DevServer[];
    checks: CheckCommand[];
  },
  deps: GateDeps = defaultGateDeps,
): Promise<GateResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  failures.push(...(await runChecks(opts.checks, opts.projectPath, deps)));

  if (opts.servers.length > 0) {
    const boot = await coldBoot(opts.scope, opts.projectPath, opts.servers, deps);
    if (boot.failure) failures.push(boot.failure);
    // Coding gate always stops the preview afterwards.
    await deps.stopPreviewsForScope(opts.scope).catch((error) => {
      logger.warning("Failed to stop preview after coding gate", { error });
    });
  }

  return finalizeResult(failures, warnings);
}

/** QA gate: checks + cold boot + route sweep; leaves the preview RUNNING. */
export async function runQaGate(
  opts: {
    scope: string;
    projectPath: string;
    servers: DevServer[];
    checks: CheckCommand[];
    routes: string[];
    browser?: GateBrowser;
  },
  deps: GateDeps = defaultGateDeps,
): Promise<GateResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  failures.push(...(await runChecks(opts.checks, opts.projectPath, deps)));

  let primaryUrl: string | undefined;
  if (opts.servers.length > 0) {
    const boot = await coldBoot(opts.scope, opts.projectPath, opts.servers, deps);
    if (boot.failure) {
      failures.push(boot.failure);
    } else {
      primaryUrl = boot.primaryUrl;
    }
  }

  if (primaryUrl && failures.length === 0) {
    const routes = opts.routes.length > 0 ? opts.routes : ["/"];
    const sweepFailures = await sweepRoutes({
      ownerId: opts.scope.startsWith("wizard:") ? opts.scope.slice("wizard:".length) : opts.scope,
      primaryUrl,
      routes,
      browser: opts.browser,
      deps,
    });
    failures.push(...sweepFailures);
  }

  return finalizeResult(failures, warnings);
}

async function runChecks(
  checks: CheckCommand[],
  projectPath: string,
  deps: GateDeps,
): Promise<string[]> {
  const failures: string[] = [];
  for (const check of checks) {
    const timeoutS = Math.min(
      Math.max(check.timeout ?? DEFAULT_CHECK_TIMEOUT_S, 1),
      MAX_CHECK_TIMEOUT_S,
    );
    try {
      const result = await deps.runCommand(check.run, projectPath, timeoutS * 1000);
      if (result.exitCode !== 0) {
        failures.push(
          `### Check failed: ${check.label}\n\`\`\`\n${tail(result.output, OUTPUT_TAIL_CHARS)}\n\`\`\``,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`### Check failed: ${check.label}\n\`\`\`\n${detail}\n\`\`\``);
    }
  }
  return failures;
}

async function coldBoot(
  scope: string,
  projectPath: string,
  servers: DevServer[],
  deps: GateDeps,
): Promise<{ primaryUrl?: string; failure?: string }> {
  await deps.stopPreviewsForScope(scope).catch(() => undefined);

  try {
    await deps.ensurePreviewStarted(scope, projectPath, { servers, all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      failure: `### Cold boot failed\nCould not start preview servers.\n\`\`\`\n${detail}\n\`\`\``,
    };
  }

  const fleet = await waitForFleet(scope, deps);
  if (fleet.phase === "failed") {
    const primary =
      fleet.servers.find((s) => s.serverId === fleet.primaryServerId) ?? fleet.servers[0];
    const errorLine = primary?.error?.split("\n")[0] ?? "Preview server failed to start.";
    const serverId = primary?.serverId ?? "web";
    const logTail = deps.getServerLogTail?.(scope, serverId, 40) ?? "";
    const logBlock = logTail
      ? `\n\nRecent server output:\n\`\`\`\n${tail(logTail, OUTPUT_TAIL_CHARS)}\n\`\`\``
      : "";
    return {
      failure: `### Cold boot failed\n${errorLine}${logBlock}`,
    };
  }
  if (fleet.phase !== "ready") {
    return {
      failure: `### Cold boot failed\nPreview did not become ready within ${PREVIEW_READY_TIMEOUT_MS}ms (phase: ${fleet.phase}).`,
    };
  }

  const primary =
    fleet.servers.find((s) => s.serverId === fleet.primaryServerId) ??
    fleet.servers.find((s) => s.phase === "ready" && s.url) ??
    fleet.servers[0];
  return { primaryUrl: primary?.url };
}

async function waitForFleet(scope: string, deps: GateDeps): Promise<PreviewFleetSnapshot> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + PREVIEW_READY_TIMEOUT_MS;
  let last = deps.getDevServerStatus(scope);
  while (now() < deadline) {
    last = deps.getDevServerStatus(scope);
    if (last.phase === "ready" || last.phase === "failed") return last;
    await sleep(PREVIEW_READY_POLL_MS);
  }
  return last;
}

async function sweepRoutes(opts: {
  ownerId: string;
  primaryUrl: string;
  routes: string[];
  browser?: GateBrowser;
  deps: GateDeps;
}): Promise<string[]> {
  const failures: string[] = [];
  const base = opts.primaryUrl.replace(/\/$/, "");
  const browserAvailable = opts.browser ? await opts.browser.isAvailable() : false;

  for (const route of opts.routes) {
    const path = route.startsWith("/") ? route : `/${route}`;
    const url = `${base}${path}`;

    if (browserAvailable && opts.browser) {
      try {
        const result = await opts.browser.goto(opts.ownerId, url, {
          settleMs: 1500,
          timeoutMs: 15_000,
        });
        const problems: string[] = [];
        if (result.status != null && result.status >= 500) {
          problems.push(`HTTP ${result.status}`);
        }
        if (result.pageErrors.length > 0) {
          problems.push(`page errors: ${result.pageErrors.slice(0, 5).join("; ")}`);
        }
        if (result.consoleErrors.length > 0) {
          problems.push(`console errors: ${result.consoleErrors.slice(0, 5).join("; ")}`);
        }
        if (!result.ok || problems.length > 0) {
          failures.push(
            `### Route failed: \`${path}\`\n${problems.join("\n") || "Navigation failed."}`,
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`### Route failed: \`${path}\`\n${detail}`);
      }
      continue;
    }

    // HTTP-only fallback when no browser harness is available.
    const fetchImpl = opts.deps.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (response.status >= 500) {
        failures.push(`### Route failed: \`${path}\`\nHTTP ${response.status}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`### Route failed: \`${path}\`\n${detail}`);
    }
  }

  return failures;
}

function finalizeResult(failures: string[], warnings: string[]): GateResult {
  if (failures.length === 0) {
    return { passed: true, report: "", warnings };
  }
  const body = [...failures, "", "Fix these, then call herman_complete_wizard again."].join("\n\n");
  return {
    passed: false,
    report: tail(body, REPORT_CAP),
    warnings,
  };
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…(truncated)\n${text.slice(-(maxChars - 16))}`;
}

export async function runShellCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { exitCode, output: tail(output, OUTPUT_TAIL_CHARS) };
  } finally {
    clearTimeout(timeout);
  }
}
