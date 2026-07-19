import { getLogger } from "@logtape/logtape";

import type {
  ProjectManifestView} from "../../shared/herman-manifest.js";
import type { PreviewServerLogLine } from "../../shared/preview.js";
import { tabScope } from "../../shared/preview.js";
import type {
  PersistedSession,
  SessionIsolation,
  SessionSetupState,
  SessionWorktree,
  Tab,
  TabId,
} from "../../shared/rpc.js";
import { getProjectName } from "../../shared/tab-utils.js";
import { readProjectManifest } from "../project-manifest.js";
import { isGitRepo } from "../rewind-core.js";
import { planHash, resolveSetupPlan, type ResolvedSetupPlan } from "../setup-plan.js";
import {
  createSessionWorktree,
  ensureSessionWorktree,
} from "../worktree.js";
import type { PortRegistry, PortReservation } from "../preview/port-registry.js";
import {
  ENV_BASE_STEP_ID,
  ENV_GENERATE_STEP_ID,
  SETUP_SERVER_ID,
  WorkspaceSetupRunner,
  type SessionBindingValues,
} from "./setup-runner.js";

const logger = getLogger(["herman-desktop", "session-bootstrap"]);

const MAX_CONCURRENT_SETUPS = 2;

export type BootstrapIntent = {
  kind: "create" | "open" | "repair" | "retry";
};

export type SessionStateChangedPayload = {
  tabId: TabId;
  setup: SessionSetupState;
  folderPath?: string;
  projectRoot?: string;
  worktree?: SessionWorktree;
};

/**
 * The single isolation policy: one place answers "what isolation does this
 * session get?". A session's isolation is fixed at creation and persisted —
 * reopening never upgrades direct → worktree (no silent migration).
 */
export async function resolveIsolationPolicy(
  mode: "rookie" | "normal" | undefined,
  projectRoot: string,
): Promise<SessionIsolation> {
  if (mode === "rookie" && projectRoot && (await isGitRepo(projectRoot))) {
    return "worktree";
  }
  return "direct";
}

export type SessionBootstrapperDeps = {
  getTab: (tabId: TabId) => Tab | undefined;
  patchTab: (tabId: TabId, patch: Partial<Omit<Tab, "id" | "createdAt">>) => void;
  getPersisted: (tabId: TabId) => PersistedSession | undefined;
  patchPersisted: (tabId: TabId, patch: Partial<PersistedSession>) => void;
  isTabOpen: (tabId: TabId) => boolean;
  getMode: () => "rookie" | "normal" | undefined;
  scheduleAgent: (tabId: TabId) => void;
  emitState: (payload: SessionStateChangedPayload) => void;
  emitServerLine: (line: PreviewServerLogLine) => void;
  persist: () => Promise<void>;
  portRegistry: PortRegistry;
  ensurePreviewStarted: (
    scope: string,
    folderPath: string,
    opts: {
      servers?: ProjectManifestView["servers"];
      all?: boolean;
      reservedPorts?: Map<string, PortReservation>;
    },
  ) => Promise<unknown>;
  readManifest?: (
    folderPath: string,
    projectRoot?: string,
  ) => Promise<ProjectManifestView | undefined>;
};

/**
 * The single pipeline that takes a tab from created to ready:
 *   plan → provision (worktree) → reserve ports → setup (manifest recipe)
 *   → agent → preview.
 * Nothing else creates worktrees, runs installs, starts agents, or starts
 * previews. Every transition is pushed to the renderer via
 * `sessionStateChanged`.
 */
export class SessionBootstrapper {
  private readonly chains = new Map<TabId, Promise<void>>();
  private readonly reservations = new Map<TabId, Map<string, PortReservation>>();
  private queue: { tabId: TabId; intent: BootstrapIntent; done: () => void }[] = [];
  private active = 0;

  constructor(private readonly deps: SessionBootstrapperDeps) {}

  /**
   * Queue a bootstrap run for a tab. Runs are single-flight per tab (a retry
   * chains after the in-flight run) and bounded globally
   * (MAX_CONCURRENT_SETUPS — setup is IO/CPU heavy).
   */
  bootstrap(tabId: TabId, intent: BootstrapIntent): Promise<void> {
    const prev = this.chains.get(tabId) ?? Promise.resolve();
    const next = prev.then(() => this.enqueue(tabId, intent));
    this.chains.set(tabId, next);
    void next.finally(() => {
      if (this.chains.get(tabId) === next) {
        this.chains.delete(tabId);
      }
    });
    return next;
  }

