/**
 * Toolchain engine — detects and installs the tools Herman needs.
 *
 * Strategies (see shared/tool-registry.ts):
 *  - clt:            Apple Command Line Tools via the native xcode-select
 *                    dialog, polled until the async system install finishes.
 *  - brew-bootstrap: Homebrew via one native admin prompt (mkdir + chown of
 *                    the prefix) followed by a user-scope tarball extract —
 *                    the documented "untar anywhere" method, so the official
 *                    interactive installer (which refuses root) is avoided.
 *  - curl-sh:        user-scope installer scripts (bun). No admin needed.
 *  - brew-formula:   `brew install <formula>` (user-scope).
 *  - winget:         Windows package install (untested data path).
 *  - manual:         no silent install exists (Docker Desktop, …) — the UI
 *                    drives a guided download + re-detect loop instead.
 *
 * Installs are single-flight: one run at a time, progress streamed as
 * ToolchainEvent so the renderer can show live per-tool progress.
 */

import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import type {
  ToolInstallItem,
  ToolInstallResult,
  ToolRegistryEntry,
  ToolStrategy,
  ToolchainEvent,
  ToolchainToolStatus,
} from "../shared/tool-registry.js";
import {
  TOOL_REGISTRY,
  currentToolPlatform,
  getRequiredTier0Ids,
  getStrategy,
  getToolEntry,
  orderByDependency,
} from "../shared/tool-registry.js";
import { augmentProcessPath, invalidateShellEnvCache } from "./shell-env.js";

const logger = getLogger(["herman-desktop", "toolchain"]);

const PLATFORM = currentToolPlatform();

export type ToolchainEmitter = (event: ToolchainEvent) => void;

// ── Small helpers ────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

type RunResult = { code: number; stdout: string; stderr: string };

