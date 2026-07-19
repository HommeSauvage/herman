import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getLogger } from "@logtape/logtape";

import type { AgentEvent, WizardSessionEvent } from "../shared/agent-protocol.js";
import {
  tryParseGateRequest,
  tryParseInstallRequest,
  tryParseWizardRequest,
} from "../shared/agent-protocol.js";
import type { DevServer, ResolvedManifest } from "../shared/herman-manifest.js";
import { normalizeExportUrlAs } from "../shared/herman-manifest.js";
import { normalizeModelId, parseModelRef } from "../shared/model-selection.js";
import type {
  WizardAskEnvelope,
  WizardInstallEnvelope,
  WizardInstallResponse,
} from "../shared/wizard-protocol.js";
import {
  encodeGateResponse,
  encodeWizardAnswers,
  type WizardGateEnvelope,
  type WizardGateResponse,
} from "../shared/wizard-protocol.js";
import { AgentBridge, type AgentBridgeState } from "./agent-bridge.js";
import { resolveWizardExtensionPath } from "./agent-config-sync.js";
import { AgentSpawnError } from "./agent-process.js";
import {
  ensurePreviewStarted,
  getDevServerStatus,
  stopPreviewsForScope,
  wizardScope,
} from "./preview/index.js";
import { seedStaticRookieDocs, validateDocsOutputs } from "./rookie-docs.js";
import { buildSetupGoal, resolveSetupPlan } from "./setup-plan.js";
import { resolveTemplateManifest } from "./template-registry.js";
import { installTools } from "./toolchain.js";
import {
  clearWizardCheckpoint,
  evaluateWizardCheckpoint,
  loadWizardCheckpoint,
  saveWizardCheckpoint,
  type WizardCheckpoint,
} from "./wizard-checkpoint.js";
import {
  extractRouteInventory,
  type PlanMilestone,
  parsePlanMilestones,
  validateDesignOutputs,
  WIZARD_DESIGN_FILENAME,
} from "./wizard-plan.js";
import { type GateBrowser, runCodingGate, runQaGate } from "./wizard-verify.js";

const logger = getLogger(["herman-desktop", "wizard-session"]);

/** Plan file written by planning/design; coding/QA sessions consume it. */
export const WIZARD_PLAN_FILENAME = "HERMAN_PLAN.md";
export { WIZARD_DESIGN_FILENAME };

/** Default setup goal when the template omits `setup_goal`. */
export const DEFAULT_SETUP_GOAL = "The project should start without errors.";

/** Wire value when the host rejects ask outside planning (extension understands this). */
export const WIZARD_ASK_REJECTED_SENTINEL = "__herman_ask_rejected__";

/** /goal resume command sent on retry to reactivate a paused goal. */
export const WIZARD_RESUME_GOAL_PROMPT = "/goal resume";

/** Per-milestone coding token budget. */
export const MILESTONE_TOKEN_BUDGET = "120k";
/** @deprecated Prefer MILESTONE_TOKEN_BUDGET — kept as an alias. */
export const CODING_TOKEN_BUDGET = MILESTONE_TOKEN_BUDGET;
export const QA_TOKEN_BUDGET = "200k";
export const DOCS_TOKEN_BUDGET = "200k";

// ── Retry constants ──────────────────────────────────────────────────────────

/** Maximum number of auto-retry attempts before giving up. */
const MAX_RETRIES = 20;
/** Base delay in ms for the first retry (doubles each attempt). */
const BASE_DELAY_MS = 2_000;
/** Cap on retry delay so the total span stays near 5 minutes with 20 retries. */
const MAX_DELAY_MS = 15_000;

export type WizardPhase = "planning" | "design" | "coding" | "qa" | "docs";

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
  // Delegate to the shared canonical parser; bare ids map to herman.
  return parseModelRef(modelId) ?? { provider: "herman", modelId };
}

export type WizardSessionOptions = {
  /** Emit a wizard event to the renderer over the dedicated wizard channel. */
  emit: (event: WizardSessionEvent) => void;
  /** Forward agent models_sync lists so the shared catalog can merge them. */
  onAgentModelsSync?: (models: string[]) => void;
  /**
   * Verification/preview dependencies. Defaults to the real implementations;
   * tests inject fakes instead of module-mocking (bun's mock.module records
   * are process-wide and leak into later-loaded test files).
   */
  deps?: Partial<WizardSessionDeps>;
};

/** Preview/gate functions the session needs — injectable for tests. */
export type WizardSessionDeps = {
  ensurePreviewStarted: typeof ensurePreviewStarted;
  getDevServerStatus: typeof getDevServerStatus;
  stopPreviewsForScope: typeof stopPreviewsForScope;
  runCodingGate: typeof runCodingGate;
  runQaGate: typeof runQaGate;
  resolveTemplateManifest: typeof resolveTemplateManifest;
  resolveWizardExtensionPath: typeof resolveWizardExtensionPath;
  createBridge: (...args: ConstructorParameters<typeof AgentBridge>) => AgentBridge;
};

/**
 * A detached agent session that runs the Rookie wizard as a five-phase
 * pipeline (planning → design → coding milestones → QA → docs), invisible
 * to the user. Events go to the renderer through the `wizardEvent` channel.
 * On completion the caller opens a fresh project tab (no session resume).
 */
export class WizardSession {
  readonly id: string;
  private readonly deps: WizardSessionDeps;
  private bridge: AgentBridge | undefined;
  private manifest: ResolvedManifest | undefined;
  /** The editor extension_ui_request id awaiting a wizard answer. */
  private pendingRequestId: string | undefined;
  /** Pending herman_request_install editor requests (requestId → envelope). */
  private pendingInstallRequests = new Map<string, WizardInstallEnvelope>();
  /** Set when planning completes (project cloned + plan written). */
  private projectPath: string | undefined;
  private planPath: string | undefined;
  private designPath: string | undefined;
  private milestones: PlanMilestone[] = [];
  private milestoneIndex = 0;
  private milestoneSummaries: string[] = [];
  private gateWarnings: string[] = [];
  private gateRejections = 0;
  private readonly MAX_GATE_REJECTIONS = 3;
  /** Aggregated coding summary (all milestones), passed to QA. */
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
  /** Goal objective text (without `/goal ` prefix) stored for resilience verification. */
  private phaseGoal: string | undefined;
  private templateId: string | undefined;
  private description: string | undefined;
  /** Recent progress lines persisted for recovery UI. */
  private progressLines: string[] = [];
  /** Last error from wizard_end, kept for recovery display. */
  private lastError: string | undefined;
  private progressPersistTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last question envelope — kept for HMR reattach while ask is pending. */
  private lastEnvelope: WizardAskEnvelope | undefined;
  /** Bumped on cancel/clear so in-flight persist writes cannot resurrect the file. */
  private checkpointEpoch = 0;

  constructor(
    private opts: WizardSessionOptions,
    fixedId?: string,
  ) {
    this.id = fixedId ?? createWizardSessionId();
    this.deps = {
      ensurePreviewStarted,
      getDevServerStatus,
      stopPreviewsForScope,
      runCodingGate,
      runQaGate,
      resolveTemplateManifest,
      resolveWizardExtensionPath,
      createBridge: (...args) => new AgentBridge(...args),
      ...opts.deps,
    };
  }

  /**
   * Rebuild a paused session from a disk checkpoint without starting the agent.
   * Call `resume()` when the user clicks Continue.
   */
  static async fromCheckpoint(
    checkpoint: WizardCheckpoint,
    opts: WizardSessionOptions,
  ): Promise<WizardSession> {
    const session = new WizardSession(opts, checkpoint.id);
    session.templateId = checkpoint.templateId;
    session.description = checkpoint.description;
    session.preferredModel = checkpoint.preferredModel;
    session.phase = checkpoint.phase;
    session.projectPath = checkpoint.projectPath;
    session.planPath = checkpoint.planPath;
    session.designPath = checkpoint.designPath;
    session.codingSummary = checkpoint.codingSummary;
    session.capturedPiSessionId = checkpoint.capturedPiSessionId;
    session.phaseGoal = checkpoint.phaseGoal;
    session.milestoneIndex = checkpoint.milestoneIndex ?? 0;
    session.milestoneSummaries = checkpoint.milestoneSummaries
      ? [...checkpoint.milestoneSummaries]
      : [];
    session.gateWarnings = checkpoint.gateWarnings ? [...checkpoint.gateWarnings] : [];
    session.progressLines = checkpoint.progressLines ? [...checkpoint.progressLines] : [];
    session.lastError = checkpoint.lastError;
    session.finished = true; // paused until resume()
    session.manifest = await session.deps.resolveTemplateManifest(checkpoint.templateId);
    if (session.planPath && existsSync(session.planPath)) {
      try {
        session.milestones = parsePlanMilestones(readFileSync(session.planPath, "utf-8"));
      } catch (error) {
        logger.warning("Failed to rehydrate milestones from checkpoint plan", {
          id: session.id,
          error,
        });
      }
    }
    return session;
  }

