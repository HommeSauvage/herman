import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import { config } from "../env.js";
import type { AgentCommand, AgentEvent } from "../shared/agent-protocol.js";
import { parseAdEventFromNotify, parseHermanEventFromNotify } from "../shared/agent-protocol.js";
import type { TabId } from "../shared/rpc.js";
import { agentConfigsDir, hermanDir, skillsDir } from "./app-paths.js";
import { AgentProcess } from "./agent-process.js";
import { refreshAllOAuthCredentials } from "./credentials.js";
import { writeFileAtomically } from "./fs-utils.js";
import { resolvePiSessionResumeArg } from "./pi-session.js";

const logger = getLogger(["herman-desktop", "agent-bridge"]);

export type AgentBridgeState = "idle" | "starting" | "running" | "crashed";

export class AgentBridge {
  private process?: AgentProcess;
  private messageBuffer: AgentEvent[] = [];
  private pendingAttachEvents: AgentEvent[] = [];
  private folderPath?: string;
  private agentDir?: string;
  private piSessionId?: string;
  private rendererAttached = false;

  constructor(
    private tabId: TabId,
    private sendToRenderer: (tabId: TabId, event: AgentEvent) => void,
    private onStatusChange: (tabId: TabId, state: AgentBridgeState, stderr?: string) => void,
    private onEvent?: (tabId: TabId, event: AgentEvent) => void,
  ) {}

  get state(): AgentBridgeState {
    const processState = this.process?.state ?? "idle";
    if (processState === "stopped") return "idle";
    return processState;
  }

  getState(): AgentBridgeState {
    return this.state;
  }

  async start(folderPath?: string, opts?: { piSessionId?: string; mode?: string }) {
    this.folderPath = folderPath || undefined;
    this.piSessionId = opts?.piSessionId;
    if (this.process) {
      await this.stop();
    }

    const { loadSettings } = await import("./settings.js");
    const settings = await loadSettings();
    const hermanEnabled = settings.providers.herman.enabled;

    const binaryPath = config.agentPath || resolveAgentCliPath();
    const packageDir = resolve(realpathSync(binaryPath), "..", "..");
    const agentDir = await prepareAgentDir(this.tabId, settings);
    this.agentDir = agentDir;

    const env: Record<string, string> = {
      HERMAN_AGENT_DIR: agentDir,
      HERMAN_APP_DIR: hermanDir(),
      HERMAN_CLIENT_VERSION: "0.0.1",
      HERMAN_TAB_ID: this.tabId,
      ...(opts?.mode ? { HERMAN_MODE: opts.mode } : {}),
    };

    if (hermanEnabled) {
      env.HERMAN_SERVER_URL = config.serverUrl;
      env.HERMAN_SESSION_TOKEN = (await this.getSessionToken()) ?? "";
      env.HERMAN_PINNED_PROVIDERS = await this.getPinnedProvidersJson();
    }

    const sessionArg = resolvePiSessionResumeArg(agentDir, opts?.piSessionId);

    logger.info("Starting agent subprocess", {
      tabId: this.tabId,
      binaryPath,
      cwd: this.folderPath,
      sessionArg: sessionArg ?? null,
      hermanEnabled,
    });

    this.process = new AgentProcess({
      binaryPath,
      packageDir,
      cwd: this.folderPath,
      env,
      args: sessionArg ? ["--session", sessionArg] : [],
    });

    this.process.rpc.onEvent((event) => {
      const enriched = enrichExtensionUiEvent(event);

      // A new agent turn has started.  Events from previous turns are no
      // longer relevant to the renderer's polling fallback, and replaying
      // stale lifecycle events (especially agent_start) can flip the UI back
      // into a working state after a turn has ended or been stopped.  Reset
      // the buffer so it only holds events for the current turn.
      if (event.type === "agent_start") {
        this.messageBuffer = [enriched];
      } else {
        this.messageBuffer.push(enriched);
        if (this.messageBuffer.length > 500) {
          this.messageBuffer = this.messageBuffer.slice(-250);
        }
      }

      if (!this.maybeBufferForAttach(enriched)) {
        this.sendToRenderer(this.tabId, enriched);
      }
      this.onEvent?.(this.tabId, enriched);

      // After a turn completes, clear the buffer so stale events are never
      // replayed to a renderer that reloads (the polling fallback fetches
      // from this buffer).  We keep agent_start for the next turn, which
      // resets the buffer anyway.
      if (event.type === "agent_end" || event.type === "agent_complete") {
        this.messageBuffer = [];
      }
    });

    this.process.rpc.onExit((code) => {
      const state = code === 0 ? "idle" : "crashed";
      this.notifyStatus(state, this.process?.stderr);
    });

    this.process.rpc.onError((error) => {
      logger.warning("Agent subprocess error", {
        tabId: this.tabId,
        error: error.message,
      });
      this.notifyStatus("crashed", error.message);
    });

    await this.process.start();
    logger.info("Agent subprocess running", { tabId: this.tabId, pid: this.process.pid });
    this.notifyStatus("running");
  }

