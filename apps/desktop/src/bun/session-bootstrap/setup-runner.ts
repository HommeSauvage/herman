import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { EnvFile, SetupStep } from "../../shared/herman-manifest.js";
import type { SessionSetupStepSnapshot } from "../../shared/rpc.js";
import { planHash, type ResolvedSetupPlan } from "../setup-plan.js";

const logger = getLogger(["herman-desktop", "session-bootstrap", "setup-runner"]);

/** Built-in step ids (recorded in the stamp alongside manifest steps). */
export const ENV_BASE_STEP_ID = "herman:env-base";
export const ENV_GENERATE_STEP_ID = "herman:env-generate";
/** Synthetic server id for setup output in the preview-context ring. */
export const SETUP_SERVER_ID = "setup";

const STAMP_DIR_NAME = ".herman";
const STAMP_FILE_NAME = "setup.json";
const DEFAULT_STEP_TIMEOUT_S = 300;
const MAX_STEP_TIMEOUT_S = 900;
const MAX_TAIL_CHARS = 8_192;

// ── Public types ───────────────────────────────────────────────────────────

/** Per-session values available to env bindings, interpolation and step env. */
export type SessionBindingValues = {
  tabId: string;
  /** Absolute workspace path (worktree or project root). */
  workspace: string;
  /** Absolute main project root. */
  main: string;
  /** Worktree branch (or the project's current branch for direct sessions). */
  branch: string;
  projectName?: string;
  /** Pre-reserved ports per manifest server id. */
  serverPorts: Record<string, number>;
};

export type SetupRunnerDeps = {
  now?: () => number;
  /** Step list snapshot after every status change (for renderer progress). */
  onSteps?: (steps: SessionSetupStepSnapshot[]) => void;
  /** Every stdout/stderr line produced by setup steps and generate commands. */
  onLine?: (source: "stdout" | "stderr", line: string) => void;
};

export type SetupRunResult =
  | { ok: true; warnings: { stepId: string; error: string }[] }
  | { ok: false; step: string; error: string; output: string };

type StampCompletedEntry = { at: number; durationMs: number; warning?: string };

export type SetupStamp = {
  version: 1;
  planHash: string;
  completed: Record<string, StampCompletedEntry>;
  failed?: { stepId: string; error: string; at: number };
};

// ── Stamp helpers ──────────────────────────────────────────────────────────

function stampPath(workspace: string): string {
  return join(workspace, STAMP_DIR_NAME, STAMP_FILE_NAME);
}

export async function loadSetupStamp(workspace: string): Promise<SetupStamp | undefined> {
  try {
    const raw = await readFile(stampPath(workspace), "utf-8");
    const parsed = JSON.parse(raw) as SetupStamp;
    if (parsed?.version !== 1 || typeof parsed.planHash !== "string") return undefined;
    return { ...parsed, completed: parsed.completed ?? {} };
  } catch {
    return undefined;
  }
}

async function saveSetupStamp(workspace: string, stamp: SetupStamp): Promise<void> {
  const path = stampPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(stamp, null, 2), "utf-8");
}

// ── Env file helpers ───────────────────────────────────────────────────────

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0]!;
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      const inner = trimmed.slice(1, -1);
      return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
    }
  }
  return trimmed;
}

/** Parse KEY=VALUE content (first occurrence wins). */
export function parseEnvContent(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(ENV_LINE_RE);
    if (!match) continue;
    const key = match[1]!;
    if (out.has(key)) continue;
    out.set(key, unquoteEnvValue(match[2] ?? ""));
  }
  return out;
}