  /** Re-run the setup pipeline after a setup failure (user-triggered). */
  async retry(tabId: TabId): Promise<{ ok: boolean; error?: string }> {
    const tab = this.deps.getTab(tabId);
    if (!tab) return { ok: false, error: "Tab not found" };
    await this.bootstrap(tabId, { kind: "retry" });
    const after = this.deps.getTab(tabId);
    if (after?.setup.phase === "error") {
      return { ok: false, error: after.setup.error };
    }
    return { ok: true };
  }

  /** Release port reservations held for a tab (session teardown). */
  async dispose(tabId: TabId): Promise<void> {
    const reservations = this.reservations.get(tabId);
    this.reservations.delete(tabId);
    if (reservations) {
      for (const reservation of reservations.values()) {
        await reservation.release().catch(() => undefined);
      }
    }
    await this.deps.portRegistry.freeOwner(tabScope(tabId)).catch(() => undefined);
  }

  private enqueue(tabId: TabId, intent: BootstrapIntent): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ tabId, intent, done: resolve });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_SETUPS && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void this.runPipeline(job.tabId, job.intent)
        .catch((error) => {
          logger.error("Session bootstrap pipeline crashed", {
            tabId: job.tabId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.active--;
          job.done();
          this.pump();
        });
    }
  }

  private async runPipeline(tabId: TabId, intent: BootstrapIntent): Promise<void> {
    const tab = this.deps.getTab(tabId);
    if (!tab || !this.deps.isTabOpen(tabId)) return;

    const persisted = this.deps.getPersisted(tabId);
    const projectRoot = tab.projectRoot || tab.folderPath;
    const mode = this.deps.getMode();

    // ── 1. plan: isolation (persisted wins — never upgrade direct→worktree) ──
    let isolation = persisted?.isolation;
    if (!isolation) {
      isolation = tab.worktree
        ? "worktree"
        : await resolveIsolationPolicy(mode, projectRoot);
      this.deps.patchPersisted(tabId, { isolation });
    }

    if (isolation === "direct") {
      // Setup recipes are for fresh copies — direct sessions never run them
      // in place. The agent starts immediately; previews auto-start for
      // rookie tabs with manifest servers.
      this.setSetup(tabId, { phase: "none" });
      this.deps.scheduleAgent(tabId);
      await this.maybeAutoStartPreview(tabId);
      return;
    }

    // ── 2. provision: create / re-attach the worktree ──
    const manifest = await this.readManifest(projectRoot, projectRoot);
    const plan = resolveSetupPlan(manifest);

    this.setSetup(tabId, {
      phase: "pending",
      step: "provision",
      label: "Creating your workspace…",
      steps: pendingSteps(plan),
    });

    let folderPath = tab.folderPath;
    let worktree = tab.worktree;
    try {
      if (!worktree) {
        const created = await createSessionWorktree(projectRoot, tabId);
        folderPath = created.folderPath;
        worktree = created.worktree;
      } else {
        folderPath = await ensureSessionWorktree({ id: tabId, worktree, folderPath });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to provision session worktree", { tabId, error: message });
      // No isolated workspace exists — do NOT start the agent on the main tree.
      this.failSetup(tabId, "provision", `Failed to create the session workspace: ${message}`, "");
      return;
    }

    if (!this.deps.isTabOpen(tabId)) return;
    this.deps.patchTab(tabId, { folderPath, worktree });
    this.emitState(tabId);
    await this.deps.persist();

    // ── 3. reserve ports (BEFORE setup: env files need the values) ──
    if (plan.servers.length > 0 && !this.reservations.has(tabId)) {
      const reservations = new Map<string, PortReservation>();
      try {
        for (const server of plan.servers) {
          const reservation = await this.deps.portRegistry.reserve(
            server.port ?? 4321,
            tabScope(tabId),
          );
          reservations.set(server.id, reservation);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const reservation of reservations.values()) {
          await reservation.release().catch(() => undefined);
        }
        this.failSetup(tabId, "reserve-ports", `Failed to reserve preview ports: ${message}`, "");
        return;
      }
      this.reservations.set(tabId, reservations);
    }
    const reservations = this.reservations.get(tabId) ?? new Map<string, PortReservation>();

    // ── 4. setup: manifest recipe, idempotent + resumable ──
    const bindings: SessionBindingValues = {
      tabId,
      workspace: folderPath,
      main: projectRoot,
      branch: worktree.branch,
      ...(plan.projectName || projectRoot
        ? { projectName: plan.projectName ?? getProjectName(projectRoot) }
        : {}),
      serverPorts: Object.fromEntries([...reservations].map(([id, r]) => [id, r.port])),
    };

    const runner = new WorkspaceSetupRunner({
      onSteps: (steps) => {
        if (!this.deps.isTabOpen(tabId)) return;
        const running = steps.find((s) => s.status === "running");
        this.setSetup(tabId, {
          phase: "pending",
          ...(running ? { step: running.id, label: running.label } : { label: "Setting up your workspace…" }),
          steps,
        });
      },
      onLine: (source, line) => {
        this.deps.emitServerLine({
          scope: tabScope(tabId),
          folderPath,
          serverId: SETUP_SERVER_ID,
          source,
          line,
          ts: Date.now(),
        });
      },
    });

    const result = await runner.run({ workspace: folderPath, mainRoot: projectRoot, plan, bindings });
    if (!this.deps.isTabOpen(tabId)) return;

    if (!result.ok) {
      logger.warning("Session setup failed", { tabId, step: result.step, error: result.error });
      this.failSetup(tabId, result.step, result.error, result.output);
      // The agent is the best fixer and runs in the same workspace — start
      // it even though setup failed (retryable).
      this.deps.scheduleAgent(tabId);
      await this.deps.persist();
      return;
    }

    if (result.warnings.length > 0) {
      logger.info("Session setup completed with warnings", {
        tabId,
        warnings: result.warnings.map((w) => `${w.stepId}: ${w.error}`),
      });
    }

    // ── 5. ready → agent ──
    this.deps.patchPersisted(tabId, {
      setupCompletedAt: Date.now(),
      setupPlanHash: planHash(plan),
    });
    this.setSetup(tabId, { phase: "ready" });
    this.deps.scheduleAgent(tabId);
    await this.deps.persist();
    logger.info("Session workspace ready", { tabId, folderPath, intent: intent.kind });

    // ── 6. preview (rookie policy; servers present; not manually stopped) ──
    await this.maybeAutoStartPreview(tabId);
  }

  private async maybeAutoStartPreview(tabId: TabId): Promise<void> {
    const tab = this.deps.getTab(tabId);
    if (!tab || !this.deps.isTabOpen(tabId)) return;
    if (!tab.folderPath) return;
    if (this.deps.getMode() !== "rookie") return;
    const persisted = this.deps.getPersisted(tabId);
    if (persisted?.previewManuallyStopped) {
      logger.debug("Preview auto-start skipped (manually stopped by user)", { tabId });
      return;
    }
    const manifest = await this.readManifest(tab.projectRoot || tab.folderPath, tab.projectRoot);
    const servers = manifest?.servers ?? [];
    if (servers.length === 0) return;

    try {
      await this.deps.ensurePreviewStarted(tabScope(tabId), tab.folderPath, {
        servers,
        all: true,
        reservedPorts: this.reservations.get(tabId),
      });
    } catch (error) {
      // Preview failure is not a setup failure — the status events carry it.
      logger.warning("Preview auto-start failed", {
        tabId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private failSetup(tabId: TabId, step: string, error: string, output: string): void {
    this.setSetup(tabId, { phase: "error", step, error, retryable: true, output });
    void this.deps.persist();
  }

  private setSetup(tabId: TabId, setup: SessionSetupState): void {
    this.deps.patchTab(tabId, { setup });
    this.emitState(tabId);
  }

  private emitState(tabId: TabId): void {
    const tab = this.deps.getTab(tabId);
    if (!tab) return;
    this.deps.emitState({
      tabId,
      setup: tab.setup,
      folderPath: tab.folderPath,
      projectRoot: tab.projectRoot,
      ...(tab.worktree ? { worktree: tab.worktree } : {}),
    });
  }

  private async readManifest(
    folderPath: string,
    projectRoot?: string,
  ): Promise<ProjectManifestView | undefined> {
    if (!folderPath) return undefined;
    const reader = this.deps.readManifest ?? readProjectManifest;
    try {
      return await reader(folderPath, projectRoot);
    } catch (error) {
      logger.warning("Failed to read project manifest for bootstrap", {
        folderPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

function pendingSteps(plan: ResolvedSetupPlan): { id: string; label: string; status: "pending" }[] {
  return [
    { id: ENV_BASE_STEP_ID, label: "Preparing environment files", status: "pending" },
    ...plan.setupSteps.map((s) => ({ id: s.id, label: s.label, status: "pending" as const })),
    { id: ENV_GENERATE_STEP_ID, label: "Generating secrets", status: "pending" },
  ];
}
