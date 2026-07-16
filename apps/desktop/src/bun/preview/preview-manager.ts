import { getLogger } from "@logtape/logtape";

import { normalizeExportUrlAs, type DevServer } from "../../shared/herman-manifest.js";
import { appendStderrTail } from "./preview-log-filter.js";
import { displayUrlForPort, probeUrlForPort } from "./preview-ports.js";
import {
  attachLineReaders,
  createInstanceLineHandler,
} from "./preview-process.js";
import { waitForReady } from "./preview-readiness.js";
import {
  fleetScopeKey,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_STDERR_CHARS,
  PREVIEW_READY_TIMEOUT_MS,
  previewKey,
  scopeKeyFor,
  toServerSnapshot,
  toStartResponse,
  type PreviewFleetSnapshot,
  type PreviewInstance,
  type PreviewManagerDeps,
  type PreviewPhase,
  type PreviewServerSnapshot,
  type PreviewStartRequest,
  type PreviewStartResponse,
  type StartFlight,
} from "./types.js";

const logger = getLogger(["herman-desktop", "preview", "manager"]);

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export class PreviewManager {
  private readonly previews = new Map<string, PreviewInstance>();
  private readonly settleFlights = new Map<string, Promise<void>>();
  private readonly startFlights = new Map<string, StartFlight>();
  private generationCounter = 0;

  constructor(private readonly deps: PreviewManagerDeps) {}

  /** Await an in-flight start for the given scope (spawn complete, not readiness). */
  async awaitStartFlight(folderPath: string, serverId?: string, all = false): Promise<void> {
    const scope = scopeKeyFor(folderPath, serverId, all);
    const flight = this.startFlights.get(scope);
    if (flight) await flight.promise;
  }

  async ensureStarted(req: PreviewStartRequest): Promise<PreviewStartResponse> {
    const all = Boolean(req.all || (req.servers && req.servers.length > 0));
    const serverId =
      req.serverId ??
      req.servers?.find((s) => s.primary)?.id ??
      req.servers?.[0]?.id ??
      "web";
    const scope = scopeKeyFor(req.folderPath, serverId, all);

    // Resume if already running / settling.
    const existingStatus = this.getStatus(req.folderPath, all ? undefined : serverId);
    const primary = existingStatus.servers.find((s) => s.serverId === existingStatus.primaryServerId)
      ?? existingStatus.servers[0];

    if (all && req.servers?.length) {
      const missing = req.servers.filter(
        (s) => !this.previews.has(previewKey(req.folderPath, s.id)),
      );
      if (missing.length === 0 && primary && primary.phase === "ready") {
        return toStartResponse(primary, false);
      }
      if (missing.length === 0 && primary && (primary.phase === "starting" || primary.phase === "installing")) {
        const instance = this.previews.get(previewKey(req.folderPath, primary.serverId));
        if (instance) {
          if (req.readyTimeoutMs != null) instance.readyTimeoutMs = req.readyTimeoutMs;
          this.ensureSettle(instance);
          return toStartResponse(toServerSnapshot(instance), true);
        }
      }
      // Fall through to start missing siblings / cold start.
      if (missing.length === 0 && primary?.phase === "ready") {
        return toStartResponse(primary, false);
      }
    } else if (primary && primary.serverId === serverId) {
      if (primary.phase === "ready") {
        return toStartResponse(primary, false);
      }
      const instance = this.previews.get(previewKey(req.folderPath, serverId));
      if (instance && !instance.process.killed) {
        if (req.readyTimeoutMs != null) instance.readyTimeoutMs = req.readyTimeoutMs;
        // Check HTTP ready without waiting.
        const probe = await this.deps.probe(probeUrlForPort(instance.port));
        if (probe.ok || (probe.status != null && probe.status < 500)) {
          instance.phase = "ready";
          this.emitSnapshot(instance);
          return toStartResponse(toServerSnapshot(instance), false);
        }
        // Resume settling — clear prior failed phase so UI shows starting again.
        if (instance.phase === "failed" || instance.phase === "stopped") {
          instance.phase = "starting";
          // Fresh abort controller for the new settle attempt.
          if (instance.abort.signal.aborted) {
            instance.abort = new AbortController();
          }
          this.emitSnapshot(instance);
        }
        this.ensureSettle(instance);
        return toStartResponse(toServerSnapshot(instance), true);
      }
    }

    const existingFlight = this.startFlights.get(scope);
    if (existingFlight) {
      const current = this.getStatus(req.folderPath, all ? undefined : serverId);
      const snap =
        current.servers.find((s) => s.serverId === (current.primaryServerId ?? serverId)) ??
        ({
          folderPath: req.folderPath,
          serverId,
          phase: "starting" as const,
        } satisfies PreviewServerSnapshot);
      return toStartResponse(snap, true);
    }

    // Reserve flight synchronously before any await.
    const abort = new AbortController();
    const ownedServerIds = new Set<string>();
    let resolveFlight!: () => void;
    const flightPromise = new Promise<void>((resolve) => {
      resolveFlight = resolve;
    });
    const flight: StartFlight = {
      scopeKey: scope,
      promise: flightPromise,
      abort,
      ownedServerIds,
    };
    this.startFlights.set(scope, flight);

    void (async () => {
      try {
        if (abort.signal.aborted) return;
        if (all && req.servers?.length) {
          await this.startFleet(req.folderPath, req.servers, req.installCommand, req.readyTimeoutMs, flight);
        } else {
          await this.startSingle(
            req.folderPath,
            {
              serverId,
              command: req.command,
              port: req.port,
              resolvedPort: req.resolvedPort,
              exportUrlAs: req.exportUrlAs,
              primary: true,
              installCommand: req.installCommand,
              readyTimeoutMs: req.readyTimeoutMs,
            },
            flight,
          );
        }
      } catch (err) {
        if (isAbortError(err) || abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.warning("Preview start pipeline failed", {
          folderPath: req.folderPath,
          serverId,
          error: message,
        });
        this.deps.emitStatus({
          folderPath: req.folderPath,
          serverId,
          phase: "failed",
          error: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
        });
      } finally {
        if (this.startFlights.get(scope) === flight) {
          this.startFlights.delete(scope);
        }
        resolveFlight();
      }
    })();

    return toStartResponse(
      {
        folderPath: req.folderPath,
        serverId,
        phase: "starting",
        ...(primary?.url ? { url: primary.url } : {}),
        ...(primary?.port != null ? { port: primary.port } : {}),
      },
      true,
    );
  }

  async restart(req: PreviewStartRequest): Promise<PreviewStartResponse> {
    const all = Boolean(req.all || (req.servers && req.servers.length > 0));
    if (all) {
      await this.stop(req.folderPath);
    } else {
      await this.stop(req.folderPath, req.serverId ?? "web");
    }
    return this.ensureStarted(req);
  }

  async stop(folderPath: string, serverId?: string): Promise<void> {
    // Cancel in-flight starts for this scope.
    const scopes = serverId
      ? [previewKey(folderPath, serverId), fleetScopeKey(folderPath)]
      : [...this.startFlights.keys()].filter((k) => k.startsWith(`${folderPath}::`));

    for (const scope of scopes) {
      const flight = this.startFlights.get(scope);
      if (flight) {
        flight.abort.abort();
        this.startFlights.delete(scope);
      }
    }

    const keys = [...this.previews.keys()].filter((key) => {
      if (!key.startsWith(`${folderPath}::`)) return false;
      if (!serverId) return true;
      return key === previewKey(folderPath, serverId);
    });

    for (const key of keys) {
      const instance = this.previews.get(key);
      if (!instance) continue;
      logger.info("Stopping preview server", {
        folderPath,
        serverId: instance.serverId,
        generation: instance.generation,
      });
      instance.stoppedIntentionally = true;
      instance.abort.abort();
      this.settleFlights.delete(key);
      try {
        instance.process.kill("SIGTERM");
      } catch {
        // already dead
      }
      if (this.previews.get(key) === instance) {
        this.previews.delete(key);
      }
      this.deps.emitStatus({
        folderPath: instance.folderPath,
        serverId: instance.serverId,
        phase: "stopped",
        url: instance.url,
        port: instance.port,
      });
    }
  }

  async stopAll(): Promise<void> {
    const folders = new Set([...this.previews.values()].map((p) => p.folderPath));
    for (const folder of folders) {
      await this.stop(folder);
    }
  }

  getStatus(folderPath: string, serverId?: string): PreviewFleetSnapshot {
    const instances = [...this.previews.values()].filter((p) => p.folderPath === folderPath);

    if (serverId) {
      const instance = instances.find((p) => p.serverId === serverId);
      if (!instance) {
        return {
          folderPath,
          primaryServerId: serverId,
          phase: this.isStarting(folderPath, serverId) ? "starting" : "stopped",
          servers: [],
        };
      }
      return {
        folderPath,
        primaryServerId: serverId,
        phase: instance.phase,
        servers: [toServerSnapshot(instance)],
      };
    }

    const primary =
      instances.find((p) => p.primary) ?? (instances.length > 0 ? instances[0] : undefined);
    const servers = instances.map(toServerSnapshot);
    let phase: PreviewPhase = "stopped";
    if (this.isStarting(folderPath)) phase = "starting";
    else if (primary) phase = primary.phase;
    else if (servers.some((s) => s.phase === "failed")) phase = "failed";

    return {
      folderPath,
      primaryServerId: primary?.serverId,
      phase,
      servers,
    };
  }

  private isStarting(folderPath: string, serverId?: string): boolean {
    if (serverId) {
      const key = previewKey(folderPath, serverId);
      return (
        this.settleFlights.has(key) ||
        this.startFlights.has(previewKey(folderPath, serverId)) ||
        this.startFlights.has(fleetScopeKey(folderPath))
      );
    }
    if (this.startFlights.has(fleetScopeKey(folderPath))) return true;
    for (const key of this.settleFlights.keys()) {
      if (key.startsWith(`${folderPath}::`)) return true;
    }
    for (const key of this.startFlights.keys()) {
      if (key.startsWith(`${folderPath}::`)) return true;
    }
    return false;
  }

  private async startFleet(
    folderPath: string,
    servers: DevServer[],
    installCommand: string | undefined,
    readyTimeoutMs: number | undefined,
    flight: StartFlight,
  ): Promise<void> {
    if (servers.length === 0) {
      await this.startSingle(
        folderPath,
        { serverId: "web", primary: true, installCommand, readyTimeoutMs },
        flight,
      );
      return;
    }

    if (flight.abort.signal.aborted) return;

    if (this.deps.shouldInstall(folderPath, installCommand) && installCommand) {
      const installingId = servers.find((s) => s.primary)?.id ?? servers[0]!.id;
      this.deps.emitStatus({
        folderPath,
        serverId: installingId,
        phase: "installing",
      });
      await this.deps.runInstall(folderPath, installCommand);
      if (flight.abort.signal.aborted) return;
    }

    const primary = servers.find((s) => s.primary) ?? servers[0]!;
    const ports = await this.deps.allocatePorts(servers);
    if (flight.abort.signal.aborted) return;

    const exportEnv: Record<string, string> = {};
    for (const server of servers) {
      const port = ports.get(server.id);
      if (port == null) continue;
      const url = displayUrlForPort(port);
      for (const key of normalizeExportUrlAs(server.exportUrlAs)) {
        exportEnv[key] = url;
      }
    }

    const startedOwned: string[] = [];
    try {
      for (const server of servers) {
        if (flight.abort.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const existing = this.previews.get(previewKey(folderPath, server.id));
        if (existing && !existing.process.killed) {
          // Reuse healthy existing instance — not owned by this flight.
          if (readyTimeoutMs != null) existing.readyTimeoutMs = readyTimeoutMs;
          if (existing.phase !== "ready") this.ensureSettle(existing);
          continue;
        }
        const resolvedPort = ports.get(server.id);
        if (resolvedPort == null) {
          throw new Error(`No port allocated for server ${server.id}`);
        }
        await this.spawnInstance(
          folderPath,
          {
            serverId: server.id,
            command: server.command,
            resolvedPort,
            extraEnv: exportEnv,
            primary: server.id === primary.id,
            readyTimeoutMs,
          },
          flight,
        );
        startedOwned.push(server.id);
        flight.ownedServerIds.add(server.id);
      }
    } catch (error) {
      // Roll back only members created by this operation.
      for (const id of startedOwned) {
        await this.stop(folderPath, id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async startSingle(
    folderPath: string,
    opts: {
      serverId?: string;
      command?: string;
      port?: number;
      resolvedPort?: number;
      exportUrlAs?: string | string[];
      extraEnv?: Record<string, string>;
      primary?: boolean;
      installCommand?: string;
      readyTimeoutMs?: number;
    },
    flight: StartFlight,
  ): Promise<void> {
    const serverId = opts.serverId ?? "web";
    const key = previewKey(folderPath, serverId);
    const existing = this.previews.get(key);

    if (existing && !existing.process.killed) {
      if (opts.readyTimeoutMs != null) existing.readyTimeoutMs = opts.readyTimeoutMs;
      if (existing.phase === "ready") {
        this.emitSnapshot(existing);
        return;
      }
      this.ensureSettle(existing);
      return;
    }

    if (existing) {
      await this.stop(folderPath, serverId);
    }

    if (flight.abort.signal.aborted) return;

    if (this.deps.shouldInstall(folderPath, opts.installCommand) && opts.installCommand) {
      this.deps.emitStatus({ folderPath, serverId, phase: "installing" });
      await this.deps.runInstall(folderPath, opts.installCommand);
      if (flight.abort.signal.aborted) return;
    }

    const resolvedPort =
      opts.resolvedPort ?? (await this.deps.findFreePort(opts.port ?? 4321));
    if (flight.abort.signal.aborted) return;

    const ownExportEnv: Record<string, string> = { ...(opts.extraEnv ?? {}) };
    const ownUrl = displayUrlForPort(resolvedPort);
    for (const keyName of normalizeExportUrlAs(opts.exportUrlAs)) {
      ownExportEnv[keyName] = ownUrl;
    }

    await this.spawnInstance(
      folderPath,
      {
        serverId,
        command: opts.command ?? "npm run dev",
        resolvedPort,
        extraEnv: ownExportEnv,
        primary: Boolean(opts.primary ?? serverId === "web"),
        readyTimeoutMs: opts.readyTimeoutMs,
      },
      flight,
    );
    flight.ownedServerIds.add(serverId);
  }

  private async spawnInstance(
    folderPath: string,
    opts: {
      serverId: string;
      command?: string;
      resolvedPort: number;
      extraEnv?: Record<string, string>;
      primary: boolean;
      readyTimeoutMs?: number;
    },
    flight: StartFlight,
  ): Promise<void> {
    if (flight.abort.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const serverId = opts.serverId;
    const key = previewKey(folderPath, serverId);
    const generation = ++this.generationCounter;
    const abort = new AbortController();
    // Link flight abort → instance abort.
    const onFlightAbort = () => abort.abort();
    flight.abort.signal.addEventListener("abort", onFlightAbort, { once: true });

    const command = opts.command ?? "npm run dev";
    const child = this.deps.spawnChild({
      folderPath,
      command,
      port: opts.resolvedPort,
      env: opts.extraEnv ?? {},
    });

    const instance: PreviewInstance = {
      folderPath,
      serverId,
      process: child,
      port: opts.resolvedPort,
      url: displayUrlForPort(opts.resolvedPort),
      primary: opts.primary,
      phase: "starting",
      generation,
      stoppedIntentionally: false,
      readyTimeoutMs: opts.readyTimeoutMs ?? PREVIEW_READY_TIMEOUT_MS,
      abort,
      stderrTail: "",
    };

    this.previews.set(key, instance);
    this.emitSnapshot(instance);

    const lineHandler = createInstanceLineHandler({
      onStderrChunk: (chunk) => {
        instance.stderrTail = appendStderrTail(instance.stderrTail, chunk, MAX_STDERR_CHARS);
      },
      onErrorLine: (source, line) => {
        if (this.previews.get(key) !== instance) return;
        this.deps.emitLog({
          folderPath,
          serverId,
          source,
          line,
          ts: this.deps.now?.() ?? Date.now(),
        });
      },
    });
    attachLineReaders(child, lineHandler);

    void child.exited.then((exitCode) => {
      flight.abort.signal.removeEventListener("abort", onFlightAbort);
      if (this.previews.get(key) !== instance) return;
      if (instance.generation !== generation) return;

      const intentional = instance.stoppedIntentionally;
      if (intentional) {
        // stop() already emitted stopped and deleted.
        return;
      }

      const error =
        exitCode !== 0
          ? instance.stderrTail.slice(0, MAX_ERROR_MESSAGE_CHARS) ||
            `Preview server exited with code ${exitCode}`
          : undefined;

      if (error) {
        logger.warning("Preview server exited with error", {
          folderPath,
          serverId,
          exitCode,
          stderr: error,
        });
        instance.phase = "failed";
        this.previews.delete(key);
        this.deps.emitStatus({
          folderPath,
          serverId,
          phase: "failed",
          error,
          url: instance.url,
          port: instance.port,
        });
      } else {
        logger.info("Preview server exited", { folderPath, serverId, exitCode });
        instance.phase = "stopped";
        this.previews.delete(key);
        this.deps.emitStatus({
          folderPath,
          serverId,
          phase: "stopped",
          url: instance.url,
          port: instance.port,
        });
      }
    });

    this.ensureSettle(instance);
  }

  private ensureSettle(instance: PreviewInstance): void {
    const key = previewKey(instance.folderPath, instance.serverId);
    if (this.settleFlights.has(key)) return;

    const generation = instance.generation;
    const flight = (async () => {
      try {
        await waitForReady({
          url: probeUrlForPort(instance.port),
          timeoutMs: instance.readyTimeoutMs,
          signal: instance.abort.signal,
          processExited: instance.process.exited,
          probe: this.deps.probe,
          sleep: this.deps.sleep,
          now: this.deps.now,
        });
        if (this.previews.get(key) !== instance) return;
        if (instance.generation !== generation) return;
        if (instance.stoppedIntentionally) return;
        instance.phase = "ready";
        logger.info("Preview ready", {
          folderPath: instance.folderPath,
          serverId: instance.serverId,
          url: instance.url,
        });
        this.emitSnapshot(instance);
      } catch (err) {
        if (isAbortError(err) || instance.stoppedIntentionally) return;
        if (this.previews.get(key) !== instance) return;
        if (instance.generation !== generation) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.warning("Preview failed to become ready", {
          folderPath: instance.folderPath,
          serverId: instance.serverId,
          error: message,
        });
        // Keep process for resume; mark failed.
        instance.phase = "failed";
        this.deps.emitStatus({
          folderPath: instance.folderPath,
          serverId: instance.serverId,
          phase: "failed",
          error: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
          url: instance.url,
          port: instance.port,
        });
      }
    })();

    this.settleFlights.set(key, flight);
    // Chained rather than an in-body `finally` so the closure doesn't need
    // to reference `flight` before its own initializer has finished running.
    void flight.finally(() => {
      if (this.settleFlights.get(key) === flight) {
        this.settleFlights.delete(key);
      }
    });
  }

  private emitSnapshot(instance: PreviewInstance): void {
    this.deps.emitStatus(toServerSnapshot(instance));
  }
}