function quoteEnvValue(value: string): string {
  if (/[\s#"']/.test(value) || value === "") {
    return JSON.stringify(value);
  }
  return value;
}

/** Merge values into env content, preserving comments and unrelated lines. */
export function mergeEnvContent(existing: string, vars: Record<string, string>): string {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const match = line.match(ENV_LINE_RE);
    if (match) {
      const key = match[1]!;
      if (key in vars) {
        out.push(`${key}=${quoteEnvValue(vars[key]!)}`);
        seen.add(key);
        continue;
      }
    }
    out.push(line);
  }

  for (const [key, value] of Object.entries(vars)) {
    if (seen.has(key)) continue;
    out.push(`${key}=${quoteEnvValue(value)}`);
  }

  const text = out.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Rewrite values that point into the main project root so they reference the
 * workspace instead (absolute DB_DATABASE, log paths, …). Only values that
 * START WITH the main root path are touched; every rewrite is logged.
 */
export function rewriteMainRootPaths(
  content: string,
  mainRoot: string,
  workspace: string,
): string {
  if (!mainRoot || mainRoot === workspace) return content;
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(ENV_LINE_RE);
    if (!match) {
      out.push(line);
      continue;
    }
    const key = match[1]!;
    const rawValue = (match[2] ?? "").trim();
    const unquoted = unquoteEnvValue(rawValue);
    let next: string | undefined;
    if (unquoted === mainRoot) {
      next = workspace;
    } else if (unquoted.startsWith(`${mainRoot}/`)) {
      next = `${workspace}${unquoted.slice(mainRoot.length)}`;
    }
    if (next != null) {
      logger.info("Rewriting main-root path in env file", { key, from: unquoted, to: next });
      out.push(`${key}=${quoteEnvValue(next)}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// ── HERMAN_* env + interpolation ───────────────────────────────────────────

function serverEnvKey(serverId: string): string {
  return serverId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function primaryServerId(plan: ResolvedSetupPlan): string | undefined {
  return (plan.servers.find((s) => s.primary) ?? plan.servers[0])?.id;
}

/** Process env every setup step / generate command runs with. */
export function buildHermanEnv(
  bindings: SessionBindingValues,
  plan: ResolvedSetupPlan,
): Record<string, string> {
  const env: Record<string, string> = {
    HERMAN_WORKSPACE: bindings.workspace,
    HERMAN_MAIN: bindings.main,
    HERMAN_BRANCH: bindings.branch,
    HERMAN_TAB_ID: bindings.tabId,
  };
  if (bindings.projectName) {
    env.HERMAN_PROJECT_NAME = bindings.projectName;
  }
  for (const [id, port] of Object.entries(bindings.serverPorts)) {
    env[`HERMAN_PORT_${serverEnvKey(id)}`] = String(port);
    env[`HERMAN_URL_${serverEnvKey(id)}`] = `http://localhost:${port}`;
  }
  const primaryId = primaryServerId(plan);
  if (primaryId != null && bindings.serverPorts[primaryId] != null) {
    env.HERMAN_PRIMARY_PORT = String(bindings.serverPorts[primaryId]);
    env.HERMAN_PRIMARY_URL = `http://localhost:${bindings.serverPorts[primaryId]}`;
  }
  return env;
}

function sessionValue(
  session: NonNullable<NonNullable<EnvFile["vars"]>[string]["session"]>,
  bindings: SessionBindingValues,
  plan: ResolvedSetupPlan,
): string | undefined {
  switch (session) {
    case "workspace":
      return bindings.workspace;
    case "main":
      return bindings.main;
    case "branch":
      return bindings.branch;
    case "tab_id":
      return bindings.tabId;
    case "primary_port": {
      const id = primaryServerId(plan);
      const port = id != null ? bindings.serverPorts[id] : undefined;
      return port != null ? String(port) : undefined;
    }
    case "primary_url": {
      const id = primaryServerId(plan);
      const port = id != null ? bindings.serverPorts[id] : undefined;
      return port != null ? `http://localhost:${port}` : undefined;
    }
  }
}

/** Replace ${HERMAN_*} placeholders with their computed values. */
export function interpolateHermanVars(
  value: string,
  hermanEnv: Record<string, string>,
): string {
  return value.replace(/\$\{(HERMAN_[A-Z0-9_]+)\}/g, (match, name: string) => {
    return hermanEnv[name] ?? match;
  });
}

// ── Command execution ──────────────────────────────────────────────────────

export type RunCommandResult = {
  exitCode: number;
  timedOut: boolean;
  /** Last ~8KB of combined stdout/stderr for error reporting. */
  tail: string;
};

/**
 * Run a shell command (`sh -c`), streaming lines to `onLine` and capturing a
 * bounded output tail. Absorbs the old `runInstallCommand` (worktree.ts).
 */
export async function runSetupCommand(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onLine?: (source: "stdout" | "stderr", line: string) => void;
}): Promise<RunCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_S * 1000;
  logger.info("Running setup command", { cwd: opts.cwd, command: opts.command });

  const proc = Bun.spawn(["sh", "-c", opts.command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });

  let tail = "";
  const appendTail = (chunk: string) => {
    tail = (tail + chunk).slice(-MAX_TAIL_CHARS);
  };

  const drain = async (
    stream: ReadableStream<Uint8Array> | null,
    source: "stdout" | "stderr",
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.replace(/\r$/, "");
          if (trimmed.length === 0) continue;
          opts.onLine?.(source, trimmed);
          appendTail(trimmed + "\n");
        }
      }
      const rest = buffer.replace(/\r$/, "").trimEnd();
      if (rest.trim().length > 0) {
        opts.onLine?.(source, rest);
        appendTail(rest + "\n");
      }
    } catch {
      // Ignore read errors on process exit.
    }
  };

  const drains = Promise.all([drain(proc.stdout, "stdout"), drain(proc.stderr, "stderr")]);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let exitCode: number;
  try {
    exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } catch {
    proc.kill();
    await proc.exited.catch(() => -1);
    exitCode = -1;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
  await drains;

  logger.info("Setup command finished", { cwd: opts.cwd, exitCode, timedOut });
  return { exitCode, timedOut, tail };
}