  /** Snapshot for renderer recovery / HMR reattach. */
  getSnapshot(): {
    id: string;
    templateId?: string;
    description?: string;
    preferredModel?: string;
    phase: WizardPhase;
    projectPath?: string;
    planPath?: string;
    designPath?: string;
    milestoneIndex: number;
    milestoneSummaries: string[];
    gateWarnings: string[];
    capturedPiSessionId?: string;
    progressLines: string[];
    lastError?: string;
    finished: boolean;
    cancelled: boolean;
    live: boolean;
    pendingRequestId?: string;
    envelope?: WizardAskEnvelope;
    /** Best-effort UI step for soft reload reattach. */
    uiStep: "working" | "questions" | "error" | "retrying";
  } {
    const live = Boolean(this.bridge) && !this.finished && !this.cancelled;
    let uiStep: "working" | "questions" | "error" | "retrying" = "working";
    if (this.finished && this.lastError) {
      uiStep = "error";
    } else if (this.pendingRequestId && this.lastEnvelope) {
      uiStep = "questions";
    } else if (this.retryTimer) {
      uiStep = "retrying";
    }
    return {
      id: this.id,
      templateId: this.templateId,
      description: this.description,
      preferredModel: this.preferredModel,
      phase: this.phase,
      projectPath: this.projectPath,
      planPath: this.planPath,
      designPath: this.designPath,
      milestoneIndex: this.milestoneIndex,
      milestoneSummaries: [...this.milestoneSummaries],
      gateWarnings: [...this.gateWarnings],
      capturedPiSessionId: this.capturedPiSessionId,
      progressLines: [...this.progressLines],
      lastError: this.lastError,
      finished: this.finished,
      cancelled: this.cancelled,
      live,
      pendingRequestId: this.pendingRequestId,
      envelope: this.lastEnvelope,
      uiStep,
    };
  }

  async start(templateId: string, description: string, modelId?: string): Promise<void> {
    this.templateId = templateId;
    this.description = description;
    if (modelId) this.preferredModel = modelId;

    const manifest = await this.deps.resolveTemplateManifest(templateId);
    this.manifest = manifest;

    await mkdir(projectsDir(), { recursive: true });

    this.phase = "planning";
    this.emitPhaseEvent();
    await this.persistCheckpoint();
    await this.startPhaseAttempt();

    logger.info("Wizard session started", {
      id: this.id,
      templateId,
      modelId: this.preferredModel,
      phase: this.phase,
    });
  }

