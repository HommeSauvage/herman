import { getLogger } from "@logtape/logtape";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentEvent, WizardSessionEvent } from "../shared/agent-protocol.js";
import { tryParseWizardRequest } from "../shared/agent-protocol.js";
import { encodeWizardAnswers } from "../shared/wizard-protocol.js";
import type { ResolvedManifest } from "../shared/herman-manifest.js";
import { AgentBridge, type AgentBridgeState } from "./agent-bridge.js";
import { resolveWizardExtensionPath } from "./agent-config-sync.js";
import { resolveTemplateManifest } from "./template-registry.js";

const logger = getLogger(["herman-desktop", "wizard-session"]);

/** Plan file written by the planning session; coding/QA sessions consume it. */
export const WIZARD_PLAN_FILENAME = "HERMAN_PLAN.md";

/** Default setup goal when the template omits `setup_goal`. */
export const DEFAULT_SETUP_GOAL = "The project should start without errors.";

/** Wire value when the host rejects ask outside planning (extension understands this). */
export const WIZARD_ASK_REJECTED_SENTINEL = "__herman_ask_rejected__";

// ── Retry constants ──────────────────────────────────────────────────────────

/** Maximum number of auto-retry attempts before giving up. */
const MAX_RETRIES = 20;
/** Base delay in ms for the first retry (doubles each attempt). */
const BASE_DELAY_MS = 2_000;
/** Cap on retry delay so the total span stays near 5 minutes with 20 retries. */
const MAX_DELAY_MS = 15_000;

export type WizardPhase = "planning" | "coding" | "qa";

/** Default parent directory for user projects (matches create-project.ts). */
function projectsDir(): string {
  return join(homedir(), "Herman");
}

