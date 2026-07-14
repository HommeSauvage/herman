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

// ── Retry constants ──────────────────────────────────────────────────────────

/** Maximum number of auto-retry attempts before giving up. */
const MAX_RETRIES = 20;
/** Base delay in ms for the first retry (doubles each attempt). */
const BASE_DELAY_MS = 2_000;
/** Cap on retry delay so the total span stays near 5 minutes with 20 retries. */
const MAX_DELAY_MS = 15_000;

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
 * A detached agent session that runs in "wizard mode": it reads the template
 * manifest, clones the project, asks the user structured questions via the
 * `herman_wizard_ask` tool (round-tripped through the React UI), performs
 * setup, and reports completion via `herman_complete_wizard`.
 *
 * The session is NOT a tab — it uses its own isolated agent dir and emits
 * events to the renderer through the `wizardEvent` channel. On completion the
 * caller hands its pi session off to a real project tab (see handoff).
 */
export class WizardSession {
  readonly id: string;
  private bridge: AgentBridge | undefined;
  private manifest: ResolvedManifest | undefined;
  /** The editor extension_ui_request id awaiting a wizard answer. */
  private pendingRequestId: string | undefined;
  /** Set when the agent calls herman_complete_wizard. */
  private projectPath: string | undefined;
  private cancelled = false;
  private finished = false;
  /** Preferred model id ("provider/modelId") for this wizard session. */
  private preferredModel: string | undefined;
  /** Resolved when the agent emits its first models_sync during startup. */
  private modelsReady: { resolve: () => void; promise: Promise<void> } | undefined;
  // ── Retry state ──────────────────────────────────────────────────────────
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private templateId: string | undefined;
  private description: string | undefined;
  /** The wizard agent's pi session id, captured from get_state for handoff. */
  private wizardPiSessionId: string | undefined;

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

    // The wizard shares the single agent config dir (~/.herman/agent) with all
    // tabs; its session is a normal pi session there, scoped to the projects
    // parent cwd. The wizard extension is loaded via a --extension CLI arg set
    // by AgentBridge, not via a per-wizard settings dir.
    await this.startAttempt();