  async stop() {
    logger.info("Stopping agent subprocess", { tabId: this.tabId });
    await this.process?.stop();
    this.process = undefined;
    // Keep the per-tab agent directory so PI session artifacts survive
    // tab closes/reopens and agent restarts.
    this.agentDir = undefined;
    this.notifyStatus("idle");
  }

  cleanupPersistentState() {
    cleanupTabAgentDir(this.tabId);
  }

  async restart(folderPath?: string, opts?: { piSessionId?: string; mode?: string }) {
    await this.start(folderPath ?? this.folderPath, {
      piSessionId: opts?.piSessionId ?? this.piSessionId,
      mode: opts?.mode,
    });
  }

  async sendCommand(command: AgentCommand) {
    if (!this.process) {
      throw new Error("Agent is not running");
    }
    return this.process.rpc.sendCommand(command);
  }

  sendRaw(command: AgentCommand) {
    if (!this.process) return;
    this.process.rpc.sendRaw(command);
  }

  /**
   * Send an `extension_ui_response` to the agent stdin, resolving a pending
   * extension UI dialog request (e.g. a herman_wizard_ask question batch
   * carried over an `editor` request). `value` is the string the awaiting
   * ctx.ui.editor() / select() / input() call resolves to; pass
   * `{ cancelled: true }` to cancel.
   */
  sendExtensionUiResponse(
    id: string,
    payload: { value: string } | { cancelled: true },
  ): void {
    if (!this.process) return;
    this.process.rpc.sendRawObject({
      type: "extension_ui_response",
      id,
      ...payload,
    });
  }

  getRecentEvents(): AgentEvent[] {
    return [...this.messageBuffer];
  }

  getStderr(): string {
    return this.process?.stderr ?? "";
  }

  /** Mark the renderer tab as ready to receive buffered startup events. */
  setRendererAttached(attached: boolean) {
    this.rendererAttached = attached;
    if (attached) {
      this.flushPendingAttachEvents();
    }
  }

  /** Replay startup events that arrived before the renderer tab existed. */
  flushPendingAttachEvents() {
    if (!this.rendererAttached || this.pendingAttachEvents.length === 0) return;
    const events = this.pendingAttachEvents;
    this.pendingAttachEvents = [];
    for (const event of events) {
      this.sendToRenderer(this.tabId, event);
    }
  }

  consumePendingAttachEvents(): AgentEvent[] {
    const events = this.pendingAttachEvents;
    this.pendingAttachEvents = [];
    return events;
  }

  private maybeBufferForAttach(event: AgentEvent): boolean {
    if (this.rendererAttached) return false;
    if (
      event.type === "herman/context_report" ||
      event.type === "herman/models_sync" ||
      event.type === "models_sync"
    ) {
      this.pendingAttachEvents.push(event);
      return true;
    }
    return false;
  }

  private notifyStatus(state: AgentBridgeState, stderr?: string) {
    this.onStatusChange(this.tabId, state, stderr);
  }

  private async getSessionToken(): Promise<string | undefined> {
    const { loadState } = await import("./session.js");
    const state = await loadState();
    return state.session?.token;
  }

  private async getPinnedProvidersJson(): Promise<string> {
    try {
      const { getPinnedProviders } = await import("./persistence.js");
      return JSON.stringify(getPinnedProviders(this.tabId));
    } catch {
      // Pinned providers are an optimization; don't block agent startup if
      // the DB is locked or the table doesn't exist yet.
      return "{}";
    }
  }
}