async function run(
  command: string,
  opts: { timeoutMs?: number; onLog?: (text: string) => void } = {},
): Promise<RunResult> {
  const { timeoutMs = 120_000, onLog } = opts;
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, timeoutMs);

  const readStream = async (stream: ReadableStream, isErr: boolean, acc: string[]): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (isErr) acc.push(chunk);
      else acc.push(chunk);
      buffer += chunk;
      // Emit complete lines as log events.
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (line.trim()) onLog?.(line.slice(0, 300));
      }
    }
    if (buffer.trim()) onLog?.(buffer.trim().slice(0, 300));
  };

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  await Promise.all([
    readStream(proc.stdout, false, stdoutChunks),
    readStream(proc.stderr, true, stderrChunks),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    return { code: -1, stdout: stdoutChunks.join(""), stderr: "Timed out" };
  }
  return {
    code,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect a tool: run its check command; on failure, prepend known probe dirs
 * to PATH (covers "installed after Herman launched / login shell never
 * picked it up") and retry once.
 */
export async function detectTool(entry: ToolRegistryEntry): Promise<{ installed: boolean; detail: string }> {
  const first = await run(entry.check, { timeoutMs: 15_000 });
  if (first.code === 0) {
    return { installed: true, detail: first.stdout.trim().split("\n")[0]?.slice(0, 200) ?? "" };
  }

  const probes = (entry.probeDirs ?? []).map(expandHome).filter((d) => existsSync(d));
  if (probes.length > 0) {
    augmentProcessPath(probes);
    const retry = await run(entry.check, { timeoutMs: 15_000 });
    if (retry.code === 0) {
      return { installed: true, detail: retry.stdout.trim().split("\n")[0]?.slice(0, 200) ?? "" };
    }
    return {
      installed: false,
      detail: (retry.stderr || retry.stdout).trim().split("\n")[0]?.slice(0, 200) ?? "Not found",
    };
  }

  return {
    installed: false,
    detail: (first.stderr || first.stdout).trim().split("\n")[0]?.slice(0, 200) || "Not found",
  };
}

/** Full status of every registry tool, plus the tier-0 ids this platform needs. */
export async function getToolchainStatus(): Promise<{
  tools: ToolchainToolStatus[];
  required: string[];
}> {
  const tools = await Promise.all(
    TOOL_REGISTRY.map(async (entry) => {
      const strategy = getStrategy(entry, PLATFORM);
      const { installed, detail } = await detectTool(entry);
      const status: ToolchainToolStatus = {
        id: entry.id,
        label: entry.label,
        why: entry.why,
        tier: entry.tier,
        installed,
        supported: strategy !== undefined && strategy.kind !== "manual",
        ...(detail ? { detail } : {}),
        ...(strategy?.kind === "manual" ? { manualUrl: strategy.url } : {}),
      };
      return status;
    }),
  );
  return { tools, required: getRequiredTier0Ids(PLATFORM) };
}

// ── Strategy runners ─────────────────────────────────────────────────────────

type StrategyContext = {
  entry: ToolRegistryEntry;
  emit: (event: ToolchainEvent) => void;
  runId: string;
};

async function installClt(ctx: StrategyContext): Promise<void> {
  const { emit, runId, entry } = ctx;

  // Already satisfied? (CLT present but git check failed for another reason.)
  const probe = await run("xcode-select -p", { timeoutMs: 10_000 });
  if (probe.code === 0) return;

  emit({
    type: "tool-waiting",
    runId,
    toolId: entry.id,
    message:
      "Your Mac is showing an Apple dialog — click “Install”, then “Agree”. Herman will continue automatically when it finishes.",
  });

  // Trigger Apple's dialog. Errors like "already installed" are fine — the
  // poll below is the source of truth.
  await run("xcode-select --install", { timeoutMs: 15_000 });

  // The dialog install is async (softwareupdate) — poll every 5s, up to 30 min.
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    await sleep(5_000);
    const check = await run("xcode-select -p", { timeoutMs: 10_000 });
    if (check.code === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        "The Apple installer didn't finish in time. Open “Software Update”, finish the Command Line Tools install, then try again.",
      );
    }
  }
}

async function installBrewBootstrap(ctx: StrategyContext): Promise<void> {
  const { emit, runId, entry } = ctx;
  const log = (text: string) => emit({ type: "tool-log", runId, toolId: entry.id, text });

  const isArm = process.arch === "arm64";
  const prefix = isArm ? "/opt/homebrew" : "/usr/local";
  const brewHome = isArm ? prefix : `${prefix}/Homebrew`;
  const brewBin = isArm ? `${prefix}/bin` : `${prefix}/bin`;
  const brewExe = `${brewBin}/brew`;

  // brew present on disk but not on PATH?
  if (existsSync(brewExe)) {
    augmentProcessPath([brewBin]);
    return;
  }

  // One native admin prompt: create the prefix and hand it to the user.
  // (The official brew installer refuses to run as root and prompts
  // interactively — this is Homebrew's documented "untar anywhere" method.)
  const user = process.env.USER ?? (await run("id -un")).stdout.trim();
  const dirs = isArm
    ? [prefix]
    : [
        brewHome,
        `${prefix}/bin`,
        `${prefix}/etc`,
        `${prefix}/include`,
        `${prefix}/lib`,
        `${prefix}/opt`,
        `${prefix}/sbin`,
        `${prefix}/share`,
        `${prefix}/var`,
        `${prefix}/Cellar`,
        `${prefix}/Caskroom`,
        `${prefix}/Frameworks`,
      ];
  const shellCmd = `mkdir -p ${dirs.join(" ")} && chown -R ${user}:admin ${dirs.join(" ")}`;
  const escaped = shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  emit({
    type: "tool-waiting",
    runId,
    toolId: entry.id,
    message:
      "Your Mac is asking for your password — this is the only time Herman needs it. It’s used to create the Homebrew folder.",
  });

  const osa = await run(
    `osascript -e 'do shell script "${escaped}" with administrator privileges with prompt "Herman needs permission to create the Homebrew folder."'`,
    { timeoutMs: 180_000 },
  );
  if (osa.code !== 0) {
    throw new Error(
      "The password step was cancelled or failed. Homebrew can't be installed without it — click Retry when you're ready.",
    );
  }

  // Extract the Homebrew tarball into the prefix (user-scope from here on).
  log("Downloading Homebrew…");
  const tarball = await run(
    `curl -fsSL https://github.com/Homebrew/brew/tarball/HEAD | tar xz --strip-components=1 -C ${brewHome}`,
    { timeoutMs: 10 * 60_000, onLog: log },
  );
  if (tarball.code !== 0) {
    throw new Error("Downloading Homebrew failed. Check your internet connection and retry.");
  }

  if (!isArm) {
    // Intel: /usr/local/bin/brew is a symlink into Homebrew/.
    await run(`ln -sf ${brewHome}/bin/brew ${brewBin}/brew`, { timeoutMs: 10_000 });
  }

  augmentProcessPath([brewBin]);
  invalidateShellEnvCache();

  // Persist for the user's own terminal sessions (idempotent, clearly marked).
  try {
    const zprofile = join(homedir(), ".zprofile");
    const marker = "# Added by Herman (Homebrew)";
    const line = `eval "$(${brewExe} shellenv)"`;
    const existing = existsSync(zprofile) ? await readFile(zprofile, "utf-8") : "";
    if (!existing.includes(line)) {
      await appendFile(zprofile, `\n${marker}\n${line}\n`);
    }
  } catch (error) {
    logger.warning("Failed to persist brew shellenv to ~/.zprofile", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const verify = await run("brew --version", { timeoutMs: 30_000 });
  if (verify.code !== 0) {
    throw new Error("Homebrew was extracted but `brew --version` still fails. Try restarting Herman.");
  }
}

async function installCurlSh(
  ctx: StrategyContext,
  strategy: Extract<ToolStrategy, { kind: "curl-sh" }>,
): Promise<void> {
  const { emit, runId, entry } = ctx;
  const log = (text: string) => emit({ type: "tool-log", runId, toolId: entry.id, text });

  const result = await run(strategy.command, { timeoutMs: 10 * 60_000, onLog: log });
  if (result.code !== 0) {
    throw new Error(
      `The ${entry.label} installer failed. Check your internet connection and retry.`,
    );
  }

  if (entry.probeDirs?.length) {
    augmentProcessPath(entry.probeDirs.map(expandHome));
  }
  invalidateShellEnvCache();
}

async function installBrewFormula(
  ctx: StrategyContext,
  strategy: Extract<ToolStrategy, { kind: "brew-formula" }>,
): Promise<void> {
  const { emit, runId, entry } = ctx;
  const log = (text: string) => emit({ type: "tool-log", runId, toolId: entry.id, text });

  const brew = getToolEntry("brew");
  if (!brew || !(await detectTool(brew)).installed) {
    throw new Error("Homebrew is required but not installed. Run the computer setup first.");
  }

  log(`brew install ${strategy.formula}`);
  const result = await run(`brew install ${strategy.formula}`, {
    timeoutMs: 30 * 60_000,
    onLog: log,
  });
  if (result.code !== 0) {
    throw new Error(`Installing ${entry.label} via Homebrew failed. Retry — brew is usually self-healing.`);
  }

  if (entry.probeDirs?.length) {
    augmentProcessPath(entry.probeDirs.map(expandHome));
  }
}

async function installWinget(
  ctx: StrategyContext,
  strategy: Extract<ToolStrategy, { kind: "winget" }>,
): Promise<void> {
  const { emit, runId, entry } = ctx;
  const log = (text: string) => emit({ type: "tool-log", runId, toolId: entry.id, text });

  const result = await run(
    `winget install --id ${strategy.packageId} -e --accept-source-agreements --accept-package-agreements`,
    { timeoutMs: 20 * 60_000, onLog: log },
  );
  if (result.code !== 0) {
    throw new Error(`Installing ${entry.label} via winget failed.`);
  }
}

// ── Install orchestration (single-flight) ────────────────────────────────────

let activeRun: Promise<{ ok: boolean; results: ToolInstallResult[] }> | null = null;

/**
 * Install the requested tools in dependency order, streaming progress.
 * `customCommand` on an item overrides the registry strategy (manifest
 * `install_cmd` / agent-requested ad-hoc installs).
 */
export function installTools(
  runId: string,
  items: ToolInstallItem[],
  emit: ToolchainEmitter,
): Promise<{ ok: boolean; results: ToolInstallResult[] }> {
  if (activeRun) {
    return Promise.resolve({
      ok: false,
      results: items.map((i) => ({ toolId: i.toolId, ok: false, error: "Another install is already running" })),
    });
  }

  activeRun = doInstallTools(runId, items, emit).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

async function doInstallTools(
  runId: string,
  items: ToolInstallItem[],
  emit: ToolchainEmitter,
): Promise<{ ok: boolean; results: ToolInstallResult[] }> {
  const orderedIds = orderByDependency(items.map((i) => i.toolId));
  const itemById = new Map(items.map((i) => [i.toolId, i]));
  const results: ToolInstallResult[] = [];
  const failed = new Set<string>();

  for (const toolId of orderedIds) {
    const item = itemById.get(toolId)!;
    const entry = getToolEntry(toolId);
    const label = item.label ?? entry?.label ?? toolId;

    // Skip dependents of failed tools.
    const deps = entry?.dependsOn ?? [];
    const failedDep = deps.find((d) => failed.has(d) && orderedIds.includes(d));
    if (failedDep) {
      const error = `Skipped — ${failedDep} failed to install`;
      results.push({ toolId, ok: false, error });
      failed.add(toolId);
      emit({ type: "tool-done", runId, toolId, ok: false, error });
      continue;
    }

    emit({ type: "tool-start", runId, toolId, label });

    try {
      if (item.customCommand) {
        const log = (text: string) => emit({ type: "tool-log", runId, toolId, text });
        const r = await run(item.customCommand, { timeoutMs: 30 * 60_000, onLog: log });
        if (r.code !== 0) throw new Error(`Install command failed for ${label}.`);
      } else {
        if (!entry) throw new Error(`Unknown tool "${toolId}" and no install command provided.`);
        const strategy = getStrategy(entry, PLATFORM);
        if (!strategy) {
          throw new Error(`Herman can't install ${label} automatically on this platform.`);
        }
        if (strategy.kind === "manual") {
          throw new Error(`MANUAL:${strategy.url}`);
        }
        const ctx: StrategyContext = { entry, emit, runId };
        switch (strategy.kind) {
          case "clt":
            await installClt(ctx);
            break;
          case "brew-bootstrap":
            await installBrewBootstrap(ctx);
            break;
          case "curl-sh":
            await installCurlSh(ctx, strategy);
            break;
          case "brew-formula":
            await installBrewFormula(ctx, strategy);
            break;
          case "winget":
            await installWinget(ctx, strategy);
            break;
        }
      }

      // Verify: re-run detection after every install rather than trusting
      // exit codes.
      let verified = true;
      let verifyDetail = "";
      if (entry) {
        const detect = await detectTool(entry);
        verified = detect.installed;
        verifyDetail = detect.detail;
      }

      if (verified) {
        results.push({ toolId, ok: true });
        emit({ type: "tool-done", runId, toolId, ok: true });
      } else {
        const error = `${label} was installed but the check still fails (${verifyDetail}). Try restarting Herman.`;
        results.push({ toolId, ok: false, error });
        failed.add(toolId);
        emit({ type: "tool-done", runId, toolId, ok: false, error });
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = raw.startsWith("MANUAL:")
        ? `Needs a manual install: ${raw.slice("MANUAL:".length)}`
        : raw;
      logger.warning("Tool install failed", { toolId, error: message });
      results.push({ toolId, ok: false, error: message });
      failed.add(toolId);
      emit({ type: "tool-done", runId, toolId, ok: false, error: message });
    }
  }

  const ok = results.every((r) => r.ok);
  const summary = { ok, results };
  emit({ type: "all-done", runId, ok, results });
  return summary;
}