/** Unique wizard session id (also used as the isolated agent-dir/tab id). */
function createWizardSessionId(): string {
  return `wizard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a "provider/modelId" string for the agent set_model command. */
export function parseWizardModelRef(modelId: string): { provider: string; modelId: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { provider: "herman", modelId };
  return { provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
}

export type WizardSessionOptions = {
  /** Emit a wizard event to the renderer over the dedicated wizard channel. */
  emit: (event: WizardSessionEvent) => void;
};

/**
 * A detached agent session that runs the Rookie wizard as three sequential
 * pi sessions (planning → coding → QA), invisible to the user. Events go to
 * the renderer through the `wizardEvent` channel. On completion the caller
 * opens a fresh project tab (no session resume).
 */
export class WizardSession {
  readonly id: string;
  private bridge: AgentBridge | undefined;
  private manifest: ResolvedManifest | undefined;
  /** The editor extension_ui_request id awaiting a wizard answer. */
  private pendingRequestId: string | undefined;
  /** Set when planning completes (project cloned + plan written). */
  private projectPath: string | undefined;
  private planPath: string | undefined;
  /** Final message / summary from the coding session, passed to QA. */
  private codingSummary: string | undefined;
  /** Last assistant narration in the current phase (fallback summary). */
  private lastAssistantText: string | undefined;
  private phase: WizardPhase = "planning";
  /** True once the current phase has signaled completion (avoid retry on agent_end). */
  private phaseSignaledComplete = false;
  /**
   * Incremented on every bridge start/stop so events from a dying bridge are
   * ignored after a phase advance or retry.
   */
  private bridgeGeneration = 0;
  private cancelled = false;
  private finished = false;
  /** Preferred model id ("provider/modelId") for this wizard session. */
  private preferredModel: string | undefined;
  /** Resolved when the agent emits its first models_sync during startup. */
  private modelsReady: { resolve: () => void; promise: Promise<void> } | undefined;
  // ── Retry state ──────────────────────────────────────────────────────────
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pi session id captured from the first bridge start, passed to retries for context preservation. */
  private capturedPiSessionId: string | undefined;
  private templateId: string | undefined;
  private description: string | undefined;

  constructor(private opts: WizardSessionOptions) {
    this.id = createWizardSessionId();
  }

  async start(templateId: string, description: string, modelId?: string): Promise<void> {
    this.templateId = templateId;
    this.description = description;
    if (modelId) this.preferredModel = modelId;

    const manifest = await resolveTemplateManifest(templateId);
    this.manifest = manifest;

    await mkdir(projectsDir(), { recursive: true });

    this.phase = "planning";
    await this.startPhaseAttempt();

    logger.info("Wizard session started", {
      id: this.id,
      templateId,
      modelId: this.preferredModel,
      phase: this.phase,
    });
  }

  /**
   * Update the preferred model and apply it on the live bridge if running.
   * Mid-run changes take effect on the next LLM turn.
   */
  setModel(modelId: string): void {
    this.preferredModel = modelId;
    void this.applyPreferredModel().catch((error) => {
      logger.warning("Wizard setModel failed", { id: this.id, modelId, error });
    });
  }

  /**
   * Start (or restart) the agent bridge for the current phase and send that
   * phase's prompts. Retries re-run the same phase with a fresh pi session.
   */
  private async startPhaseAttempt(): Promise<void> {
    if (this.cancelled || this.finished) return;

    // Invalidate any in-flight events from the previous bridge before stop.
    this.bridgeGeneration++;
    const generation = this.bridgeGeneration;

    if (this.bridge) {
      await this.bridge.stop().catch(() => undefined);
      this.bridge = undefined;
    }

    if (this.cancelled || this.finished || generation !== this.bridgeGeneration) return;

    this.phaseSignaledComplete = false;
    this.lastAssistantText = undefined;

    const manifest = this.manifest;
    const description = this.description;
    if (!manifest || !description) {
      this.end("Cannot start wizard: missing configuration");
      return;
    }

    if ((this.phase === "coding" || this.phase === "qa") && !this.projectPath) {
      this.end("Cannot start coding/QA phase: missing project path");
      return;
    }

    let modelsResolved = false;
    let resolveModels: (() => void) | undefined;
    const modelsPromise = new Promise<void>((resolve) => {
      resolveModels = () => {
        if (modelsResolved) return;
        modelsResolved = true;
        resolve();
      };
    });
    this.modelsReady = { resolve: () => resolveModels?.(), promise: modelsPromise };

    const bridge = new AgentBridge(
      this.id,
      () => {}, // no renderer tab channel for a detached wizard session
      (_tabId, state: AgentBridgeState, stderr?: string) => {
        if (generation !== this.bridgeGeneration) return;
        if (state === "running") return;
        if (state === "crashed") {
          logger.warning("Wizard agent crashed", {
            id: this.id,
            stderr,
            retryCount: this.retryCount,
            phase: this.phase,
            generation,
          });
          if (!this.finished && !this.phaseSignaledComplete) {
            this.scheduleRetry(`Agent crashed${stderr ? `: ${stderr}` : ""}`);
          }
        }
      },
      (_tabId, event: AgentEvent) => {
        if (generation !== this.bridgeGeneration) return;
        this.onEvent(event);
      },
    );
    this.bridge = bridge;

    const cwd = this.phase === "planning" ? projectsDir() : (this.projectPath as string);
    const wizardExtensions = resolveWizardExtensionPath();
    await bridge.start(cwd, {
      mode: "rookie",
      extensions: wizardExtensions,
      // Resume the same pi session across retries so context (plan progress,
      // tool calls, user answers) is preserved.
      piSessionId: this.capturedPiSessionId,
    });

    if (this.cancelled || this.finished || generation !== this.bridgeGeneration) return;

    // Capture the pi session id on the first attempt so retries resume the
    // same conversation instead of starting fresh.
    if (!this.capturedPiSessionId) {
      try {
        const state = await bridge.sendCommand({ type: "get_state" });
        if (state.success) {
          const data = state.data as Record<string, unknown> | undefined;
          if (data && typeof data.sessionId === "string" && data.sessionId) {
            this.capturedPiSessionId = data.sessionId;
          }
        }
      } catch {
        // Non-fatal; retries will just start fresh.
      }
    }

    // Enable pi's built-in auto-retry so transient API errors (proxied
    // through the Herman server) are handled inside the agent without a
    // process restart. The agent removes the error message, waits with
    // exponential backoff, and re-continues.
    await bridge.sendCommand({ type: "set_auto_retry", enabled: true }).catch(() => undefined);

    // Wait briefly for models_sync so we can override the auto-selected default
    // before sending the prompt. Fall through on timeout so we don't hang.
    await Promise.race([modelsPromise, delay(5_000)]);

    if (this.cancelled || this.finished || generation !== this.bridgeGeneration) return;

    await this.applyPreferredModel();

    try {
      await this.sendPhasePrompts(bridge, manifest, description);
    } catch (error) {
      if (generation !== this.bridgeGeneration || this.cancelled || this.finished) return;
      const msg = error instanceof Error ? error.message : String(error);
      logger.warning("Wizard phase start prompt failed", {
        id: this.id,
        error: msg,
        retryCount: this.retryCount,
        phase: this.phase,
      });
      this.scheduleRetry(msg);
    }
  }

  private async sendPhasePrompts(
    bridge: AgentBridge,
    manifest: ResolvedManifest,
    _description: string,
  ): Promise<void> {
    if (this.phase === "planning") {
      const prompt = buildPlanningPrompt(manifest, this.description ?? "");
      await bridge.sendCommand({ type: "prompt", message: prompt });
      return;
    }

    if (this.phase === "coding") {
      const projectPath = this.projectPath as string;
      const planPath = this.planPath ?? join(projectPath, WIZARD_PLAN_FILENAME);
      // Single prompt: context framing is folded into /goal so an intermediate
      // agent_end cannot spuriously retry the phase.
      await bridge.sendCommand({
        type: "prompt",
        message: `/goal ${buildCodingGoal(manifest, projectPath, planPath)}`,
      });
      return;
    }

    // qa
    const projectPath = this.projectPath as string;
    const planPath = this.planPath ?? join(projectPath, WIZARD_PLAN_FILENAME);
    await bridge.sendCommand({
      type: "prompt",
      message: `/goal ${buildQaGoal(projectPath, planPath, this.codingSummary ?? "(no summary)")}`,
    });
  }

  private async applyPreferredModel(): Promise<void> {
    const modelId = this.preferredModel;
    if (!modelId || !this.bridge) return;
    const { provider, modelId: id } = parseWizardModelRef(modelId);
    try {
      await this.bridge.sendCommand({ type: "set_model", provider, modelId: id });
      logger.info("Wizard model applied", { id: this.id, modelId, phase: this.phase });
    } catch (error) {
      logger.warning("Failed to apply wizard model", { id: this.id, modelId, error });
    }
  }

  /**
   * Schedule a retry with exponential backoff for the current phase.
   * After MAX_RETRIES, gives up and calls `end()` with the last error.
   */
  private scheduleRetry(reason: string): void {
    if (this.cancelled || this.finished || this.phaseSignaledComplete) return;

    // A retry is already pending — don't double-count or reset the timer.
    // Multiple error paths (crash callback + sendPhasePrompts failure) can
    // fire for the same underlying failure.
    if (this.retryTimer) return;

    if (this.retryCount >= MAX_RETRIES) {
      this.end(`Setup failed after ${MAX_RETRIES} attempts: ${reason}`);
      return;
    }

    this.retryCount++;
    const delayMs = Math.min(BASE_DELAY_MS * 2 ** (this.retryCount - 1), MAX_DELAY_MS);

    logger.info("Scheduling wizard retry", {
      id: this.id,
      attempt: this.retryCount,
      maxRetries: MAX_RETRIES,
      delayMs,
      reason,
      phase: this.phase,
    });

    this.emit({
      type: "wizard_retrying",
      wizardSessionId: this.id,
      attempt: this.retryCount,
      maxRetries: MAX_RETRIES,
      error: reason,
    });

    // Drop any prior timer so overlapping errors cannot stack restarts.
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.startPhaseAttempt().catch((error) => {
        logger.error("Wizard retry attempt failed", { id: this.id, error });
        this.scheduleRetry(error instanceof Error ? error.message : String(error));
      });
    }, delayMs);
  }

  /** Advance to the next phase with a fresh retry budget and pi session. */
  private advanceToPhase(next: WizardPhase): void {
    this.phase = next;
    this.retryCount = 0;
    this.capturedPiSessionId = undefined;
    this.clearRetryTimer();
    // Keep phaseSignaledComplete true until the new bridge is live so dying
    // events from the previous bridge cannot schedule a retry on the new phase.
    // startPhaseAttempt resets it after invalidating bridgeGeneration.
    logger.info("Wizard advancing phase", { id: this.id, phase: next });
    void this.startPhaseAttempt().catch((error) => {
      logger.error("Wizard phase start failed", { id: this.id, phase: next, error });
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
    });
  }

  /** Respond to a pending herman_wizard_ask question batch. */
  respond(requestId: string, answers: { id: string; value: string; values?: string[] }[]): void {
    if (!this.bridge) return;
    if (this.pendingRequestId !== requestId) {
      logger.warning("Wizard respond for unknown/stale request id", {
        id: this.id,
        requestId,
        pending: this.pendingRequestId,
      });
      return;
    }
    this.pendingRequestId = undefined;
    this.bridge.sendExtensionUiResponse(requestId, {
      value: encodeWizardAnswers({ answers, cancelled: false }),
    });
  }

  /** Cancel the wizard: cancel any pending request, stop the agent, clean up. */
  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.bridgeGeneration++;
    this.clearRetryTimer();
    logger.info("Cancelling wizard session", { id: this.id, projectPath: this.projectPath });

    if (this.bridge && this.pendingRequestId) {
      try {
        this.bridge.sendExtensionUiResponse(this.pendingRequestId, { cancelled: true });
      } catch {
        // ignore — agent may already be gone
      }
      this.pendingRequestId = undefined;
    }

    await this.bridge?.stop().catch(() => undefined);
    this.bridge?.cleanupPersistentState();

    // Delete the cloned project dir if the agent created one before cancellation.
    if (this.projectPath && existsSync(this.projectPath)) {
      await rm(this.projectPath, { recursive: true, force: true }).catch(() => undefined);
      logger.info("Deleted partial project dir on cancel", { projectPath: this.projectPath });
    }

    this.end("Wizard cancelled");
  }

  /** The project path reported by planning completion (for handoff). */
  getProjectPath(): string | undefined {
    return this.projectPath;
  }

  /** Stop the agent without cleanup (used after a successful handoff). */
  async detach(): Promise<void> {
    this.finished = true;
    this.bridgeGeneration++;
    this.clearRetryTimer();
    await this.bridge?.stop().catch(() => undefined);
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  private onEvent(event: AgentEvent): void {
    if (this.finished) return;

    // Resolve the models-ready wait once the agent advertises its model list,
    // and forward the list to the shared UI catalog.
    if (event.type === "models_sync" || event.type === "herman/models_sync") {
      this.modelsReady?.resolve();
      this.emit({
        type: "wizard_models",
        wizardSessionId: this.id,
        models: event.models,
        ...(event.currentModel ? { currentModel: event.currentModel } : {}),
      });
      return;
    }

    // 1. herman_wizard_ask → editor request carrying a wizard envelope.
    const wizardReq = tryParseWizardRequest(event);
    if (wizardReq) {
      // Questions are planning-only. Auto-reject outside planning so coding/QA
      // never surfaces the question UI or hangs on an unanswered editor request.
      if (this.phase !== "planning") {
        logger.warning("Rejecting herman_wizard_ask outside planning", {
          id: this.id,
          phase: this.phase,
        });
        this.bridge?.sendExtensionUiResponse(wizardReq.requestId, {
          value: JSON.stringify({
            [WIZARD_ASK_REJECTED_SENTINEL]: true,
            answers: [],
            cancelled: false,
          }),
        });
        return;
      }
      this.pendingRequestId = wizardReq.requestId;
      this.emit({
        type: "wizard_request",
        wizardSessionId: this.id,
        requestId: wizardReq.requestId,
        envelope: wizardReq.envelope,
      });
      return;
    }

    // 2. Planning complete → start coding phase.
    if (event.type === "tool_execution_start" && event.toolName === "herman_complete_planning") {
      if (this.phase !== "planning" || this.phaseSignaledComplete) return;
      const args = event.args as Record<string, unknown> | undefined;
      const projectPath = typeof args?.projectPath === "string" ? args.projectPath.trim() : "";
      const planPathArg = typeof args?.planPath === "string" ? args.planPath.trim() : "";
      const planPath = planPathArg || (projectPath ? join(projectPath, WIZARD_PLAN_FILENAME) : "");

      const validationError = validatePlanningOutputs(projectPath, planPath);
      if (validationError) {
        logger.warning("herman_complete_planning rejected", {
          id: this.id,
          projectPath,
          planPath,
          error: validationError,
        });
        this.emit({
          type: "wizard_progress",
          wizardSessionId: this.id,
          text: validationError,
        });
        // Do not advance — wait for a correct completion or agent_end → retry.
        return;
      }

      this.projectPath = projectPath;
      this.planPath = planPath;
      this.phaseSignaledComplete = true;
      this.clearRetryTimer();
      this.emit({
        type: "wizard_progress",
        wizardSessionId: this.id,
        text: "Plan ready — starting build…",
      });
      this.advanceToPhase("coding");
      return;
    }

    // 3. herman_complete_wizard — coding → QA, or QA → done.
    if (event.type === "tool_execution_start" && event.toolName === "herman_complete_wizard") {
      if (this.phaseSignaledComplete) return;
      const args = event.args as Record<string, unknown> | undefined;
      const projectPath = typeof args?.projectPath === "string" ? args.projectPath : undefined;
      const summary = typeof args?.summary === "string" ? args.summary : undefined;
      if (projectPath) this.projectPath = projectPath;

      if (this.phase === "coding") {
        this.phaseSignaledComplete = true;
        this.clearRetryTimer();
        this.codingSummary = (summary?.trim() || this.lastAssistantText || "").trim() || undefined;
        this.emit({
          type: "wizard_progress",
          wizardSessionId: this.id,
          text: "Build complete — verifying…",
        });
        this.advanceToPhase("qa");
        return;
      }

      if (this.phase === "qa") {
        this.phaseSignaledComplete = true;
        this.clearRetryTimer();
        const finalPath = this.projectPath ?? projectPath ?? "";
        this.emit({
          type: "wizard_complete",
          wizardSessionId: this.id,
          projectPath: finalPath,
          ...(summary ? { summary } : {}),
        });
        // Stop the agent: the done screen no longer needs a live bridge.
        this.finished = true;
        this.bridgeGeneration++;
        void this.bridge?.stop().catch(() => undefined);
        return;
      }

      return;
    }

    // 4. Progress: assistant narration + tool activity (skip wizard tools).
    if (event.type === "message_end") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        const text = extractText(msg);
        if (text.trim()) {
          this.lastAssistantText = text.trim();
          this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: text.trim() });
        }
      }
      return;
    }
    if (
      event.type === "tool_execution_start" &&
      event.toolName !== "herman_wizard_ask" &&
      event.toolName !== "herman_complete_planning" &&
      event.toolName !== "herman_complete_wizard"
    ) {
      const label = formatToolActivity(event.toolName, event.args);
      if (label) {
        this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: label });
      }
      return;
    }

    // 5. Proxy / API errors — surfaced early by the herman extension so the
    //    UI can show progress. Pi's auto-retry handles recovery internally.
    if (event.type === "herman/agent_proxy_error") {
      logger.warning("Wizard proxy error", { id: this.id, code: event.code, error: event.error });
      this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: event.error });
      return;
    }

    // 6. Terminal / error events — schedule retry instead of immediately ending.
    //    API-level errors (stopReason: "error") are handled by pi's auto-retry;
    //    only schedule a retry for process-level failures.
    if (event.type === "agent_error") {
      this.scheduleRetry(event.error);
      return;
    }
    if (event.type === "agent_end" || event.type === "agent_complete") {
      if (!this.phaseSignaledComplete && !this.cancelled) {
        this.scheduleRetry(`Agent ended before completing ${this.phase} phase`);
      }
      return;
    }
  }

  private end(error?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: "wizard_end", wizardSessionId: this.id, ...(error ? { error } : {}) });
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private emit(event: WizardSessionEvent): void {
    try {
      this.opts.emit(event);
    } catch (error) {
      logger.warning("Wizard emit failed", { id: this.id, error });
    }
  }
}

/**
 * Manages active wizard sessions by id. Bun RPC handlers delegate here.
 */
export class WizardSessionManager {
  private sessions = new Map<string, WizardSession>();

  constructor(private emit: (event: WizardSessionEvent) => void) {}

  async start(templateId: string, description: string, modelId?: string): Promise<string> {
    const session = new WizardSession({ emit: this.emit });
    this.sessions.set(session.id, session);
    // Start asynchronously so the RPC returns the id immediately; events flow
    // over the wizard channel. Errors surface as wizard_end.
    void session.start(templateId, description, modelId).catch((error) => {
      logger.error("Wizard start failed", { id: session.id, error });
      try {
        this.emit({
          type: "wizard_end",
          wizardSessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // ignore
      }
    });
    return session.id;
  }

  setModel(wizardSessionId: string, modelId: string): void {
    this.sessions.get(wizardSessionId)?.setModel(modelId);
  }

  respond(wizardSessionId: string, requestId: string, answers: { id: string; value: string; values?: string[] }[]): void {
    this.sessions.get(wizardSessionId)?.respond(requestId, answers);
  }

  async cancel(wizardSessionId: string): Promise<void> {
    const session = this.sessions.get(wizardSessionId);
    if (!session) return;
    await session.cancel();
    this.sessions.delete(wizardSessionId);
  }

  get(wizardSessionId: string): WizardSession | undefined {
    return this.sessions.get(wizardSessionId);
  }

  /** Remove a completed/cancelled session from the registry. */
  remove(wizardSessionId: string): void {
    this.sessions.delete(wizardSessionId);
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/**
 * Session 1 — planning: ask questions, clone, discover from docs, write plan.
 * Does not install, migrate, or customize the project.
 */
export function buildPlanningPrompt(manifest: ResolvedManifest, description: string): string {
  const fm = manifest.frontmatter;
  const source = fm.source;
  const repoLine = source?.repo
    ? `Source repo: ${source.repo}${source.ref ? ` (ref: ${source.ref})` : ""}`
    : "(no source repo declared)";

  const envSection = formatEnvForPrompt(fm.env);
  const reqSection = formatRequirementsForPrompt(fm.requirements);

  return [
    "You are running in HERMAN WIZARD MODE (planning phase) for a non-technical user.",
    "Do not write chat-style explanations — work autonomously and report progress only through tool calls.",
    "",
    "## Your job",
    "1. Ask the user what you still need via `herman_wizard_ask` (project name is collected on the first call).",
    "2. Clone the template source into ~/Herman/<projectName>.",
    "3. Read the cloned repo's docs (README, AGENTS.md, and other markdown) to understand the project.",
    "4. If anything is still unclear, ask follow-up questions via `herman_wizard_ask`.",
    "5. Write a complete plan to `HERMAN_PLAN.md` in the project root (checkbox task list of everything to do).",
    "6. Call `herman_complete_planning` with { projectPath, planPath } when the plan is ready.",
    "",
    "## Operating rules",
    "- PROJECT NAME FIRST: call `herman_wizard_ask` before cloning. Herman auto-injects `projectName`",
    "  on your first call — do not clone until you have the projectName answer.",
    "  Clone with `git clone --depth 1 <repo> ~/Herman/<projectName>` (add --branch <ref> if given).",
    "  Sanitize projectName for the filesystem (lowercase, hyphens, no spaces) before cloning.",
    "  `projectName` IS the display name (blog title, store name, product name, site title). Do NOT ask",
    "  a separate naming question from ## Questions — if a manifest bullet bundles a name with",
    "  something else (e.g. 'what the blog is called and what they write about'), ask only the rest.",
    "- VISUAL TONE LAST: Herman appends `visualTone` as the last question once template-specific",
    "  questions are in the batch (or on a follow-up ask). Capture the answer in the plan for later",
    "  styling work. The visual tone question must never be a `choice` question — it is free text.",
    "- QUESTIONS: ask ONLY what the description + manifest do not already answer. Prefer `choice` questions",
    "  with a small option set over free text when the answer is from a known set. Use `multiple: true` for",
    "  multi-select. Use `secret: true` for API keys the user must paste. Never echo secret values.",
    "  After answers arrive, read the repo docs and decide if you need more clarifying questions.",
    "- PLANNING ONLY: do NOT install dependencies, run migrations, write env files, or customize code",
    "  in this phase. Your deliverable is discovery + `HERMAN_PLAN.md`.",
    "- PLAN FILE: write `{projectPath}/HERMAN_PLAN.md` with:",
    "  * A short summary of the user's intent and key answers",
    "  * Findings from README / AGENTS.md / other docs",
    "  * Env/secrets and requirements notes (what must be generated, asked, or placeholdered later)",
    "  * A complete checkbox task list (`- [ ] …`) covering setup, naming, styling, content, and verification",
    "  Session 2 will tick those boxes while coding.",
    "- When the plan is ready, call `herman_complete_planning` ONCE with",
    "  { projectPath, planPath: \"<absolute>/HERMAN_PLAN.md\", summary? }. This is your LAST tool call.",
    "",
    "## Template manifest (HERMAN.md)",
    "```yaml",
    `name: ${fm.name ?? manifest.id}`,
    fm.description ? `description: ${fm.description}` : "",
    fm.suitable_for ? `suitable_for: ${fm.suitable_for}` : "",
    repoLine,
    "```",
    "",
    "### ## Setup (context for the plan — do not execute yet)",
    manifest.sections.setup?.trim() ?? "(none)",
    "",
    "### ## Questions (author intent — what this template may need to know; Herman skips items already answered by the user's description; never re-ask project/blog/site/store name — use projectName)",
    manifest.sections.questions?.trim() ?? "(none)",
    "",
    "### ## Guidance",
    manifest.sections.guidance?.trim() ?? "(none)",
    "",
    envSection,
    reqSection,
    "",
    "## What the user wants to build",
    description.trim(),
    "",
    "Begin now: ask the user the questions you need, then clone into ~/Herman/<projectName>, read the docs, and write HERMAN_PLAN.md.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** @deprecated Use buildPlanningPrompt */
export function buildWizardPrompt(manifest: ResolvedManifest, description: string): string {
  return buildPlanningPrompt(manifest, description);
}

/**
 * Session 2 — single `/goal` body (without the `/goal ` prefix).
 * Includes rookie/coder framing so we do not need a separate context prompt.
 */
export function buildCodingGoal(
  manifest: ResolvedManifest,
  projectPath: string,
  planPath: string,
): string {
  const setupGoal = manifest.frontmatter.setup_goal?.trim() || DEFAULT_SETUP_GOAL;
  const setupSection = manifest.sections.setup?.trim() || "(none)";

  return [
    "You are in HERMAN WIZARD MODE dealing with a rookie (non-technical) user.",
    "You are the coder for this project. Work autonomously — no chatty explanations.",
    "Do NOT call herman_wizard_ask — there is no user Q&A in this phase.",
    "",
    setupGoal,
    "",
    "You MUST make sure that all the checkboxes in the plan are ticked before you finish.",
    `Plan file: ${planPath}`,
    `Project path: ${projectPath}`,
    "",
    "Before making changes: read AGENTS.md and README if they exist, study codebase patterns, then follow the plan.",
    "",
    "Also follow the template setup instructions:",
    setupSection,
    "",
    "Tick each `- [ ]` to `- [x]` in the plan as you complete it.",
    "When done, call herman_complete_wizard with the project path and a short summary of what you did.",
  ].join("\n");
}

/** @deprecated Folded into buildCodingGoal — kept for any external imports. */
export function buildCodingContextPrompt(projectPath: string, planPath: string): string {
  return [
    "You are in HERMAN WIZARD MODE dealing with a rookie (non-technical) user.",
    "You are the coder for this project. Work autonomously — no chatty explanations.",
    "",
    `Project path: ${projectPath}`,
    `Plan file: ${planPath}`,
    "",
    "Before making changes:",
    "1. Read AGENTS.md and README if they exist in the codebase.",
    "2. Study the patterns already used in the code.",
    "3. Read the plan file and follow it.",
    "",
    "When every plan checkbox is ticked and setup is done,",
    "call `herman_complete_wizard` with { projectPath, summary } as your last tool call.",
  ].join("\n");
}

/** Session 3 — `/goal` body (without the `/goal ` prefix). */
export function buildQaGoal(projectPath: string, planPath: string, codingSummary: string): string {
  return [
    "You are in HERMAN WIZARD MODE. Do NOT call herman_wizard_ask — there is no user Q&A in this phase.",
    "",
    `A prior agent has just completed the work on this plan: ${planPath}`,
    "and their final message is this:",
    "```",
    codingSummary,
    "```",
    "",
    "Your mission now is to make sure that the project is well set up and it runs without issues.",
    `Project path: ${projectPath}`,
    "Start the server and navigate the website. Notice any errors on the server side or the web page's console errors.",
    "If you find any issues, study the patterns in the codebase, then fix the issues.",
    "",
    "When everything is smooth, call herman_complete_wizard with { projectPath, summary } as your last tool call.",
  ].join("\n");
}

/** Returns an error message if planning outputs are not ready to advance; else undefined. */
export function validatePlanningOutputs(projectPath: string, planPath: string): string | undefined {
  if (!projectPath) {
    return "Planning incomplete: projectPath is missing. Clone the project, write HERMAN_PLAN.md, then call herman_complete_planning again.";
  }
  if (!existsSync(projectPath)) {
    return `Planning incomplete: project path does not exist (${projectPath}). Clone the project, then call herman_complete_planning again.`;
  }
  if (!planPath) {
    return "Planning incomplete: planPath is missing. Write HERMAN_PLAN.md, then call herman_complete_planning again.";
  }
  if (!existsSync(planPath)) {
    return `Planning incomplete: plan file not found (${planPath}). Write HERMAN_PLAN.md with checkbox tasks, then call herman_complete_planning again.`;
  }
  return undefined;
}

function formatEnvForPrompt(env: ResolvedManifest["frontmatter"]["env"]): string {
  if (!env?.vars || env.vars.length === 0) return "## Env vars\n(none declared)";
  const lines = ["## Env vars"];
  if (env.file) lines.push(`Target file: ${env.file}`);
  for (const v of env.vars) {
    const parts = [`- ${v.key}`];
    if (v.required) parts.push("required");
    if (v.generate) parts.push(`generate via: \`${v.generate}\``);
    if (v.file) parts.push(`file: ${v.file}`);
    if (v.default) parts.push(`default: ${v.default}`);
    if (v.notes) parts.push(`— ${v.notes}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

function formatRequirementsForPrompt(reqs: ResolvedManifest["frontmatter"]["requirements"]): string {
  if (!reqs || reqs.length === 0) return "## Requirements\n(none declared)";
  const lines = ["## Requirements"];
  for (const r of reqs) {
    lines.push(`- ${r.label} (id: ${r.id})${r.optional ? " [optional]" : ""}`);
    lines.push(`  check: \`${r.check}\``);
    if (r.install) lines.push(`  install: ${r.install}`);
  }
  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("");
}

function formatToolActivity(toolName: string, args: unknown): string | undefined {
  if (toolName === "bash") {
    const command = (args as Record<string, unknown> | undefined)?.command;
    if (typeof command === "string") {
      const first = command.split("\n")[0]?.trim() ?? command;
      return `Running: ${first.slice(0, 120)}`;
    }
  }
  if (toolName === "write" || toolName === "edit") {
    const path = (args as Record<string, unknown> | undefined)?.path;
    if (typeof path === "string") return `${toolName === "write" ? "Writing" : "Editing"}: ${path}`;
  }
  if (toolName === "read") {
    const path = (args as Record<string, unknown> | undefined)?.path;
    if (typeof path === "string") return `Reading: ${path}`;
  }
  return undefined;
}