// ── The runner ─────────────────────────────────────────────────────────────

type StepStatus = SessionSetupStepSnapshot["status"];

/**
 * Executes the resolved setup plan in a fresh (or interrupted) workspace:
 *   phase 1 — env files: source → rewrite paths → literals + session bindings
 *   phase 2 — ordered manifest setup steps (skip rules + stamp)
 *   phase 3 — env generate: run `generate:` commands for still-missing vars
 * Progress is stamped in `<workspace>/.herman/setup.json` so interrupted
 * setups resume as repair, not reinstall.
 */
export class WorkspaceSetupRunner {
  constructor(private readonly deps: SetupRunnerDeps = {}) {}

  async run(ctx: {
    workspace: string;
    mainRoot: string;
    plan: ResolvedSetupPlan;
    bindings: SessionBindingValues;
  }): Promise<SetupRunResult> {
    const { workspace, plan } = ctx;
    const now = this.deps.now ?? (() => Date.now());
    const hash = planHash(plan);
    const stamp = await loadSetupStamp(workspace);
    if (stamp && stamp.planHash !== hash) {
      logger.info("Setup plan changed since last run; re-running all steps", {
        workspace,
        previousHash: stamp.planHash,
        nextHash: hash,
      });
    }
    const completed: Record<string, StampCompletedEntry> =
      stamp?.planHash === hash ? { ...stamp.completed } : {};
    const warnings: { stepId: string; error: string }[] = [];

    // A previously-failed step gets retried: clear the marker up front.
    const stepStates = new Map<string, StepStatus>();
    const stepOrder: { id: string; label: string }[] = [
      { id: ENV_BASE_STEP_ID, label: "Preparing environment files" },
      ...plan.setupSteps.map((s) => ({ id: s.id, label: s.label })),
      { id: ENV_GENERATE_STEP_ID, label: "Generating secrets" },
    ];
    for (const step of stepOrder) {
      stepStates.set(step.id, completed[step.id] ? "skipped" : "pending");
    }

    const emitSteps = () => {
      this.deps.onSteps?.(
        stepOrder.map((s) => ({ id: s.id, label: s.label, status: stepStates.get(s.id)! })),
      );
    };

    const persistStamp = async () => {
      await saveSetupStamp(workspace, { version: 1, planHash: hash, completed });
    };

    const fail = async (
      stepId: string,
      error: string,
      output: string,
    ): Promise<SetupRunResult> => {
      stepStates.set(stepId, "failed");
      emitSteps();
      await saveSetupStamp(workspace, {
        version: 1,
        planHash: hash,
        completed,
        failed: { stepId, error, at: now() },
      });
      return { ok: false, step: stepId, error, output };
    };

    emitSteps();

    // ── Phase 1 — env-base ──
    // Stamped env-base is trusted only while every declared env file still
    // exists; a deleted file means full re-provisioning (repair).
    const envFilesMissing = plan.envFiles.some((f) => !existsSync(join(workspace, f.path)));
    const envBaseStamped = Boolean(completed[ENV_BASE_STEP_ID]) && !envFilesMissing;
    if (envFilesMissing && completed[ENV_BASE_STEP_ID]) {
      logger.info("Declared env file missing; re-provisioning env-base", {
        workspace,
        missing: plan.envFiles.filter((f) => !existsSync(join(workspace, f.path))).map((f) => f.path),
      });
      delete completed[ENV_BASE_STEP_ID];
    }
    stepStates.set(ENV_BASE_STEP_ID, "running");
    emitSteps();
    const envBaseStart = now();
    try {
      // On resume, phase 1 only re-applies Herman-owned session bindings
      // (ports may have been re-reserved) — never re-copies the main file.
      await this.provisionEnvBase(ctx, { sessionBindingsOnly: envBaseStamped });
      completed[ENV_BASE_STEP_ID] = { at: now(), durationMs: now() - envBaseStart };
      stepStates.set(ENV_BASE_STEP_ID, envBaseStamped ? "skipped" : "done");
      emitSteps();
      await persistStamp();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(ENV_BASE_STEP_ID, `Failed to prepare environment files: ${message}`, "");
    }

    // ── Phase 2 — manifest setup steps ──
    for (const step of plan.setupSteps) {
      // Completed step whose skip_if path vanished → re-run (repair).
      if (completed[step.id] && step.skip_if && !existsSync(join(workspace, step.skip_if))) {
        logger.info("skip_if path vanished for completed step; re-running", {
          workspace,
          step: step.id,
          skipIf: step.skip_if,
        });
        delete completed[step.id];
      }
      if (completed[step.id]) {
        stepStates.set(step.id, completed[step.id]!.warning ? "warning" : "skipped");
        emitSteps();
        continue;
      }
      if (this.stepSkippedByRule(ctx, step)) {
        stepStates.set(step.id, "skipped");
        completed[step.id] = { at: now(), durationMs: 0 };
        emitSteps();
        await persistStamp();
        continue;
      }

      stepStates.set(step.id, "running");
      emitSteps();
      const startedAt = now();
      const timeoutS = Math.min(step.timeout ?? DEFAULT_STEP_TIMEOUT_S, MAX_STEP_TIMEOUT_S);
      const result = await runSetupCommand({
        command: step.run,
        cwd: workspace,
        env: buildHermanEnv(ctx.bindings, plan),
        timeoutMs: timeoutS * 1000,
        onLine: this.deps.onLine,
      });
      const durationMs = now() - startedAt;

      if (result.exitCode === 0) {
        completed[step.id] = { at: now(), durationMs };
        stepStates.set(step.id, "done");
        emitSteps();
        await persistStamp();
        continue;
      }

      const error = result.timedOut
        ? `${step.label} timed out after ${timeoutS}s`
        : `${step.label} failed (exit ${result.exitCode})`;
      if (step.optional) {
        logger.warning("Optional setup step failed; continuing", {
          workspace,
          step: step.id,
          error,
        });
        warnings.push({ stepId: step.id, error });
        completed[step.id] = { at: now(), durationMs, warning: error };
        stepStates.set(step.id, "warning");
        emitSteps();
        await persistStamp();
        continue;
      }
      return fail(step.id, error, result.tail);
    }

    // ── Phase 3 — env-generate ──
    stepStates.set(ENV_GENERATE_STEP_ID, "running");
    emitSteps();
    const genStart = now();
    const genResult = await this.provisionEnvGenerate(ctx, warnings);
    completed[ENV_GENERATE_STEP_ID] = { at: now(), durationMs: now() - genStart };
    if (genResult.ok) {
      stepStates.set(ENV_GENERATE_STEP_ID, genResult.hadWarnings ? "warning" : "done");
      emitSteps();
      await persistStamp();
    } else {
      return fail(ENV_GENERATE_STEP_ID, genResult.error, genResult.output);
    }

    return { ok: true, warnings };
  }

