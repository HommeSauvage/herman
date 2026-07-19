import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import { config } from "../env.js";
import type { AgentCommand, AgentEvent } from "../shared/agent-protocol.js";
import { parseAdEventFromNotify, parseHermanEventFromNotify } from "../shared/agent-protocol.js";
import type { TabId } from "../shared/rpc.js";
import { awaitAgentConfigSynced } from "./agent-config-sync.js";
import { AgentProcess } from "./agent-process.js";
import { agentDir, hermanDir } from "./app-paths.js";
import { getActiveHostBridge } from "./host-bridge/server.js";
import { deletePiSessionFile, resolvePiSessionResumeArg } from "./pi-session.js";

const logger = getLogger(["herman-desktop", "agent-bridge"]);

export type AgentBridgeState = "idle" | "starting" | "running" | "crashed";

export class AgentBridge {
  private process?: AgentProcess;
  private messageBuffer: AgentEvent[] = [];
  private pendingAttachEvents: AgentEvent[] = [];
  private folderPath?: string;
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

  async start(
    folderPath?: string,
    opts?: { piSessionId?: string; mode?: string; extensions?: string[] },
  ) {
    this.folderPath = folderPath || undefined;
    this.piSessionId = opts?.piSessionId;
    if (this.process) {
      await this.stop();
    }

    // The shared agent config (~/.herman/agent) is synced once at startup (and
    // on credential/settings changes) by agent-config-sync. Await the latest
    // sync so the subprocess sees a ready config. No per-tab config is written.
    await awaitAgentConfigSynced();

    const { loadSettings } = await import("./settings.js");
    const settings = await loadSettings();
    const hermanEnabled = settings.providers.herman.enabled;

    const binaryPath = config.agentPath || resolveAgentCliPath();
    const dir = agentDir();
    this.agentDir = dir;

    const env: Record<string, string> = {
      HERMAN_AGENT_DIR: dir,
      HERMAN_APP_DIR: hermanDir(),
      HERMAN_CLIENT_VERSION: "0.0.1",
      HERMAN_TAB_ID: this.tabId,
      ...(opts?.mode ? { HERMAN_MODE: opts.mode } : {}),
    };

    const hostBridge = getActiveHostBridge();
    if (hostBridge) {
      env.HERMAN_HOST_BRIDGE_URL = hostBridge.url;
      env.HERMAN_HOST_BRIDGE_TOKEN = hostBridge.token;
    }

    if (hermanEnabled) {
      env.HERMAN_SERVER_URL = config.serverUrl;
      env.HERMAN_SESSION_TOKEN = (await this.getSessionToken()) ?? "";
      env.HERMAN_PINNED_PROVIDERS = await this.getPinnedProvidersJson();
    }

    const sessionArg = resolvePiSessionResumeArg(dir, opts?.piSessionId);

    // Wizard/headless-only extensions are passed via pi's --extension CLI arg
    // (additionalExtensionPaths), so they don't leak into normal tabs via the
    // shared settings.json.
    const extensionArgs: string[] = [];
    for (const ext of opts?.extensions ?? []) {
      extensionArgs.push("--extension", ext);
    }

    logger.info("Starting agent subprocess", {
      tabId: this.tabId,
      binaryPath,
      cwd: this.folderPath,
      sessionArg: sessionArg ?? null,
      hermanEnabled,
    });

    this.process = new AgentProcess({
      binaryPath,
      cwd: this.folderPath,
      env,
      args: [...extensionArgs, ...(sessionArg ? ["--session", sessionArg] : [])],
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
    deletePiSessionFile(this.piSessionId);
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
   * carried over an `editor` request, or a pi-goal `confirm` dialog).
   * `value` is the string the awaiting ctx.ui.editor() / select() / input()
   * call resolves to; pass `{ cancelled: true }` to cancel, or
   * `{ confirmed: true }` to accept a confirm dialog.
   */
  sendExtensionUiResponse(
    id: string,
    payload: { value: string } | { cancelled: true } | { confirmed: boolean },
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

/**
 * Resolve the agent binary path.
 *
 * Production: the compiled binary at packages/agent/dist/herman-agent
 *   (co-located with theme/ and package.json so pi's getPackageDir() — which
 *   falls back to dirname(process.execPath) — finds everything it needs).
 *
 * Dev: run from source at packages/agent/src/cli.ts. Bun.spawn can execute a
 *   .ts file directly; pi runs in non-binary mode (isBunBinary=false) and
 *   resolves @earendil-works/* from the workspace node_modules. This gives
 *   fast iteration with no agent rebuild needed.
 */
function resolveAgentCliPath(): string {
  const envPath = config.agentPath;
  if (envPath) return envPath;

  // bun --compile produces herman-agent (unix) or herman-agent.exe (win)
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const binaryName = `herman-agent${exeSuffix}`;

  // Production: app/bun/index.js -> app/packages/agent/dist/herman-agent
  const compiledPath = resolve(import.meta.dir, "..", "packages", "agent", "dist", binaryName);
  if (existsSync(compiledPath)) return compiledPath;

  // Dev: run from source — apps/desktop/src/bun -> packages/agent/src/cli.ts
  const devSrcPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "agent",
    "src",
    "cli.ts",
  );
  if (existsSync(devSrcPath)) return devSrcPath;

  // Dev fallback: a previously compiled binary in dist/
  const devDistPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "agent",
    "dist",
    binaryName,
  );
  if (existsSync(devDistPath)) return devDistPath;

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