  /**
   * Manual resume after an exhausted-retry failure: reset the failure state
   * and restart the current phase, sending `/goal resume` so pi-goal
   * reactivates the paused goal in the existing session.
   */
  async resume(): Promise<void> {
    if (this.cancelled) {
      throw new Error("Cannot resume a cancelled wizard session");
    }
    if (!this.templateId || !this.description) {
      throw new Error("Cannot resume wizard: missing configuration");
    }
    if (!this.manifest) {
      this.manifest = await this.deps.resolveTemplateManifest(this.templateId);
    }
    if (
      (this.phase === "design" ||
        this.phase === "coding" ||
        this.phase === "qa" ||
        this.phase === "docs") &&
      !this.projectPath
    ) {
      throw new Error("Cannot resume design/coding/QA/docs phase: missing project path");
    }

    this.clearRetryTimer();
    this.finished = false;
    this.lastError = undefined;
    this.retryCount = 0;

    logger.info("Resuming wizard session", {
      id: this.id,
      phase: this.phase,
      projectPath: this.projectPath,
    });

    await this.persistCheckpoint();
    await this.startPhaseAttempt();
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
   * phase's prompts.
   *
   * - First attempt: sends the full `/goal <objective>` (coding/QA) or planning prompt.
   * - Retry with the same pi session: goal is paused by pi-goal after process
   *   restart, so we send `/goal resume` to reactivate the existing goal.
   * - Retry after session loss: the old pi session is gone (stale id), pi
   *   created a new one — we detect the mismatch and re-send `/goal <objective>`.
   */
  private async startPhaseAttempt(): Promise<void> {
    if (this.cancelled || this.finished) return;

    // Snapshot goal/session state before any mutations in this attempt.
    // hadGoal: true when a goal was successfully sent in a prior attempt
    //   (phaseGoal is only set inside sendPhasePrompts after the /goal fires).
    // previousSessionId: the pi session we expect to resume; undefined on the
    //   very first attempt of a phase.
    const hadGoal = !!this.phaseGoal;
    const previousSessionId = this.capturedPiSessionId;

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

    if (
      this.phase === "design" ||
      this.phase === "coding" ||
      this.phase === "qa" ||
      this.phase === "docs"
    ) {
      if (!this.projectPath) {
        this.end("Cannot start design/coding/QA/docs phase: missing project path");
        return;
      }
      // The folder could have been moved/deleted between phases (or while the
      // app was closed). Spawning with a missing cwd fails with a misleading
      // posix_spawn ENOENT and retrying cannot fix it — fail fast instead.
      if (!existsSync(this.projectPath)) {
        this.end(
          `Cannot continue the ${this.phase} phase: the project folder no longer exists (${this.projectPath}).`,
        );
        return;
      }
    }

    if (this.phase === "docs" && this.projectPath) {
      try {
        await seedStaticRookieDocs(this.projectPath);
      } catch (error) {
        logger.warning("Failed to seed rookie docs", { id: this.id, error });
      }
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

    const bridge = this.deps.createBridge(
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
    const wizardExtensions = this.deps.resolveWizardExtensionPath();
    try {
      await bridge.start(cwd, {
        mode: "rookie",
        extensions: wizardExtensions,
        // Resume the same pi session across retries so context (plan progress,
        // tool calls, user answers) is preserved.
        piSessionId: this.capturedPiSessionId,
      });
    } catch (error) {
      // Deterministic pre-flight failures (missing agent binary or project
      // folder) can never succeed on retry — end the wizard with the precise
      // cause instead of burning the retry budget on identical failures.
      if (error instanceof AgentSpawnError && error.reason !== "spawn-failed") {
        logger.error("Wizard spawn pre-flight failed", {
          id: this.id,
          phase: this.phase,
          reason: error.reason,
          error: error.message,
        });
        this.end(`Setup failed: ${error.message}`);
        return;
      }
      throw error;
    }

    if (this.cancelled || this.finished || generation !== this.bridgeGeneration) return;

    // Always read the actual pi session id so we can detect when a previous
    // session was lost (stale capturedPiSessionId → pi creates a new one).
    // On the first attempt this also seeds capturedPiSessionId for retries.
    let actualSessionId: string | undefined;
    try {
      const state = await bridge.sendCommand({ type: "get_state" });
      if (state.success) {
        const data = state.data as Record<string, unknown> | undefined;
        if (data && typeof data.sessionId === "string" && data.sessionId) {
          actualSessionId = data.sessionId;
        }
      }
    } catch {
      // Non-fatal; we just can't verify the session.
    }

    const sessionChanged =
      previousSessionId != null && actualSessionId != null && actualSessionId !== previousSessionId;

    if (sessionChanged) {
      logger.warning("Wizard pi session changed; goal will be re-created", {
        id: this.id,
        previous: previousSessionId,
        current: actualSessionId,
      });
    }

    // Update the stored session id. On first attempt this is the initial
    // capture; on retry it stays the same (or updates if the session drifted).
    if (actualSessionId && actualSessionId !== this.capturedPiSessionId) {
      this.capturedPiSessionId = actualSessionId;
      void this.persistCheckpoint();
    } else {
      // Persist on retry (progress lines, etc.) or when session id couldn't be read.
      void this.persistCheckpoint();
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

    // Decide which prompt to send:
    // - Planning/design: always send the phase prompt (no /goal involved).
    // - Retry with same session + known goal: /goal resume (reactivate paused goal).
    // - First attempt, or session changed: /goal <objective> (create the goal).
    const canResume =
      hadGoal && !sessionChanged && this.phase !== "planning" && this.phase !== "design";

    try {
      if (canResume) {
        await bridge.sendCommand({ type: "prompt", message: WIZARD_RESUME_GOAL_PROMPT });
      } else {
        await this.sendPhasePrompts(bridge, manifest, description);
      }
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

    if (this.phase === "design") {
      const projectPath = this.projectPath as string;
      const planPath = this.planPath ?? join(projectPath, WIZARD_PLAN_FILENAME);
      const prompt = buildDesignGoal(manifest, projectPath, planPath);
      await bridge.sendCommand({ type: "prompt", message: prompt });
      return;
    }

    if (this.phase === "coding") {
      const projectPath = this.projectPath as string;
      const planPath = this.planPath ?? join(projectPath, WIZARD_PLAN_FILENAME);
      const designPath = this.designPath ?? join(projectPath, WIZARD_DESIGN_FILENAME);
      const milestone = this.milestones[this.milestoneIndex];
      if (!milestone) {
        throw new Error("Cannot start coding phase: no milestones parsed from HERMAN_PLAN.md");
      }
      const goalBody = buildCodingGoal(
        manifest,
        projectPath,
        planPath,
        designPath,
        milestone,
        this.milestoneIndex,
        this.milestones.length,
        this.milestoneSummaries,
      );
      this.phaseGoal = goalBody;
      await bridge.sendCommand({
        type: "prompt",
        message: `/goal --tokens ${MILESTONE_TOKEN_BUDGET} ${goalBody}`,
      });
      return;
    }

    if (this.phase === "qa") {
      const projectPath = this.projectPath as string;
      const planPath = this.planPath ?? join(projectPath, WIZARD_PLAN_FILENAME);
      const designPath = this.designPath ?? join(projectPath, WIZARD_DESIGN_FILENAME);
      const servers = manifest.frontmatter.servers;
      let previewUrl: string | undefined;
      let startupNote: string | undefined;
      try {
        const started = await this.deps.ensurePreviewStarted(wizardScope(this.id), projectPath, {
          servers,
          all: true,
        });
        const status = this.deps.getDevServerStatus(wizardScope(this.id));
        const primary =
          status.servers.find((s) => s.serverId === status.primaryServerId) ??
          status.servers.find((s) => s.phase === "ready" && s.url) ??
          status.servers[0];
        previewUrl = primary?.url ?? started.url;
        if (started.phase === "failed" || status.phase === "failed") {
          startupNote =
            started.error ??
            status.servers.find((s) => s.error)?.error ??
            "Preview failed to start.";
        }
      } catch (error) {
        startupNote = error instanceof Error ? error.message : String(error);
        logger.warning("QA preview start failed", { id: this.id, error: startupNote });
      }

      let routes: string[] = [];
      if (existsSync(designPath)) {
        try {
          routes = extractRouteInventory(readFileSync(designPath, "utf-8"));
        } catch (error) {
          logger.warning("Failed to read design route inventory for QA prompt", {
            id: this.id,
            error,
          });
        }
      }

      let goalBody = buildQaGoal({
        projectPath,
        planPath,
        designPath,
        milestoneSummaries: this.milestoneSummaries,
        gateWarnings: this.gateWarnings,
        servers,
        previewUrl,
        routes,
      });
      if (startupNote) {
        goalBody = `KNOWN PREVIEW STARTUP FAILURE (fix before browsing):\n${startupNote}\n\n${goalBody}`;
      }
      this.phaseGoal = goalBody;
      await bridge.sendCommand({
        type: "prompt",
        message: `/goal --tokens ${QA_TOKEN_BUDGET} ${goalBody}`,
      });
      return;
    }

    // docs
    const projectPath = this.projectPath as string;
    const goalBody = buildDocsGoal(projectPath);
    this.phaseGoal = goalBody;
    await bridge.sendCommand({
      type: "prompt",
      message: `/goal --tokens ${DOCS_TOKEN_BUDGET} ${goalBody}`,
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

  /** Advance to the next phase with a fresh retry budget, pi session, and goal. */
  private advanceToPhase(next: WizardPhase): void {
    if (next === "docs") {
      void this.stopWizardPreview();
    }
    this.phase = next;
    this.retryCount = 0;
    this.gateRejections = 0;
    this.capturedPiSessionId = undefined;
    this.phaseGoal = undefined;
    this.clearRetryTimer();
    this.emitPhaseEvent();
    // Keep phaseSignaledComplete true until the new bridge is live so dying
    // events from the previous bridge cannot schedule a retry on the new phase.
    // startPhaseAttempt resets it after invalidating bridgeGeneration.
    logger.info("Wizard advancing phase", { id: this.id, phase: next });
    void this.persistCheckpoint();
    void this.startPhaseAttempt().catch((error) => {
      logger.error("Wizard phase start failed", { id: this.id, phase: next, error });
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
    });
  }

  /** Stay in coding but move to the next milestone with a fresh pi session. */
  private advanceToMilestone(): void {
    this.milestoneIndex++;
    this.retryCount = 0;
    this.gateRejections = 0;
    this.capturedPiSessionId = undefined;
    this.phaseGoal = undefined;
    this.clearRetryTimer();
    this.emitPhaseEvent();
    logger.info("Wizard advancing milestone", {
      id: this.id,
      milestoneIndex: this.milestoneIndex,
      total: this.milestones.length,
    });
    void this.persistCheckpoint();
    void this.startPhaseAttempt().catch((error) => {
      logger.error("Wizard milestone start failed", {
        id: this.id,
        milestoneIndex: this.milestoneIndex,
        error,
      });
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
    });
  }

  private emitPhaseEvent(): void {
    const milestone =
      this.phase === "coding" && this.milestones.length > 0
        ? {
            index: this.milestoneIndex,
            total: this.milestones.length,
            title: this.milestones[this.milestoneIndex]?.title ?? "",
          }
        : undefined;
    this.emit({
      type: "wizard_phase",
      wizardSessionId: this.id,
      phase: this.phase,
      ...(milestone ? { milestone } : {}),
    });
  }

  private async stopWizardPreview(): Promise<void> {
    try {
      await this.deps.stopPreviewsForScope(wizardScope(this.id));
    } catch (error) {
      logger.warning("Failed to stop wizard preview", { id: this.id, error });
    }
  }

  /**
   * Host-enforced gate for herman_complete_wizard. Coding/QA run verification;
   * docs/planning/design always pass. Advancement happens here on pass.
   */
  private async handleGateRequest(requestId: string, envelope: WizardGateEnvelope): Promise<void> {
    const generation = this.bridgeGeneration;
    const reply = (response: WizardGateResponse) => {
      if (generation !== this.bridgeGeneration || this.cancelled || this.finished) return;
      try {
        this.bridge?.sendExtensionUiResponse(requestId, {
          value: encodeGateResponse(response),
        });
      } catch {
        // Agent may already be gone.
      }
    };

    if (this.phase === "docs" || this.phase === "planning" || this.phase === "design") {
      reply({ passed: true, report: "" });
      if (this.phase === "docs") {
        await this.completeCurrentPhase(envelope.summary);
      }
      return;
    }

    this.emit({
      type: "wizard_progress",
      wizardSessionId: this.id,
      text: "Verifying your project…",
    });
    this.adoptReportedProjectPath(envelope.projectPath);

    try {
      const projectPath = this.projectPath ?? envelope.projectPath;
      const servers = this.manifest?.frontmatter.servers ?? [];
      const checks = this.manifest?.frontmatter.checks ?? [];

      let result: Awaited<
        ReturnType<typeof this.deps.runCodingGate | typeof this.deps.runDesignGate>
      >;
      if (this.phase === "coding") {
        result = await this.deps.runCodingGate({
          scope: wizardScope(this.id),
          projectPath,
          servers,
          checks,
        });
      } else if (this.phase === "qa") {
        const designPath = this.designPath ?? join(projectPath, WIZARD_DESIGN_FILENAME);
        let routes: string[] = [];
        if (existsSync(designPath)) {
          try {
            routes = extractRouteInventory(readFileSync(designPath, "utf-8"));
          } catch (error) {
            logger.warning("Failed to read design routes for QA gate", { id: this.id, error });
          }
        }
        let browser: GateBrowser | undefined;
        try {
          const { getBrowserHarness } = await import("./browser-harness/index.js");
          browser = getBrowserHarness();
        } catch (error) {
          logger.warning("Browser harness unavailable for QA gate", { id: this.id, error });
        }
        result = await this.deps.runQaGate({
          scope: wizardScope(this.id),
          projectPath,
          servers,
          checks,
          routes,
          browser,
        });
      } else {
        reply({ passed: true, report: "" });
        return;
      }

      if (generation !== this.bridgeGeneration || this.cancelled || this.finished) return;

      if (result.warnings.length > 0) {
        this.gateWarnings.push(...result.warnings);
      }

      if (!result.passed) {
        this.gateRejections++;
        if (this.gateRejections > this.MAX_GATE_REJECTIONS) {
          if (result.report) this.gateWarnings.push(result.report);
          reply({ passed: true, report: result.report, forced: true });
          await this.completeCurrentPhase(envelope.summary);
          return;
        }
        reply({ passed: false, report: result.report });
        return;
      }

      reply({ passed: true, report: "" });
      await this.completeCurrentPhase(envelope.summary);
    } catch (error) {
      logger.warning("Gate verification threw; force-passing", { id: this.id, error });
      if (generation !== this.bridgeGeneration || this.cancelled || this.finished) return;
      reply({ passed: true, report: "", forced: true });
      await this.completeCurrentPhase(envelope.summary);
    }
  }

  /**
   * Advance after a successful (or force-passed) gate / docs completion.
   * Coding/QA host advancement happens ONLY here — not on tool_execution_start.
   */
  private async completeCurrentPhase(summary?: string): Promise<void> {
    if (this.phaseSignaledComplete || this.cancelled || this.finished) return;

    const trimmed = (summary?.trim() || this.lastAssistantText || "").trim() || undefined;

    if (this.phase === "coding") {
      if (trimmed) this.milestoneSummaries.push(trimmed);
      this.phaseSignaledComplete = true;
      this.clearRetryTimer();
      const hasMore = this.milestoneIndex + 1 < this.milestones.length;
      if (hasMore) {
        this.emit({
          type: "wizard_progress",
          wizardSessionId: this.id,
          text: `Milestone ${this.milestoneIndex + 1} complete — next…`,
        });
        this.recordProgress(`Milestone ${this.milestoneIndex + 1} complete — next…`);
        this.advanceToMilestone();
        return;
      }
      this.codingSummary = this.milestoneSummaries.join("\n\n") || trimmed || undefined;
      this.emit({
        type: "wizard_progress",
        wizardSessionId: this.id,
        text: "Build complete — verifying…",
      });
      this.recordProgress("Build complete — verifying…");
      this.advanceToPhase("qa");
      return;
    }

    if (this.phase === "qa") {
      this.phaseSignaledComplete = true;
      this.clearRetryTimer();
      this.emit({
        type: "wizard_progress",
        wizardSessionId: this.id,
        text: "Docs & Tutorials — writing your guides…",
      });
      this.recordProgress("Docs & Tutorials — writing your guides…");
      this.advanceToPhase("docs");
      return;
    }

    if (this.phase === "docs") {
      const finalPath = this.projectPath ?? "";
      const docsError = validateDocsOutputs(finalPath);
      if (docsError) {
        logger.warning("herman_complete_wizard (docs) rejected", { id: this.id, error: docsError });
        this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: docsError });
        return;
      }
      this.phaseSignaledComplete = true;
      this.clearRetryTimer();
      this.emit({
        type: "wizard_complete",
        wizardSessionId: this.id,
        projectPath: finalPath,
        ...(trimmed ? { summary: trimmed } : {}),
      });
      this.finished = true;
      this.bridgeGeneration++;
      void this.stopWizardPreview();
      void clearWizardCheckpoint();
      void this.bridge?.stop().catch(() => undefined);
    }
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
    this.lastEnvelope = undefined;
    this.bridge.sendExtensionUiResponse(requestId, {
      value: encodeWizardAnswers({ answers, cancelled: false }),
    });
  }

  /**
   * Resolve a pending herman_request_install. On approval the toolchain
   * engine runs the registry strategy (or the agent-provided installCmd) and
   * the outcome goes back to the agent as the editor value. Progress lines
   * are forwarded as wizard_progress so the UI shows activity meanwhile.
   */
  respondInstall(requestId: string, approved: boolean): void {
    const envelope = this.pendingInstallRequests.get(requestId);
    if (!envelope) {
      logger.warning("Wizard respondInstall for unknown/stale request id", {
        id: this.id,
        requestId,
      });
      return;
    }
    this.pendingInstallRequests.delete(requestId);

    const reply = (response: WizardInstallResponse) => {
      this.bridge?.sendExtensionUiResponse(requestId, { value: JSON.stringify(response) });
    };

    if (!approved) {
      reply({ approved: false, installed: false, detail: "The user declined the install." });
      return;
    }

    const progress = (text: string) =>
      this.emit({ type: "wizard_progress", wizardSessionId: this.id, text });
    progress(`Installing ${envelope.label}…`);

    const runId = `wizard-install-${Date.now()}`;
    void installTools(
      runId,
      [
        {
          toolId: envelope.toolId,
          label: envelope.label,
          ...(envelope.installCmd ? { customCommand: envelope.installCmd } : {}),
        },
      ],
      (event) => {
        if (event.type === "tool-log") progress(event.text);
        if (event.type === "tool-waiting") progress(event.message);
      },
    )
      .then(({ results }) => {
        const result = results[0];
        if (result?.ok) {
          progress(`${envelope.label} is ready.`);
          reply({ approved: true, installed: true, detail: `${envelope.label} installed.` });
        } else {
          const error = result?.error ?? "Install failed.";
          progress(`Could not install ${envelope.label}: ${error}`);
          reply({ approved: true, installed: false, detail: error });
        }
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        progress(`Could not install ${envelope.label}: ${detail}`);
        reply({ approved: true, installed: false, detail });
      });
  }

  /** Cancel the wizard: cancel any pending request, stop the agent, clean up. */
  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.bridgeGeneration++;
    this.clearRetryTimer();
    this.clearProgressPersistTimer();
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
    await this.stopWizardPreview();

    // Delete the cloned project dir if the agent created one before cancellation.
    if (this.projectPath && existsSync(this.projectPath)) {
      await rm(this.projectPath, { recursive: true, force: true }).catch(() => undefined);
      logger.info("Deleted partial project dir on cancel", { projectPath: this.projectPath });
    }

    await clearWizardCheckpoint();
    this.checkpointEpoch++;
    // Emit end without re-persisting (cancelled short-circuits persistCheckpoint).
    this.end("Wizard cancelled");
  }

  /**
   * Soft stop without deleting the project or emitting a user-facing error.
   * Used when replacing this session with a newer one.
   */
  async disposeQuietly(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.finished = true;
    this.bridgeGeneration++;
    this.checkpointEpoch++;
    this.clearRetryTimer();
    this.clearProgressPersistTimer();
    if (this.bridge && this.pendingRequestId) {
      try {
        this.bridge.sendExtensionUiResponse(this.pendingRequestId, { cancelled: true });
      } catch {
        // ignore
      }
      this.pendingRequestId = undefined;
    }
    await this.bridge?.stop().catch(() => undefined);
    this.bridge = undefined;
    await this.stopWizardPreview();
  }

  /** The project path reported by planning completion (for handoff). */
  getProjectPath(): string | undefined {
    return this.projectPath;
  }

  /**
   * Adopt the projectPath echoed by a completion tool call, but only when it
   * is a valid existing directory consistent with the path validated at
   * planning time. The model can mangle the path (e.g. drop the leading
   * "/"); blindly trusting it would corrupt the next phase's spawn cwd.
   * Invalid or mismatched values are ignored — the known-good path wins.
   */
  private adoptReportedProjectPath(reported: string | undefined): void {
    const trimmed = reported?.trim();
    if (!trimmed) return;
    if (!isAbsolute(trimmed) || !existsSync(trimmed)) {
      logger.warning("Ignoring invalid projectPath from completion tool", {
        id: this.id,
        phase: this.phase,
        reported,
        keeping: this.projectPath,
      });
      return;
    }
    if (this.projectPath && resolve(trimmed) !== resolve(this.projectPath)) {
      logger.warning("Ignoring mismatched projectPath from completion tool", {
        id: this.id,
        phase: this.phase,
        reported,
        keeping: this.projectPath,
      });
      return;
    }
    this.projectPath = trimmed;
  }

  /** Resolved (extends-flattened) template manifest for handoff. */
  getResolvedManifest(): ResolvedManifest | undefined {
    return this.manifest;
  }

  /** Stop the agent without cleanup (used after a successful handoff). */
  async detach(): Promise<void> {
    this.finished = true;
    this.bridgeGeneration++;
    this.checkpointEpoch++;
    this.clearRetryTimer();
    this.clearProgressPersistTimer();
    await clearWizardCheckpoint();
    await this.bridge?.stop().catch(() => undefined);
    await this.stopWizardPreview();
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  private onEvent(event: AgentEvent): void {
    if (this.finished) return;

    // Auto-respond to extension UI confirm dialogs (e.g., pi-goal asking
    // "Replace goal?").  The wizard is an automated system — always confirm.
    // Without this, confirm() in RPC mode hangs forever (no timeout) because
    // the wizard only handles its own herman_wizard_ask editor dialogs.
    if (
      event.type === "extension_ui_request" &&
      event.method === "confirm" &&
      typeof event.id === "string"
    ) {
      this.bridge?.sendExtensionUiResponse(event.id, { confirmed: true });
      return;
    }

    // Resolve the models-ready wait once the agent advertises its model list,
    // and forward the list to the shared UI catalog.
    if (event.type === "models_sync" || event.type === "herman/models_sync") {
      this.modelsReady?.resolve();
      this.opts.onAgentModelsSync?.(event.models);
      this.emit({
        type: "wizard_models",
        wizardSessionId: this.id,
        models: event.models,
        ...(event.currentModel ? { currentModel: event.currentModel } : {}),
      });
      // (Re)apply the preferred model when the registry advertises it and the
      // agent doesn't have it yet — self-heals after mid-session refreshes.
      const preferred = normalizeModelId(this.preferredModel);
      if (
        preferred &&
        preferred !== normalizeModelId(event.currentModel) &&
        event.models.includes(preferred)
      ) {
        void this.applyPreferredModel();
      }
      return;
    }

    // 0. herman_complete_wizard gate round-trip (must run before other editors).
    const gateReq = tryParseGateRequest(event);
    if (gateReq) {
      void this.handleGateRequest(gateReq.requestId, gateReq.envelope);
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
      this.lastEnvelope = wizardReq.envelope;
      this.emit({
        type: "wizard_request",
        wizardSessionId: this.id,
        requestId: wizardReq.requestId,
        envelope: wizardReq.envelope,
      });
      return;
    }

    // 1b. herman_request_install → editor request carrying an install envelope.
    const installReq = tryParseInstallRequest(event);
    if (installReq) {
      // Installs are a coding/QA escape hatch — planning/design stay read-only.
      if (this.phase === "planning" || this.phase === "design") {
        logger.warning("Rejecting herman_request_install during planning/design", {
          id: this.id,
          phase: this.phase,
        });
        const response: WizardInstallResponse = {
          approved: false,
          installed: false,
          detail: "Tool installs are not allowed during the planning/design phases.",
        };
        this.bridge?.sendExtensionUiResponse(installReq.requestId, {
          value: JSON.stringify(response),
        });
        return;
      }
      this.pendingInstallRequests.set(installReq.requestId, installReq.envelope);
      this.emit({
        type: "wizard_install_request",
        wizardSessionId: this.id,
        requestId: installReq.requestId,
        envelope: installReq.envelope,
      });
      return;
    }

    // 2. Planning complete → start design phase.
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
        text: "Discovery ready — designing…",
      });
      this.recordProgress("Discovery ready — designing…");
      this.advanceToPhase("design");
      return;
    }

    // 2b. Design complete → start coding (first milestone).
    if (event.type === "tool_execution_start" && event.toolName === "herman_complete_design") {
      if (this.phase !== "design" || this.phaseSignaledComplete) return;
      const args = event.args as Record<string, unknown> | undefined;
      const projectPath = typeof args?.projectPath === "string" ? args.projectPath.trim() : "";
      const designPathArg = typeof args?.designPath === "string" ? args.designPath.trim() : "";
      const planPathArg = typeof args?.planPath === "string" ? args.planPath.trim() : "";
      const designPath =
        designPathArg || (projectPath ? join(projectPath, WIZARD_DESIGN_FILENAME) : "");
      const planPath = planPathArg || (projectPath ? join(projectPath, WIZARD_PLAN_FILENAME) : "");

      this.adoptReportedProjectPath(projectPath || undefined);
      const resolvedProject = this.projectPath ?? projectPath;
      const validationError = validateDesignOutputs(resolvedProject, designPath, planPath);
      if (validationError) {
        logger.warning("herman_complete_design rejected", {
          id: this.id,
          projectPath: resolvedProject,
          designPath,
          planPath,
          error: validationError,
        });
        this.emit({
          type: "wizard_progress",
          wizardSessionId: this.id,
          text: validationError,
        });
        return;
      }

      this.projectPath = resolvedProject;
      this.designPath = designPath;
      this.planPath = planPath;
      try {
        this.milestones = parsePlanMilestones(readFileSync(planPath, "utf-8"));
      } catch (error) {
        logger.warning("Failed to parse milestones after design", { id: this.id, error });
        this.emit({
          type: "wizard_progress",
          wizardSessionId: this.id,
          text: "Design incomplete: could not parse milestones from HERMAN_PLAN.md. Rewrite the plan, then call herman_complete_design again.",
        });
        return;
      }
      this.milestoneIndex = 0;
      this.milestoneSummaries = [];
      this.phaseSignaledComplete = true;
      this.clearRetryTimer();
      this.emit({
        type: "wizard_progress",
        wizardSessionId: this.id,
        text: "Design ready — starting build…",
      });
      this.recordProgress("Design ready — starting build…");
      this.advanceToPhase("coding");
      return;
    }

    // 3. herman_complete_wizard — progress only; advancement is via gate → completeCurrentPhase.
    if (event.type === "tool_execution_start" && event.toolName === "herman_complete_wizard") {
      if (this.phaseSignaledComplete) return;
      const args = event.args as Record<string, unknown> | undefined;
      const projectPath = typeof args?.projectPath === "string" ? args.projectPath : undefined;
      this.adoptReportedProjectPath(projectPath);
      if (this.phase === "coding" || this.phase === "qa") {
        this.emit({
          type: "wizard_progress",
          wizardSessionId: this.id,
          text: "Finishing up — Herman is verifying…",
        });
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
          this.recordProgress(text.trim());
          this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: text.trim() });
        }
      }
      return;
    }
    if (
      event.type === "tool_execution_start" &&
      event.toolName !== "herman_wizard_ask" &&
      event.toolName !== "herman_complete_planning" &&
      event.toolName !== "herman_complete_design" &&
      event.toolName !== "herman_complete_wizard"
    ) {
      const label = formatToolActivity(event.toolName, event.args);
      if (label) {
        this.recordProgress(label);
        this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: label });
      }
      return;
    }

    // 5. Proxy / API errors — surfaced early by the herman extension so the
    //    UI can show progress. Pi's auto-retry handles recovery internally.
    if (event.type === "herman/agent_proxy_error") {
      logger.warning("Wizard proxy error", { id: this.id, code: event.code, error: event.error });
      this.recordProgress(event.error);
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
    // Cancelled sessions must not rewrite the checkpoint after clear.
    if (error && !this.cancelled) {
      this.lastError = error;
      void this.persistCheckpoint();
    } else if (error) {
      this.lastError = error;
    }
    this.emit({ type: "wizard_end", wizardSessionId: this.id, ...(error ? { error } : {}) });
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private clearProgressPersistTimer(): void {
    if (this.progressPersistTimer) {
      clearTimeout(this.progressPersistTimer);
      this.progressPersistTimer = undefined;
    }
  }

  private recordProgress(text: string): void {
    this.progressLines = [...this.progressLines, text].slice(-50);
    if (this.progressPersistTimer) return;
    this.progressPersistTimer = setTimeout(() => {
      this.progressPersistTimer = undefined;
      void this.persistCheckpoint();
    }, 2_000);
  }

  private async persistCheckpoint(): Promise<void> {
    if (this.cancelled || !this.templateId || !this.description) return;
    const epoch = this.checkpointEpoch;
    const checkpoint: WizardCheckpoint = {
      id: this.id,
      templateId: this.templateId,
      description: this.description,
      phase: this.phase,
      updatedAt: Date.now(),
      progressLines: this.progressLines.slice(-50),
      ...(this.preferredModel ? { preferredModel: this.preferredModel } : {}),
      ...(this.projectPath ? { projectPath: this.projectPath } : {}),
      ...(this.planPath ? { planPath: this.planPath } : {}),
      ...(this.designPath ? { designPath: this.designPath } : {}),
      ...(this.codingSummary ? { codingSummary: this.codingSummary } : {}),
      ...(this.capturedPiSessionId ? { capturedPiSessionId: this.capturedPiSessionId } : {}),
      ...(this.phaseGoal ? { phaseGoal: this.phaseGoal } : {}),
      ...(this.phase === "coding" ? { milestoneIndex: this.milestoneIndex } : {}),
      ...(this.milestoneSummaries.length > 0
        ? { milestoneSummaries: [...this.milestoneSummaries] }
        : {}),
      ...(this.gateWarnings.length > 0 ? { gateWarnings: [...this.gateWarnings] } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
    if (this.cancelled || epoch !== this.checkpointEpoch) return;
    await saveWizardCheckpoint(checkpoint);
    // A cancel may have cleared the file while the write was in flight.
    if (this.cancelled || epoch !== this.checkpointEpoch) {
      await clearWizardCheckpoint();
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
  /** Last restore/getRecovery payload (covers blocked checkpoints with no session). */
  private pendingRecovery: WizardRecoveryInfo | null = null;
  private restorePromise: Promise<WizardRecoveryInfo | null> | null = null;

  constructor(
    private emit: (event: WizardSessionEvent) => void,
    private onAgentModelsSync?: (models: string[]) => void,
    private deps?: Partial<WizardSessionDeps>,
  ) {}

  /**
   * Load a paused session from disk on app startup. Discards non-resumable
   * checkpoints. Does not start the agent bridge until resume().
   */
  async restoreFromDisk(): Promise<WizardRecoveryInfo | null> {
    if (!this.restorePromise) {
      this.restorePromise = this.doRestoreFromDisk();
    }
    return this.restorePromise;
  }

  private async doRestoreFromDisk(): Promise<WizardRecoveryInfo | null> {
    const checkpoint = await loadWizardCheckpoint();
    if (!checkpoint) {
      this.pendingRecovery = null;
      return null;
    }

    const evaluation = evaluateWizardCheckpoint(checkpoint);
    if (!evaluation.resumable) {
      logger.info("Discarding non-resumable wizard checkpoint", {
        id: checkpoint.id,
        reason: evaluation.reason,
      });
      await clearWizardCheckpoint();
      if (
        evaluation.reason === "Project folder no longer exists" ||
        evaluation.reason === "Missing project path"
      ) {
        this.pendingRecovery = {
          sessionId: checkpoint.id,
          live: false,
          resumable: false,
          blockedReason: evaluation.reason,
          templateId: checkpoint.templateId,
          description: checkpoint.description,
          preferredModel: checkpoint.preferredModel,
          phase: checkpoint.phase,
          projectPath: checkpoint.projectPath,
          progressLines: checkpoint.progressLines ?? [],
          lastError: checkpoint.lastError ?? evaluation.reason,
        };
        return this.pendingRecovery;
      }
      this.pendingRecovery = null;
      return null;
    }

    const session = await WizardSession.fromCheckpoint(checkpoint, {
      emit: this.emit,
      onAgentModelsSync: this.onAgentModelsSync,
      deps: this.deps,
    });
    this.sessions.set(session.id, session);
    logger.info("Restored paused wizard session from checkpoint", {
      id: session.id,
      phase: checkpoint.phase,
    });
    this.pendingRecovery = {
      sessionId: session.id,
      live: false,
      resumable: true,
      templateId: checkpoint.templateId,
      description: checkpoint.description,
      preferredModel: checkpoint.preferredModel,
      phase: checkpoint.phase,
      projectPath: checkpoint.projectPath,
      progressLines: checkpoint.progressLines ?? [],
      lastError: checkpoint.lastError,
      finished: true,
    };
    return this.pendingRecovery;
  }

  /** Live or paused recovery info for the renderer. */
  async getRecovery(): Promise<WizardRecoveryInfo | null> {
    await this.restoreFromDisk();

    // Prefer a live session over any paused/finished orphan.
    for (const session of this.sessions.values()) {
      const snap = session.getSnapshot();
      if (snap.cancelled || !snap.live) continue;
      return {
        sessionId: snap.id,
        live: true,
        resumable: true,
        templateId: snap.templateId,
        description: snap.description,
        preferredModel: snap.preferredModel,
        phase: snap.phase,
        projectPath: snap.projectPath,
        progressLines: snap.progressLines,
        lastError: snap.lastError,
        finished: false,
        uiStep: snap.uiStep,
        pendingRequestId: snap.pendingRequestId,
        envelope: snap.envelope,
        retryAttempt: snap.uiStep === "retrying" ? 1 : undefined,
      };
    }

    for (const session of this.sessions.values()) {
      const snap = session.getSnapshot();
      if (snap.cancelled) continue;

      // Paused / failed session awaiting Continue.
      if (snap.finished && snap.capturedPiSessionId) {
        const evalResult = evaluateWizardCheckpoint({
          id: snap.id,
          templateId: snap.templateId ?? "",
          description: snap.description ?? "",
          phase: snap.phase,
          updatedAt: Date.now(),
          capturedPiSessionId: snap.capturedPiSessionId,
          projectPath: snap.projectPath,
          planPath: snap.planPath,
          preferredModel: snap.preferredModel,
          lastError: snap.lastError,
          progressLines: snap.progressLines,
        });
        return {
          sessionId: snap.id,
          live: false,
          resumable: evalResult.resumable,
          ...(evalResult.reason ? { blockedReason: evalResult.reason } : {}),
          templateId: snap.templateId,
          description: snap.description,
          preferredModel: snap.preferredModel,
          phase: snap.phase,
          projectPath: snap.projectPath,
          progressLines: snap.progressLines,
          lastError: snap.lastError ?? evalResult.reason,
          finished: true,
          uiStep: "error",
        };
      }
    }
    return this.pendingRecovery;
  }

  async start(templateId: string, description: string, modelId?: string): Promise<string> {
    this.pendingRecovery = null;
    // Replace any prior paused/live orphan so getRecovery cannot latch onto it.
    await this.disposeAllSessions();
    const session = new WizardSession({
      emit: this.emit,
      onAgentModelsSync: this.onAgentModelsSync,
      deps: this.deps,
    });
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

  private async disposeAllSessions(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(
      entries.map(async ([, session]) => {
        await session.disposeQuietly().catch(() => undefined);
      }),
    );
  }

  setModel(wizardSessionId: string, modelId: string): void {
    this.sessions.get(wizardSessionId)?.setModel(modelId);
  }

  respond(
    wizardSessionId: string,
    requestId: string,
    answers: { id: string; value: string; values?: string[] }[],
  ): void {
    this.sessions.get(wizardSessionId)?.respond(requestId, answers);
  }

  respondInstall(wizardSessionId: string, requestId: string, approved: boolean): void {
    this.sessions.get(wizardSessionId)?.respondInstall(requestId, approved);
  }

  async resume(wizardSessionId: string): Promise<void> {
    const session = this.sessions.get(wizardSessionId);
    if (!session) {
      throw new Error("Wizard session not found");
    }
    this.pendingRecovery = null;
    await session.resume();
  }

  async cancel(wizardSessionId: string): Promise<void> {
    const session = this.sessions.get(wizardSessionId);
    this.pendingRecovery = null;
    if (!session) {
      await clearWizardCheckpoint();
      return;
    }
    await session.cancel();
    this.sessions.delete(wizardSessionId);
  }

  /** Discard a blocked recovery without deleting a project folder. */
  async discardRecovery(): Promise<void> {
    this.pendingRecovery = null;
    await clearWizardCheckpoint();
    for (const [id, session] of [...this.sessions.entries()]) {
      const snap = session.getSnapshot();
      if (!snap.live) {
        this.sessions.delete(id);
      }
    }
  }

  get(wizardSessionId: string): WizardSession | undefined {
    return this.sessions.get(wizardSessionId);
  }

  /** Remove a completed/cancelled session from the registry. */
  remove(wizardSessionId: string): void {
    this.sessions.delete(wizardSessionId);
  }
}

export type WizardRecoveryInfo = {
  sessionId: string;
  live: boolean;
  resumable: boolean;
  blockedReason?: string;
  templateId?: string;
  description?: string;
  preferredModel?: string;
  phase?: WizardPhase;
  projectPath?: string;
  progressLines: string[];
  lastError?: string;
  finished?: boolean;
  uiStep?: "working" | "questions" | "error" | "retrying" | "recovery";
  pendingRequestId?: string;
  envelope?: WizardAskEnvelope;
  retryAttempt?: number;
};

// ── Prompts ──────────────────────────────────────────────────────────────────

/**
 * Session 1 — planning: ask questions, clone, discover from docs, write an
 * interview digest (not the final milestone checklist). Design phase rewrites
 * the plan into milestones. Does not install, migrate, or customize the project.
 */
export function buildPlanningPrompt(manifest: ResolvedManifest, description: string): string {
  const fm = manifest.frontmatter;
  const source = fm.source;
  const repoLine = source?.repo
    ? `Source repo: ${source.repo}${source.ref ? ` (ref: ${source.ref})` : ""}`
    : "(no source repo declared)";

  const envSection = formatEnvForPrompt(fm.env);
  const reqSection = formatRequirementsForPrompt(fm.requirements);
  const yamlExtras =
    (fm.description ? `description: ${fm.description}\n` : "") +
    (fm.suitable_for ? `suitable_for: ${fm.suitable_for}\n` : "");

  return `You are running in HERMAN WIZARD MODE (planning phase) for a non-technical user.
Do not write chat-style explanations — work autonomously and report progress only through tool calls.

You are a senior developer and product designer: anticipate the right questions so discovery covers
structure, content model, and visual direction — not a final implementation checklist.

## Your job
1. Ask the user what you still need via \`herman_wizard_ask\` (project name is collected on the first call).
2. Clone the template source into ~/Herman/<projectName>.
3. Delete the .git folder from the cloned repo.
4. Read the cloned repo's docs (README, AGENTS.md, and other markdown) to understand the project.
5. If anything is still unclear, ask follow-up questions via \`herman_wizard_ask\`.
6. Write an interview digest to \`HERMAN_PLAN.md\` in the project root (user answers + findings + visualTone).
7. Call \`herman_complete_planning\` with { projectPath, planPath } when the digest is ready.

## Operating rules
- PROJECT NAME FIRST: call \`herman_wizard_ask\` before cloning. Herman auto-injects \`projectName\`
  on your first call — do not clone until you have the projectName answer.
  Clone with \`git clone --depth 1 <repo> ~/Herman/<projectName>\` (add --branch <ref> if given).
  Sanitize projectName for the filesystem (lowercase, hyphens, no spaces) before cloning.
  \`projectName\` IS the display name (blog title, store name, product name, site title). Do NOT ask
  a separate naming question from ## Questions — if a manifest bullet bundles a name with
  something else (e.g. 'what the blog is called and what they write about'), ask only the rest.
- QUESTIONS: ask ONLY what the description + manifest do not already answer. Prefer \`choice\` questions
  with a small option set over free text when the answer is from a known set. Use \`multiple: true\` for
  multi-select. Use \`secret: true\` for API keys the user must paste. Never echo secret values.
  After answers arrive, read the repo docs and decide if you need more clarifying questions.
- WHAT QUESTIONS TO ASK?: The wizard is meant for users who are not technical.
  Ask questions that are easy to answer and do not require technical knowledge. Think about what they
  might miss — pages they need, content they manage, layout preferences, brand feel — that will shape
  the later design and milestones.
- KEEP QUESTIONS SIMPLE AND THE WIZARD LENGTH MANAGEABLE: Don't ask too many questions, keep it between 5 and 10 questions.
- QUESTIONS STYLE & OBJECTIVE: Questions should sound simple, but your intent is to learn structure,
  information architecture, content/admin needs, and visual direction for the design phase.
- PLANNING ONLY: do NOT install dependencies, run migrations, write env files, or customize code
  in this phase. Your deliverable is discovery + an interview digest in \`HERMAN_PLAN.md\`.
  Do NOT write a complete checkbox task list or milestone sections yet — the design phase does that.
- VISUAL TONE LAST: Herman appends \`visualTone\` as the last question once template-specific
  questions are in the batch (or on a follow-up ask). Capture the answer in the digest for design.
  The visual tone question must never be a \`choice\` question — it is free text.
- PLAN FILE (interview digest): write \`{projectPath}/HERMAN_PLAN.md\` with:
  * A short summary of the user's intent
  * Key answers from the interview (including visualTone)
  * Findings from README / AGENTS.md / other docs
  * Env/secrets and requirements notes (what must be generated, asked, or placeholdered later)
  * Open questions / assumptions for design (optional short bullets — not implementation checkboxes)
- When the digest is ready, call \`herman_complete_planning\` ONCE with
  { projectPath, planPath: "<absolute>/HERMAN_PLAN.md", summary? }. This is your LAST tool call.

### Example wizard + questions:
What the user wants to build: "I want to build an online store for my products, I sell home-made shampoos and soaps"

Your questions can be:
- What is the name of your store?
- How many products are you selling? (1-3, 3-10, >10) - (choices, this can help determine the complexity of schemas and admin UI)
- Do you want to have your home page being a presentation or directly showing the products in a grid? (choices, then explain briefly the pros and cons)
- Do you manage the delivery yourself, or are you using a delivery service? Or should we discuss this later? (free text)
- How do you plan to accept payments? (choices, manual, stripe, paypal)
- What about quantities? Do you want to manage the quantities or should we start simple and add it later? (choices, yes, I want to manage the stocks and quantities / start simple, add it later)

## Template manifest
\`\`\`yaml
name: ${fm.name ?? manifest.id}
${yamlExtras}${repoLine}
\`\`\`

### ## Setup (context for the plan — do not execute yet)
${manifest.sections.setup?.trim() ?? "(none)"}

### ## Questions (author intent — what this template may need to know; Herman skips items already answered by the user's description; never re-ask project/blog/site/store name — use projectName)
${manifest.sections.questions?.trim() ?? "(none)"}

### ## Guidance
${manifest.sections.guidance?.trim() ?? "(none)"}

${envSection}
${reqSection}

## What the user wants to build
${description.trim()}

Begin now: ask the user the questions you need, then clone into ~/Herman/<projectName>, read the docs, and write the HERMAN_PLAN.md interview digest.`;
}

/** @deprecated Use buildPlanningPrompt */
export function buildWizardPrompt(manifest: ResolvedManifest, description: string): string {
  return buildPlanningPrompt(manifest, description);
}

/**
 * Session 2 — design: write HERMAN_DESIGN.md and rewrite HERMAN_PLAN.md as
 * milestone sections. Plain prompt (no /goal). No code or installs.
 */
export function buildDesignGoal(
  manifest: ResolvedManifest,
  projectPath: string,
  planPath: string,
): string {
  const guidance = manifest.sections.guidance?.trim() || "(none)";
  const setupSection = manifest.sections.setup?.trim() || "(none)";

  return `You are in HERMAN WIZARD MODE (design phase) for a rookie (non-technical) user.
Work autonomously — no chatty explanations.
Do NOT call herman_wizard_ask — there is no user Q&A in this phase.
Do NOT install dependencies, run migrations, write env files, or change application code.
Your deliverables are design + a milestone plan only.

Project path: ${projectPath}
Interview digest (read first): ${planPath}

## Your job
1. Read \`${WIZARD_PLAN_FILENAME}\` (interview digest), README, AGENTS.md, and other repo docs.
2. Read template Guidance below — use it as constraints, not as a task list to execute.
3. Write \`${WIZARD_DESIGN_FILENAME}\` in the project root with these sections:
   - \`## Design tokens\` — colors, typography, spacing, radii, motion notes aligned to visualTone
   - \`## Layout system\` — shells, grids, shared chrome (nav/footer), responsive rules
   - \`## Page inventory\` — one line per route in this exact format:
     \`- \`/route\` — Page Name: purpose\`
     with sub-bullets for key states and interactions
4. Rewrite \`${WIZARD_PLAN_FILENAME}\` as a milestone plan with **2–6** sections:
   \`## Milestone N: <title>\`
   Each milestone must include:
   - Unchecked task checkboxes (\`- [ ] …\`)
   - An \`Acceptance:\` (or Acceptance criteria) block describing done-when
   Include an auto-checkbox task for removing unused reference/demo modules from the template
   when they are not needed for this project (usually early in milestone 1 or 2).
   For the Laravel starter this means the **Notes** reference module (model, routes, pages,
   sidebar link, factory/seeder, Pest tests, and optional markdown-editor deps) — delete the
   whole feature if the product does not need notes; keep it only when Notes is in scope.
5. Call \`herman_complete_design\` with { projectPath, designPath, planPath } as your LAST tool call.

### ## Setup (context only — do not execute)
${setupSection}

### ## Guidance
${guidance}

Begin now: read the digest and docs, write ${WIZARD_DESIGN_FILENAME}, rewrite ${WIZARD_PLAN_FILENAME} as milestones, then call herman_complete_design.`;
}

/**
 * Coding milestone — `/goal` body (without the `/goal ` prefix).
 * Scoped to one milestone; setup recipe only on milestone index 0.
 */
export function buildCodingGoal(
  manifest: ResolvedManifest,
  projectPath: string,
  planPath: string,
  designPath: string,
  milestone: PlanMilestone,
  milestoneIndex: number,
  total: number,
  priorSummaries: string[],
): string {
  const setupGoal = manifest.frontmatter.setup_goal?.trim() || DEFAULT_SETUP_GOAL;
  const setupSection = manifest.sections.setup?.trim() || "(none)";
  const exportContract = formatExportUrlContract(manifest.frontmatter.servers);
  const setupRecipe =
    milestoneIndex === 0 ? buildSetupGoal(resolveSetupPlan(manifest.frontmatter)) : "";
  const priorBlock =
    priorSummaries.length > 0
      ? `Prior milestone summaries:\n${priorSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`
      : "";

  return `You are in HERMAN WIZARD MODE dealing with a rookie (non-technical) user.
You are the coder for this project. Work autonomously — no chatty explanations.
Do NOT call herman_wizard_ask — there is no user Q&A in this phase.

Milestone ${milestoneIndex + 1} of ${total}: ${milestone.title || "(untitled)"}
Scope: complete ONLY this milestone. Do not start later milestones.

${setupGoal}

Project path: ${projectPath}
Plan file: ${planPath}
Design spec (read before any UI work): ${designPath}

${priorBlock}
## This milestone
\`\`\`md
${milestone.body.trim()}
\`\`\`

Before making changes: read the design spec, AGENTS.md and README if they exist, study codebase patterns, then execute this milestone's checkboxes and acceptance criteria.

${milestoneIndex === 0 ? `Also follow the template setup instructions:\n${setupSection}\n` : ""}${setupRecipe ? `\n${setupRecipe}\n` : ""}${exportContract ? `\n${exportContract}\n` : ""}
If a command fails because a system tool is missing (e.g. a database server), call herman_request_install ONCE for that tool — the user approves it and Herman installs it. If declined or it fails, use a workaround (e.g. sqlite) and continue; do not block.
Tick each \`- [ ]\` to \`- [x]\` for THIS milestone as you complete it.
When this milestone's acceptance criteria are met, call herman_complete_wizard with { projectPath, summary } — Herman verifies before accepting.`;
}

/** @deprecated Folded into buildCodingGoal — kept for any external imports. */
export function buildCodingContextPrompt(projectPath: string, planPath: string): string {
  return `You are in HERMAN WIZARD MODE dealing with a rookie (non-technical) user.
You are the coder for this project. Work autonomously — no chatty explanations.

Project path: ${projectPath}
Plan file: ${planPath}

Before making changes:
1. Read AGENTS.md and README if they exist in the codebase.
2. Study the patterns already used in the code.
3. Read the plan file and follow it.

When every plan checkbox is ticked and setup is done,
call \`herman_complete_wizard\` with { projectPath, summary } as your last tool call.`;
}

export type BuildQaGoalArgs = {
  projectPath: string;
  planPath: string;
  designPath: string;
  milestoneSummaries: string[];
  gateWarnings: string[];
  servers?: DevServer[];
  previewUrl?: string;
  routes: string[];
};

/** QA — `/goal` body (without the `/goal ` prefix). Preview is already running. */
export function buildQaGoal(args: BuildQaGoalArgs): string {
  const {
    projectPath,
    planPath,
    designPath,
    milestoneSummaries,
    gateWarnings,
    servers,
    previewUrl,
    routes,
  } = args;
  const exportContract = formatExportUrlContract(servers);
  const exportChecklist = exportContract
    ? `- [ ] **important**: Verify inter-service env reads match herman.yaml \`exportUrlAs\` (see contract below). Remove hardcoded \`localhost:<port>\` sibling URLs.\n`
    : "";
  const codingSummary =
    milestoneSummaries.length > 0 ? milestoneSummaries.join("\n\n") : "(no milestone summaries)";
  const warningsBlock =
    gateWarnings.length > 0
      ? `Host gate warnings from earlier forced passes (investigate):\n${gateWarnings.map((w) => `- ${w}`).join("\n")}\n`
      : "";
  const routeList =
    routes.length > 0 ? routes.map((r) => `- \`${r}\``).join("\n") : "- `/` (default)";
  const previewLine = previewUrl
    ? `Preview is ALREADY RUNNING at ${previewUrl}. Do NOT start your own server.`
    : "Herman attempted to start the managed preview. Do NOT start your own competing server; use herman_browse against the managed preview URL when available.";

  return `You are in HERMAN WIZARD MODE. Do NOT call herman_wizard_ask — there is no user Q&A in this phase.

A prior coding agent completed milestones for this plan: ${planPath}
Design spec: ${designPath}
Milestone summaries:
\`\`\`
${codingSummary}
\`\`\`
${warningsBlock}
Your mission now is to make sure that the project is well set up and it runs without issues.
Project path: ${projectPath}
${previewLine}

Walk through EVERY inventoried route with herman_browse (or equivalent), watching server and console errors:
${routeList}

Checklist:
- [ ] Navigate every route above on the managed preview. Notice any errors on the server side or the web page's console errors.
- [ ] If you find any issues, study the patterns in the codebase, then fix the issues.
- [ ] Verify that there are no files that are unused, use "bunx fallow" if available and appropriate
- [ ] **important**: Make sure that the .env files that are tracked (not in .gitignore) do not have any secrets. Example, some projects follow the .env.development .env.development.local pattern where the .env.*.local are gitignored. If unsure, verify .gitignore.
${exportChecklist}- [ ] Use any available tools in the project to verify/validate the code (type checks, linting, etc.) verify the package.json
- [ ] Review the critical paths for the project for correctness, clarity, performance, security, and maintainability.
${exportContract ? `\n${exportContract}\n` : ""}
When everything is smooth (you ticked off all the checklist items), call herman_complete_wizard with { projectPath, summary } as your last tool call — Herman cold-restarts and verifies.`;
}

/** Session 4 — Docs & Tutorials `/goal` body (without the `/goal ` prefix). */
export function buildDocsGoal(projectPath: string): string {
  return `You are in HERMAN WIZARD MODE (Docs & Tutorials phase) for a rookie (non-technical) user.
Do NOT call herman_wizard_ask — there is no user Q&A in this phase.

A working project has just been built and verified at: ${projectPath}
Your mission: write beginner-friendly documentation and tutorials that teach the rookie how THEIR project works, how to manage its content, and how to keep improving it with Herman.

All docs live in: ${projectPath}/herman-docs/ (already created; Herman has seeded static files there).
Do not modify any project code in this phase — only files inside herman-docs/.

## Seeded static files (already in herman-docs/ — do NOT regenerate)
- \`notions-and-terminology.md\` — general Herman/web concepts. Leave content as-is.
- \`herman-agent-quickstart.md\` — how to work with the Herman agent. Leave content as-is.
- \`database.md\` — base explainer. Follow the HTML comment at the bottom: replace the final section with this project's real database details (engine, where it lives, what it stores, how the rookie changes data day-to-day). If the project has NO database, replace that final section with a short note saying so and explain where the site's content comes from instead.
You may RENAME seeded files only to add a 2-digit ordering prefix (e.g. \`notions-and-terminology.md\` → \`02-notions-and-terminology.md\`), keeping the base name.

## Step 1 — understand the project
Explore before writing: package.json scripts, routes/pages, admin panel, data/content models, env files, README/AGENTS.md.
Decide for this project: does it have an admin panel? a database? manageable content (products, posts, users)? Then tailor the docs to what actually exists — never document features the project does not have.

## Step 2 — decide the structure and write the docs
You choose the doc titles, count, and order. Rules:
- ALWAYS include a **Start Here** doc as the entry point.
- File names: kebab-case with a 2-digit ordering prefix: \`01-start-here.md\`, \`02-….md\`. The app's sidebar sorts by this prefix.
- Every doc starts with exactly one \`# Title\` line — it becomes the sidebar label.
- Cross-link docs with relative links inside the folder: \`[text](./other-doc.md)\`. Every linked file must exist.
- Audience: a non-technical rookie. Short sentences, second person ("you"), warm and encouraging. Never use jargon without explaining it. Never tell the user to run terminal commands or edit code — Herman does technical work. (Exception: the publishing doc may include clearly fenced copy-paste commands, with a note that the rookie can ask Herman to do it for them.)
- A good structure for a typical site with an admin panel (adapt freely — merge, split, rename, reorder):
  - \`01-start-here.md\`
  - \`02-notions-and-terminology.md\` (seeded)
  - \`03-herman-agent-quickstart.md\` (seeded)
  - \`04-database.md\` (seeded + your appendix — only when the project has a database)
  - a doc about adding/changing features, with example prompts
  - a doc about managing content (only when the project has an admin panel / content system)
  - a publishing doc

## The "Start Here" doc
Here is a real example from a merchandise + blog project with an admin panel. Adapt every claim to THIS project (what it has, where things live, what the user manages):

\`\`\`md
# Start Here
[Welcome to Herman Agent + very short description of the project]

## How's the project organized?
- The project is split in 2 main parts: **Admin Panel** and **Public Website**.
- Your project also has a **database**, to understand what this is, read the doc in [database.md](./database.md)

## How can I see my website?
- Your website is available on the preview pane when you open the project in Herman. Each new tab will have its own URL to make it easier to work on multiple features without clashing edits.
- Your website can also be visited from your local browser, just copy the URL from the preview pane and paste it in your browser or click the \`Open in Browser\` button in the URL bar.

## Can other people see my website?
Not when you are in \`Development Mode\`. When you are in \`Development Mode\`, your website is only visible to you on your machine. When you want to share your website with others or have it with a live domain, you need to [publish your project](./publishing.md).

## Public Website
- Your public website is the place where your content is displayed to the visitors. This is the core of your project.
- Modifications & prompts about the public website should be about:
  - Design & structure
  - Pages & the logic of how they display data or collect data & forms
  - Static pages (pages that are not managed by the admin panel, read about them in [Notions & Terminology](./notions-and-terminology.md#static-vs-dynamic-pages))

Since you have an admin panel, you should not prompt the agent about adding new blog posts

## Admin Panel
The admin panel is the place to manage the website. At the moment, you can:
- Create/Edit/Delete posts
- Create/Edit/Delete merchandise and their categories with their photos
- Create/Edit/Delete users
- Add products and update their prices

### Opening the admin panel
- Your admin panel is available at /admin page
- You must login. This project has a [seed data](./notions-and-terminology.md#seed-data) functionality. So it should generate your first user and admin user with the credentials. You can ask the Herman Agent to share them with you to login.

### Summary of the Website/Admin Split
- If you want to manage products, users, posts, do this in the admin panel, do not prompt the agent about those tasks.
- If you want to modify **how the website looks** and how does it **present the data**, then you should prompt the agent about those tasks.
- When the website is live in production \`my-project.com\`, you will only be working on the admin panel. \`Herman\` cannot modify the website in production. You can however keep using \`Herman\` to modify locally and then publish the changes.
\`\`\`

## The "adding features" doc
Give concrete, copy-paste-able example prompts for Herman that fit THIS project: one brand-new feature, one new static page, one new dynamic feature, and one enhancement of an existing feature. Briefly explain the static/dynamic difference (link to the terminology doc's #static-vs-dynamic-pages section).

## The "managing content" doc (only when the project has an admin/content system)
Explain what can be managed (products, posts, users… — the real list for this project), how to open the admin panel (the real route), how login works with seed data (tell the rookie to ask Herman for the credentials), and the golden rule: manage CONTENT in the admin panel; ask Herman to change how things LOOK or WORK.

## The "publishing" doc
Structure it like this:
- **What is publishing?** — in simple terms: the project needs somewhere to live on the internet, linked to a domain name, to be visible to the public.
- **How can I publish my project?** — Explain the in-app Publishing screen:
  - Herman has a built-in **Publishing** screen (accessible from the preview pane toolbar — look for the rocket/globe icon). This screen walks you through everything step by step.
  - The Publishing screen will help you: get a cloud server, set up SSH access, install Coolify (a free deployment platform), and connect it to Herman.
  - After that, just ask Herman to deploy — the agent handles creating the project, configuring the app, setting environment variables, and assigning a domain.
  - *Getting a domain name*: briefly why a domain is needed; two examples of where to buy one: Cloudflare and Namecheap.
  - Mention that Herman is always available to answer questions and help with any step of the publishing process.
- End with: Herman is always here to answer questions about publishing and to help step by step.

## Finishing up
1. Re-check every relative link target exists in herman-docs/.
2. Best-effort commit (never fail the phase over git errors — and it's fine if there is no git repo): \`git add herman-docs && git commit -m "Add project docs"\`
3. Call herman_complete_wizard with { projectPath, summary } as your LAST tool call.`;
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

/**
 * Prompt section describing herman.yaml exportUrlAs contracts for coding/QA.
 * Returns empty string when no server declares exportUrlAs.
 */
export function formatExportUrlContract(servers: DevServer[] | undefined): string {
  if (!servers?.length) return "";
  const exporting = servers
    .map((s) => ({ id: s.id, aliases: normalizeExportUrlAs(s.exportUrlAs) }))
    .filter((s) => s.aliases.length > 0);
  if (exporting.length === 0) return "";

  const lines = [
    "## Preview URL env contract (herman.yaml `servers[].exportUrlAs`)",
    "Herman injects these env keys at preview start with each service's resolved `http://localhost:{port}` URL (ports may differ from the preferred `port` in the manifest when multiple projects run).",
    "Apps that talk to a listed service MUST read one of these env keys — do not hardcode `localhost:<preferredPort>` for inter-service calls. Unify code and env examples to match this contract.",
    "",
  ];
  for (const s of exporting) {
    lines.push(`- server \`${s.id}\` → env keys: ${s.aliases.map((a) => `\`${a}\``).join(", ")}`);
  }
  return lines.join("\n");
}

function formatEnvForPrompt(env: ResolvedManifest["frontmatter"]["env"]): string {
  const files = env?.files ?? [];
  if (files.length === 0) return "## Env vars\n(none declared)";
  const lines = ["## Env vars"];
  for (const file of files) {
    lines.push(`Target file: ${file.path}`);
    for (const [key, v] of Object.entries(file.vars ?? {})) {
      const parts = [`- ${key}`];
      if (v.required) parts.push("required");
      if (v.generate) parts.push(`generate via: \`${v.generate}\``);
      if (v.value != null) parts.push(`default: ${v.value}`);
      if (v.notes) parts.push(`— ${v.notes}`);
      lines.push(parts.join(" "));
    }
  }
  return lines.join("\n");
}

function formatRequirementsForPrompt(
  reqs: ResolvedManifest["frontmatter"]["requirements"],
): string {
  if (!reqs || reqs.length === 0) return "## Requirements\n(none declared)";
  const lines = [
    "## Requirements",
    "Herman checked these BEFORE starting you — required ones are already installed on the user's machine. Do not install them yourself.",
  ];
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
      const first = command.split("\n")[0]?.trim() || undefined;
      if (first) return `Running: ${first.slice(0, 120)}`;
    }
  }
  if (toolName === "write" || toolName === "edit") {
    const path = (args as Record<string, unknown> | undefined)?.path;
    if (typeof path === "string" && path.trim())
      return `${toolName === "write" ? "Writing" : "Editing"}: ${path}`;
  }
  if (toolName === "read") {
    const path = (args as Record<string, unknown> | undefined)?.path;
    if (typeof path === "string" && path.trim()) return `Reading: ${path}`;
  }
  return undefined;
}