    logger.info("Wizard session started", { id: this.id, templateId, modelId: this.preferredModel });
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
   * Start (or restart) the agent bridge and send the wizard prompt.
   * On retry the pi agent resumes its session automatically because the
   * bridge passes `--session` pointing at the newest JSONL in the agent dir.
   */
  private async startAttempt(): Promise<void> {
    if (this.cancelled || this.finished) return;

    if (this.retryCount > 0 && this.bridge) {
      await this.bridge.stop().catch(() => undefined);
    }

    const manifest = this.manifest;
    const description = this.description;
    if (!manifest || !description) {
      this.end("Cannot start wizard: missing configuration");
      return;
    }

    let agentWasRunning = false;
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
        if (state === "running") {
          agentWasRunning = true;
          return;
        }
        // Treat crashes as retryable; the onEvent handler will schedule retries
        // for terminal events (agent_error, agent_end without completion).
        if (state === "crashed") {
          logger.warning("Wizard agent crashed", { id: this.id, stderr, retryCount: this.retryCount });
          if (!this.finished) {
            this.scheduleRetry(`Agent crashed${stderr ? `: ${stderr}` : ""}`);
          }
        }
      },
      (_tabId, event: AgentEvent) => this.onEvent(event),
    );
    this.bridge = bridge;

    const projects = projectsDir();
    const wizardExtensions = resolveWizardExtensionPath();
    await bridge.start(projects, { mode: "rookie", extensions: wizardExtensions });

    // Capture the wizard's pi session id for handoff. With a shared sessions
    // dir the wizard's JSONL lives alongside every other session, so we must
    // read the id from the agent's state rather than scanning a per-wizard dir.
    void this.capturePiSessionId().catch(() => undefined);

    // Wait briefly for models_sync so we can override the auto-selected default
    // before sending the prompt. Fall through on timeout so we don't hang.
    await Promise.race([
      modelsPromise,
      delay(5_000),
    ]);

    await this.applyPreferredModel();

    const prompt = buildWizardPrompt(manifest, description);
    try {
      await bridge.sendCommand({ type: "prompt", message: prompt });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warning("Wizard start prompt failed", { id: this.id, error: msg, retryCount: this.retryCount });
      this.scheduleRetry(msg);
    }
  }

  private async applyPreferredModel(): Promise<void> {
    const modelId = this.preferredModel;
    if (!modelId || !this.bridge) return;
    const { provider, modelId: id } = parseWizardModelRef(modelId);
    try {
      await this.bridge.sendCommand({ type: "set_model", provider, modelId: id });
      logger.info("Wizard model applied", { id: this.id, modelId });
    } catch (error) {
      logger.warning("Failed to apply wizard model", { id: this.id, modelId, error });
    }
  }

  /**
   * Schedule a retry with exponential backoff.
   * After MAX_RETRIES, gives up and calls `end()` with the last error.
   */
  private scheduleRetry(reason: string): void {
    if (this.cancelled || this.finished) return;

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
    });

    this.emit({
      type: "wizard_retrying",
      wizardSessionId: this.id,
      attempt: this.retryCount,
      maxRetries: MAX_RETRIES,
      error: reason,
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.startAttempt().catch((error) => {
        logger.error("Wizard retry attempt failed", { id: this.id, error });
        this.scheduleRetry(error instanceof Error ? error.message : String(error));
      });
    }, delayMs);
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

  /** The project path reported by herman_complete_wizard (for handoff). */
  getProjectPath(): string | undefined {
    return this.projectPath;
  }

  /** The pi session id used by the wizard agent (for handoff/resume). */
  getPiSessionId(): string | undefined {
    return this.wizardPiSessionId;
  }

  /** Capture the wizard agent's pi session id from its get_state response. */
  private async capturePiSessionId(): Promise<void> {
    if (!this.bridge || this.wizardPiSessionId) return;
    try {
      const response = await this.bridge.sendCommand({ type: "get_state" });
      if (response.success) {
        const data = response.data as Record<string, unknown> | undefined;
        if (data && typeof data.sessionId === "string") {
          this.wizardPiSessionId = data.sessionId;
        }
      }
    } catch {
      // Agent RPC may not be ready yet; the id is only needed at handoff.
    }
  }

  /** Stop the agent without cleanup (used after a successful handoff). */
  async detach(): Promise<void> {
    this.finished = true;
    await this.bridge?.stop().catch(() => undefined);
    // NOTE: do NOT cleanupPersistentState — the session file is handed off.
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
      this.pendingRequestId = wizardReq.requestId;
      this.emit({
        type: "wizard_request",
        wizardSessionId: this.id,
        requestId: wizardReq.requestId,
        envelope: wizardReq.envelope,
      });
      return;
    }

    // 2. herman_complete_wizard tool call → setup done.
    if (event.type === "tool_execution_start" && event.toolName === "herman_complete_wizard") {
      const args = event.args as Record<string, unknown> | undefined;
      const projectPath = typeof args?.projectPath === "string" ? args.projectPath : undefined;
      const summary = typeof args?.summary === "string" ? args.summary : undefined;
      if (projectPath) this.projectPath = projectPath;
      this.emit({
        type: "wizard_complete",
        wizardSessionId: this.id,
        projectPath: projectPath ?? "",
        ...(summary ? { summary } : {}),
      });
      return;
    }

    // 3. Progress: assistant narration + tool activity (skip wizard tools).
    if (event.type === "message_end") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        const text = extractText(msg);
        if (text.trim()) {
          this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: text.trim() });
        }
      }
      return;
    }
    if (
      event.type === "tool_execution_start" &&
      event.toolName !== "herman_wizard_ask" &&
      event.toolName !== "herman_complete_wizard"
    ) {
      const label = formatToolActivity(event.toolName, event.args);
      if (label) {
        this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: label });
      }
      return;
    }

    // 4. Terminal / error events — schedule retry instead of immediately ending.
    if (event.type === "agent_error") {
      this.scheduleRetry(event.error);
      return;
    }
    if (event.type === "agent_end" || event.type === "agent_complete") {
      // If the agent finishes without calling herman_complete_wizard, retry.
      if (!this.projectPath && !this.cancelled) {
        this.scheduleRetry("Agent ended before completing setup");
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

// ── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build the wizard-mode prompt: the resolved manifest (frontmatter + Setup +
 * Questions + Guidance) plus the user's description and explicit wizard
 * operating instructions (secrets, clone target, herman_complete_wizard).
 */
export function buildWizardPrompt(manifest: ResolvedManifest, description: string): string {
  const fm = manifest.frontmatter;
  const source = fm.source;
  const repoLine = source?.repo ? `Source repo: ${source.repo}${source.ref ? ` (ref: ${source.ref})` : ""}` : "(no source repo declared)";

  const envSection = formatEnvForPrompt(fm.env);
  const reqSection = formatRequirementsForPrompt(fm.requirements);

  return [
    "You are running in HERMAN WIZARD MODE to set up a new project for a non-technical user.",
    "Do not write chat-style explanations — work autonomously and report progress only through tool calls.",
    "",
    "## Your job",
    "1. Ask the user what you still need via `herman_wizard_ask` (project name is collected on the first call).",
    "2. Clone the template source into ~/Herman/<projectName> and work directly in that folder.",
    "3. Set up the project (install deps, generate/migrate DB, write env files, apply the name in project files).",
    "4. Call `herman_complete_wizard` with the final absolute project path when done.",
    "",
    "## Operating rules",
    "- PROJECT NAME FIRST: call `herman_wizard_ask` before cloning. Herman auto-injects `projectName`",
    "  on your first call — do not clone until you have the projectName answer.",
    "  Clone with `git clone --depth 1 <repo> ~/Herman/<projectName>` (add --branch <ref> if given).",
    "  Sanitize projectName for the filesystem (lowercase, hyphens, no spaces) before cloning.",
    "  Apply the name in package.json `name`, app/page <title>, README title, etc.",
    "  `projectName` IS the display name (blog title, store name, product name, site title). Do NOT ask",
    "  a separate naming question from ## Questions — if a manifest bullet bundles a name with",
    "  something else (e.g. 'what the blog is called and what they write about'), ask only the rest.",
    "- VISUAL TONE LAST: Herman appends `visualTone` as the last question once template-specific",
    "  questions are in the batch (or on a follow-up ask). Use the answer for typography, color,",
    "  imagery, and layout styling.",
    "- QUESTIONS: ask ONLY what the description + manifest do not already answer. Prefer `choice` questions",
    "  with a small option set over free text when the answer is from a known set. Use `multiple: true` for",
    "  multi-select. Use `secret: true` for API keys the user must paste. Never echo secret values.",
    "  After answers arrive, decide if you need more; if not, proceed to setup.",
    "- ENV / SECRETS:",
    "  * Vars with a `generate` shell command: RUN that command via bash and write its stdout to the env file.",
    "    The user never sees these (e.g. BETTER_AUTH_SECRET via `bun auth:secret`).",
    "  * Non-API-key secrets WITHOUT a `generate` command: do NOT ask the user — write a placeholder value",
    "    (e.g. `change-me-in-production`) and proceed. They can rotate later.",
    "  * Required API keys (no `generate`, clearly third-party like OPENAI_API_KEY): ask via",
    "    `herman_wizard_ask` with `secret: true`. If the user skips, write a placeholder and continue.",
    "  * Write env values to the file declared by the manifest env config (or the project's default .env).",
    "- REQUIREMENTS: verify any required tools are installed (run each `check` command). If a required",
    "  (non-optional) tool is missing, still proceed as far as you can and note it in the completion summary.",
    "- When everything is ready, call `herman_complete_wizard` ONCE with { projectPath, summary }. This is",
    "  your LAST tool call. Do not call other tools after it.",
    "",
    "## Template manifest (HERMAN.md)",
    "```yaml",
    `name: ${fm.name ?? manifest.id}`,
    fm.description ? `description: ${fm.description}` : "",
    repoLine,
    "```",
    "",
    "### ## Setup",
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
    "Begin now: ask the user the questions you need, then clone into ~/Herman/<projectName> and set up the project.",
  ]
    .filter((line) => line !== "")
    .join("\n");
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