async function prepareAgentDir(
  tabId: TabId,
  settings: Awaited<ReturnType<typeof import("./settings.js").loadSettings>>,
): Promise<string> {
  const { loadCredentials } = await import("./credentials.js");
  const baseDir = resolve(agentConfigsDir(), tabId);
  mkdirSync(baseDir, { recursive: true });

  const credentials = await loadCredentials();
  // Refresh OAuth tokens in the background — never block tab open on this.
  void refreshAllOAuthCredentials().catch(() => {});
  const authJson: Record<string, unknown> = {};
  for (const [providerId, credential] of Object.entries(credentials)) {
    if (credential.type === "apiKey") {
      authJson[providerId] = {
        type: "api_key",
        key: credential.key,
        ...(credential.metadata ? { env: credential.metadata } : {}),
      };
    } else if (credential.type === "oauth") {
      authJson[providerId] = {
        type: "oauth",
        access: credential.accessToken,
        refresh: credential.refreshToken,
        expires: credential.expiresAt,
      };
    }
  }
  writeAgentConfigFile(join(baseDir, "auth.json"), authJson);

  const modelsJson: Record<string, unknown> = { providers: {} };
  const modelsProviders = modelsJson.providers as Record<string, unknown>;
  for (const [providerId, providerSettings] of Object.entries(settings.providers.custom)) {
    if (!providerSettings?.enabled) continue;
    const options = (providerSettings as { options?: Record<string, string> }).options;
    if (!options?.baseUrl) continue;

    modelsProviders[providerId] = {
      baseUrl: options.baseUrl,
      api: "openai-completions",
      apiKey: options.apiKey,
      models: {
        default: {
          id: "default",
          name: options.name || providerId,
        },
      },
    };
  }
  writeAgentConfigFile(join(baseDir, "models.json"), modelsJson);

  // Write agent settings.json with skills discovery path and disable patterns.
  // Pi auto-discovers skills from the skillsDir() path and applies !name patterns
  // to exclude disabled skills.
  const disabledSkills = settings.disabledSkills ?? [];
  const skillsPatterns: string[] = [skillsDir()];
  for (const name of disabledSkills) {
    skillsPatterns.push(`!${name}`);
  }

  const settingsPath = join(baseDir, "settings.json");
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existingSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // Overwrite corrupt settings below.
    }
  }
  const extensionPaths = resolveWizardExtensionPath();
  writeAgentConfigFile(
    settingsPath,
    mergeAgentSettings(existingSettings, skillsPatterns, extensionPaths),
  );

  return baseDir;
}

export function cleanupTabAgentDir(tabId: TabId) {
  const dir = resolve(agentConfigsDir(), tabId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist or be locked; ignore cleanup failures.
  }
}

function writeAgentConfigFile(path: string, data: Record<string, unknown>) {
  writeFileAtomically(path, JSON.stringify(data, null, 2));
}

/** Merge Herman-managed settings into an existing pi agent settings file. */
export function mergeAgentSettings(
  existing: Record<string, unknown>,
  skills: string[],
  extensions: string[] = [],
): Record<string, unknown> {
  // Preserve any non-Herman-managed extension paths already in the file.
  const existingExtensions = Array.isArray(existing.extensions)
    ? (existing.extensions as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const mergedExtensions = [...new Set([...extensions, ...existingExtensions])];
  const { extensions: _e, ...rest } = existing;
  const out: Record<string, unknown> = { ...rest, skills };
  if (mergedExtensions.length > 0) out.extensions = mergedExtensions;
  return out;
}

/**
 * Absolute path to the bundled wizard extension directory.
 * Production (bundled): app/bun -> app/wizard-extension
 * Local dev: apps/desktop/src/bun -> apps/desktop/src/bun/wizard-extension
 * Returns [] if not found (wizard tools just won't register).
 */
function resolveWizardExtensionPath(): string[] {
  const bundled = resolve(import.meta.dir, "..", "wizard-extension");
  if (existsSync(join(bundled, "index.ts")) || existsSync(join(bundled, "index.js"))) {
    return [bundled];
  }
  const dev = resolve(import.meta.dir, "wizard-extension");
  if (existsSync(join(dev, "index.ts")) || existsSync(join(dev, "index.js"))) {
    return [dev];
  }
  logger.warning("Wizard extension directory not found; wizard tools will not load");
  return [];
}

function resolveAgentCliPath(): string {
  const envPath = config.agentPath;
  if (envPath) return envPath;

  // Production bundle: app/bun/index.js -> app/packages/agent/dist/cli.js
  const bundledPath = resolve(import.meta.dir, "..", "packages", "agent", "dist", "cli.js");
  if (existsSync(bundledPath)) return bundledPath;

  // Local dev from apps/herman-desktop/src/bun
  const devPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "agent",
    "dist",
    "cli.js",
  );
  if (existsSync(devPath)) return devPath;

  return join(process.cwd(), "node_modules", ".bin", "herman");
}

function enrichExtensionUiEvent(event: AgentEvent): AgentEvent {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return event;

  const adEvent = parseAdEventFromNotify(event.message);
  if (adEvent) return adEvent;

  const hermanEvent = parseHermanEventFromNotify(event.message);
  if (hermanEvent) return hermanEvent;

  return event;
}