  /**
   * Phase 1: resolve each env file's source content (main → example →
   * existing → empty), rewrite main-root paths, then apply literal values and
   * session bindings per the file's merge policy. Session bindings are always
   * force-applied (they are Herman-owned per-session values).
   */
  private async provisionEnvBase(
    ctx: { workspace: string; mainRoot: string; plan: ResolvedSetupPlan; bindings: SessionBindingValues },
    opts: { sessionBindingsOnly: boolean },
  ): Promise<void> {
    const { workspace, mainRoot, plan, bindings } = ctx;
    const hermanEnv = buildHermanEnv(bindings, plan);

    for (const file of plan.envFiles) {
      const absPath = join(workspace, file.path);
      let content: string;
      if (opts.sessionBindingsOnly) {
        content = (await readFileSafe(absPath)) ?? "";
      } else {
        content = await this.resolveEnvSource(file, workspace, mainRoot);
        if (file.rewrite_paths !== false) {
          content = rewriteMainRootPaths(content, mainRoot, workspace);
        }
      }

      const existing = parseEnvContent(content);
      const merge = file.merge ?? "missing_only";
      const updates: Record<string, string> = {};

      for (const [key, varDef] of Object.entries(file.vars ?? {})) {
        if (varDef.session) {
          const value = sessionValue(varDef.session, bindings, plan);
          if (value != null && existing.get(key) !== value) {
            updates[key] = value;
          }
          continue;
        }
        if (opts.sessionBindingsOnly) continue;
        if (varDef.generate) continue; // phase 3
        if (varDef.value == null) continue;
        const present = (existing.get(key) ?? "").trim() !== "";
        if (merge === "force" || !present) {
          updates[key] = interpolateHermanVars(varDef.value, hermanEnv);
        }
      }

      const shouldWrite =
        Object.keys(updates).length > 0 || (!opts.sessionBindingsOnly && !existsSync(absPath));
      if (!shouldWrite) continue;
      const next = mergeEnvContent(content, updates);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, next, "utf-8");
      logger.info("Wrote env file", {
        workspace,
        path: file.path,
        keys: Object.keys(updates),
        sessionBindingsOnly: opts.sessionBindingsOnly,
      });
    }
  }

  private async resolveEnvSource(
    file: EnvFile,
    workspace: string,
    mainRoot: string,
  ): Promise<string> {
    // 1. Copy from the main project (source of truth — wizard-collected
    //    secrets ride along into every worktree).
    if (file.from_main !== false && mainRoot !== workspace) {
      const mainFile = join(mainRoot, file.path);
      const content = await readFileSafe(mainFile);
      if (content != null) return content;
    }
    // 2. Copy from the declared example inside the workspace.
    if (file.from_example) {
      const example = await readFileSafe(join(workspace, file.from_example));
      if (example != null) return example;
    }
    // 3. Keep what the fresh copy already has (e.g. a tracked env file).
    const existing = await readFileSafe(join(workspace, file.path));
    if (existing != null) return existing;
    // 4. Create empty.
    return "";
  }

  /**
   * Phase 3: run `generate:` commands for vars still missing/empty after
   * setup steps (toolchain-dependent generators need phase 2 first).
   */
  private async provisionEnvGenerate(
    ctx: { workspace: string; plan: ResolvedSetupPlan; bindings: SessionBindingValues },
    warnings: { stepId: string; error: string }[],
  ): Promise<{ ok: true; hadWarnings: boolean } | { ok: false; error: string; output: string }> {
    const { workspace, plan } = ctx;
    let hadWarnings = false;

    for (const file of plan.envFiles) {
      const vars = file.vars ?? {};
      const generatable = Object.entries(vars).filter(([, v]) => v.generate);
      if (generatable.length === 0) continue;

      const absPath = join(workspace, file.path);
      const content = (await readFileSafe(absPath)) ?? "";
      const existing = parseEnvContent(content);
      const updates: Record<string, string> = {};

      for (const [key, varDef] of Object.entries(vars)) {
        if (!varDef.generate) continue;
        const present = (existing.get(key) ?? "").trim() !== "";
        if (present) continue;
        const result = await runSetupCommand({
          command: varDef.generate,
          cwd: workspace,
          env: buildHermanEnv(ctx.bindings, plan),
          onLine: this.deps.onLine,
        });
        if (result.exitCode !== 0 || result.tail.trim().length === 0) {
          const error = `Failed to generate ${key} (exit ${result.exitCode}): ${varDef.generate}`;
          if (varDef.required) {
            return { ok: false, error, output: result.tail };
          }
          logger.warning("Env generate failed for optional var; continuing", {
            workspace,
            key,
            error,
          });
          warnings.push({ stepId: ENV_GENERATE_STEP_ID, error });
          hadWarnings = true;
          continue;
        }
        // stdout of the generate command is the value (last non-empty line).
        const lines = result.tail.split("\n").map((l) => l.trim()).filter(Boolean);
        updates[key] = lines[lines.length - 1] ?? "";
      }

      if (Object.keys(updates).length > 0) {
        const next = mergeEnvContent(content, updates);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, next, "utf-8");
        logger.info("Wrote generated env values", { workspace, path: file.path, keys: Object.keys(updates) });
      }
    }

    return { ok: true, hadWarnings };
  }

  private stepSkippedByRule(
    ctx: { workspace: string; plan: ResolvedSetupPlan },
    step: SetupStep,
  ): boolean {
    if (step.skip_if && existsSync(join(ctx.workspace, step.skip_if))) {
      return true;
    }
    if (step.skip_if_env) {
      const envPath = step.env_file ?? ctx.plan.envFiles[0]?.path;
      if (envPath) {
        // Cheap sync read via Bun.file would be async; the file is small and
        // this runs once per step — read it with readFileSync semantics.
        const content = readFileSyncSafe(join(ctx.workspace, envPath));
        if (content != null) {
          const value = parseEnvContent(content).get(step.skip_if_env);
          if (value != null && value.trim() !== "") return true;
        }
      }
    }
    return false;
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}
