import { getLogger } from "@logtape/logtape";

import {
  normalizeExportUrlAs,
  normalizePortEnv,
  type DevServer,
} from "../../shared/herman-manifest.js";
import { appendStderrTail } from "./preview-log-filter.js";
import { displayUrlForPort, probeUrlForPort } from "./preview-ports.js";
import {
  attachLineReaders,
  createInstanceLineHandler,
  killPreviewTree,
} from "./preview-process.js";
import { isHttpReachable, waitForReady } from "./preview-readiness.js";
import {
  fleetScopeKey,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_LOG_LINE_CHARS,
  MAX_STDERR_CHARS,
  PREVIEW_READY_TIMEOUT_MS,
  previewKey,
  scopeKeyFor,
  toServerSnapshot,
  toStartResponse,
  type PortReservation,
  type PreviewChildProcess,
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

/** Grace window after spawn during which an instant EADDRINUSE death triggers a respawn. */
const EARLY_EXIT_WINDOW_MS = 750;
/** Default first port when a server declares none. */
const DEFAULT_SERVER_PORT = 4321;

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

const ADDR_IN_USE_RE = /EADDRINUSE|address already in use/i;

export function looksLikeAddrInUse(stderrTail: string): boolean {
  return ADDR_IN_USE_RE.test(stderrTail);
}

/** Substitute {port} / {url} placeholders in a server command. */
export function substituteCommandPort(command: string, port: number): string {
  return command
    .replaceAll("{port}", String(port))
    .replaceAll("{url}", displayUrlForPort(port));
}

export class PreviewManager {
  private readonly previews = new Map<string, PreviewInstance>();
  private readonly settleFlights = new Map<string, Promise<void>>();
  private readonly startFlights = new Map<string, StartFlight>();
  /** Last known folder per scope (for empty fleet snapshots). */
  private readonly scopeFolders = new Map<string, string>();
  private generationCounter = 0;

  constructor(private readonly deps: PreviewManagerDeps) {}

  /** Await an in-flight start for the given scope (spawn complete, not readiness). */
  async awaitStartFlight(scope: string, serverId?: string, all = false): Promise<void> {
    const scopeKey = scopeKeyFor(scope, serverId, all);
    const flight = this.startFlights.get(scopeKey);
    if (flight) await flight.promise;
  }

  async ensureStarted(req: PreviewStartRequest): Promise<PreviewStartResponse> {
    const { scope, folderPath } = req;
    this.scopeFolders.set(scope, folderPath);
    const all = Boolean(req.all || (req.servers && req.servers.length > 0));
    const serverId =
      req.serverId ??
      req.servers?.find((s) => s.primary)?.id ??
      req.servers?.[0]?.id ??
      "web";
    const scopeKey = scopeKeyFor(scope, serverId, all);

    // Resume if already running / settling.
    const existingStatus = this.getStatus(scope, all ? undefined : serverId);
    const primary = existingStatus.servers.find((s) => s.serverId === existingStatus.primaryServerId)
      ?? existingStatus.servers[0];

    if (all && req.servers?.length) {
      const missing = req.servers.filter(
        (s) => !this.previews.has(previewKey(scope, s.id)),
      );
      if (missing.length === 0 && primary && primary.phase === "ready") {
        return toStartResponse(primary, false);
      }
      if (missing.length === 0 && primary && primary.phase === "starting") {
        const instance = this.previews.get(previewKey(scope, primary.serverId));
        if (instance) {
          if (req.readyTimeoutMs != null) instance.readyTimeoutMs = req.readyTimeoutMs;
          this.ensureSettle(instance);
          return toStartResponse(toServerSnapshot(instance), true);
        }
      }
    } else if (primary && primary.serverId === serverId) {
      if (primary.phase === "ready") {
        return toStartResponse(primary, false);
      }
      const instance = this.previews.get(previewKey(scope, serverId));
      if (instance && !instance.process.killed) {
        if (req.readyTimeoutMs != null) instance.readyTimeoutMs = req.readyTimeoutMs;
        // Check HTTP ready without waiting.
        const probe = await this.deps.probe(probeUrlForPort(instance.port));
        if (isHttpReachable(probe)) {
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

    const existingFlight = this.startFlights.get(scopeKey);
    if (existingFlight) {
      const current = this.getStatus(scope, all ? undefined : serverId);
      const snap =
        current.servers.find((s) => s.serverId === (current.primaryServerId ?? serverId)) ??
        ({
          scope,
          folderPath,
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
      scopeKey,
      promise: flightPromise,
      abort,
      ownedServerIds,
    };
    this.startFlights.set(scopeKey, flight);

    void (async () => {
      try {
        if (abort.signal.aborted) return;
        if (all && req.servers?.length) {
          await this.startFleet(scope, folderPath, req.servers, req.reservedPorts, req.readyTimeoutMs, flight);
        } else {
          await this.startSingle(
            scope,
            folderPath,
            {
              serverId,
              command: req.command,
              port: req.port,
              // Pre-reserved ports are used verbatim.
              resolvedPort: req.resolvedPort ?? req.reservedPorts?.get(serverId)?.port,
              exportUrlAs: req.exportUrlAs,
              portEnv: req.portEnv,
              primary: true,
              readyTimeoutMs: req.readyTimeoutMs,
              holdRelease: req.reservedPorts?.get(serverId)?.release,
            },
            flight,
          );
        }
      } catch (err) {
        if (isAbortError(err) || abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.warning("Preview start pipeline failed", {
          scope,
          folderPath,
          serverId,
          error: message,
        });
        this.deps.emitStatus({
          scope,
          folderPath,
          serverId,
          phase: "failed",
          error: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
        });
      } finally {
        if (this.startFlights.get(scopeKey) === flight) {
          this.startFlights.delete(scopeKey);
        }
        resolveFlight();
      }
    })();

    return toStartResponse(
      {
        scope,
        folderPath,
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
      await this.stop(req.scope);
    } else {
      await this.stop(req.scope, req.serverId ?? "web");
    }
    return this.ensureStarted(req);
  }

  async stop(scope: string, serverId?: string): Promise<void> {
    // Cancel in-flight starts for this scope.
    const scopeKeys = serverId
      ? [previewKey(scope, serverId), fleetScopeKey(scope)]
      : [...this.startFlights.keys()].filter((k) => k.startsWith(`${scope}::`));

    for (const scopeKey of scopeKeys) {
      const flight = this.startFlights.get(scopeKey);
      if (flight) {
        flight.abort.abort();
        this.startFlights.delete(scopeKey);
      }
    }

    const keys = [...this.previews.keys()].filter((key) => {
      if (!key.startsWith(`${scope}::`)) return false;
      if (!serverId) return true;
      return key === previewKey(scope, serverId);
    });

    for (const key of keys) {
      const instance = this.previews.get(key);
      if (!instance) continue;
      logger.info("Stopping preview server", {
        scope,
        serverId: instance.serverId,
        generation: instance.generation,
      });
      instance.stoppedIntentionally = true;
      instance.abort.abort();
      this.settleFlights.delete(key);
      await killPreviewTree(instance.process);
      if (this.previews.get(key) === instance) {
        this.previews.delete(key);
      }
      await this.deps.ports?.free(instance.port, scope);
      this.deps.emitStatus({
        scope,
        folderPath: instance.folderPath,
        serverId: instance.serverId,
        phase: "stopped",
        url: instance.url,
        port: instance.port,
      });
    }
  }

  /** Stop every instance whose working directory is `folderPath` (any scope). */
  async stopFolder(folderPath: string): Promise<void> {
    const scopes = new Set(
      [...this.previews.values()]
        .filter((p) => p.folderPath === folderPath)
        .map((p) => p.scope),
    );
    for (const scope of scopes) {
      await this.stop(scope);
    }
  }

  async stopAll(): Promise<void> {
    const scopes = new Set([...this.previews.values()].map((p) => p.scope));
    for (const scope of scopes) {
      await this.stop(scope);
    }
  }

  getStatus(scope: string, serverId?: string): PreviewFleetSnapshot {
    const instances = [...this.previews.values()].filter((p) => p.scope === scope);
    const folderPath = instances[0]?.folderPath ?? this.scopeFolders.get(scope) ?? "";

    if (serverId) {
      const instance = instances.find((p) => p.serverId === serverId);
      if (!instance) {
        return {
          scope,
          folderPath,
          primaryServerId: serverId,
          phase: this.isStarting(scope, serverId) ? "starting" : "stopped",
          servers: [],
        };
      }
      return {
        scope,
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
    if (this.isStarting(scope)) phase = "starting";
    else if (primary) phase = primary.phase;
    else if (servers.some((s) => s.phase === "failed")) phase = "failed";

    return {
      scope,
      folderPath,
      primaryServerId: primary?.serverId,
      phase,
      servers,
    };
  }

  private isStarting(scope: string, serverId?: string): boolean {
    if (serverId) {
      const key = previewKey(scope, serverId);
      return (
        this.settleFlights.has(key) ||
        this.startFlights.has(previewKey(scope, serverId)) ||
        this.startFlights.has(fleetScopeKey(scope))
      );
    }
    if (this.startFlights.has(fleetScopeKey(scope))) return true;
    for (const key of this.settleFlights.keys()) {
      if (key.startsWith(`${scope}::`)) return true;
    }
    for (const key of this.startFlights.keys()) {
      if (key.startsWith(`${scope}::`)) return true;
    }
    return false;
  }

  /**
   * Find a free port that is not owned by another scope (skips registry
   * reservations held for other tabs).
   */
  private async allocateFreePort(startPort: number, scope: string): Promise<number> {
    let candidate = await this.deps.findFreePort(startPort);
    if (!this.deps.ports) return candidate;
    for (let attempts = 0; attempts < 50; attempts++) {
      const owner = this.deps.ports.getPortOwner(candidate);
      if (owner == null || owner === scope) return candidate;
      candidate = await this.deps.findFreePort(candidate + 1);
    }
    return candidate;
  }

  private async startFleet(
    scope: string,
    folderPath: string,
    servers: DevServer[],
    reservedPorts: Map<string, PortReservation> | undefined,
    readyTimeoutMs: number | undefined,
    flight: StartFlight,
  ): Promise<void> {
    if (servers.length === 0) {
      await this.startSingle(scope, folderPath, { serverId: "web", primary: true, readyTimeoutMs }, flight);
      return;
    }

    if (flight.abort.signal.aborted) return;

    // Resolve one port per server — pre-reserved ports are used verbatim.
    const ports = new Map<string, number>();
    const used = new Set<number>();
    for (const server of servers) {
      const reserved = reservedPorts?.get(server.id);
      let port = reserved?.port;
      if (port == null) {
        port = await this.allocateFreePort(server.port ?? DEFAULT_SERVER_PORT, scope);
        while (used.has(port)) {
          port = await this.allocateFreePort(port + 1, scope);
        }
      }
      used.add(port);
      ports.set(server.id, port);
    }
    if (flight.abort.signal.aborted) return;

    const primary = servers.find((s) => s.primary) ?? servers[0]!;

    // Per-server env builder: fleet-wide exportUrlAs (with this server's port
    // substituted when it respawns on a new port) + own portEnv.
    const envFor =
      (server: DevServer) =>
      (port: number): Record<string, string> => {
        const env: Record<string, string> = {};
        for (const s of servers) {
          const p = s.id === server.id ? port : ports.get(s.id);
          if (p == null) continue;
          const url = displayUrlForPort(p);
          for (const key of normalizeExportUrlAs(s.exportUrlAs)) {
            env[key] = url;
          }
        }
        for (const key of normalizePortEnv(server.portEnv)) {
          env[key] = String(port);
        }
        return env;
      };

    const startedOwned: string[] = [];
    try {
      for (const server of servers) {
        if (flight.abort.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const existing = this.previews.get(previewKey(scope, server.id));
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
          scope,
          folderPath,
          {
            serverId: server.id,
            commandForPort: (port) => substituteCommandPort(server.command, port),
            envForPort: envFor(server),
            initialPort: resolvedPort,
            primary: server.id === primary.id,
            readyTimeoutMs,
            holdRelease: reservedPorts?.get(server.id)?.release,
          },
          flight,
        );
        startedOwned.push(server.id);
        flight.ownedServerIds.add(server.id);
      }
    } catch (error) {
      // Roll back only members created by this operation.
      for (const id of startedOwned) {
        await this.stop(scope, id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async startSingle(
    scope: string,
    folderPath: string,
    opts: {
      serverId?: string;
      command?: string;
      port?: number;
      resolvedPort?: number;
      exportUrlAs?: string | string[];
      portEnv?: string | string[];
      primary?: boolean;
      readyTimeoutMs?: number;
      holdRelease?: () => Promise<void>;
    },
    flight: StartFlight,
  ): Promise<void> {
    const serverId = opts.serverId ?? "web";
    const key = previewKey(scope, serverId);
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
      await this.stop(scope, serverId);
    }

    if (flight.abort.signal.aborted) return;

    const resolvedPort =
      opts.resolvedPort ?? (await this.allocateFreePort(opts.port ?? DEFAULT_SERVER_PORT, scope));
    if (flight.abort.signal.aborted) return;

    const command = opts.command ?? "npm run dev";
    const envForPort = (port: number): Record<string, string> => {
      const env: Record<string, string> = {};
      const url = displayUrlForPort(port);
      for (const keyName of normalizeExportUrlAs(opts.exportUrlAs)) {
        env[keyName] = url;
      }
      for (const keyName of normalizePortEnv(opts.portEnv)) {
        env[keyName] = String(port);
      }
      return env;
    };

    await this.spawnInstance(
      scope,
      folderPath,
      {
        serverId,
        commandForPort: (port) => substituteCommandPort(command, port),
        envForPort,
        initialPort: resolvedPort,
        primary: Boolean(opts.primary ?? serverId === "web"),
        readyTimeoutMs: opts.readyTimeoutMs,
        holdRelease: opts.holdRelease,
      },
      flight,
    );
    flight.ownedServerIds.add(serverId);
  }

  private async spawnInstance(
    scope: string,
    folderPath: string,
    opts: {
      serverId: string;
      commandForPort: (port: number) => string;
      envForPort: (port: number) => Record<string, string>;
      initialPort: number;
      primary: boolean;
      readyTimeoutMs?: number;
      holdRelease?: () => Promise<void>;
    },
    flight: StartFlight,
  ): Promise<void> {
    if (flight.abort.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    let port = opts.initialPort;
    let holdReleased = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (flight.abort.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      // Release the reservation hold immediately before spawning so the
      // child can bind the port (hold-and-release, atomic from the outside).
      if (!holdReleased) {
        holdReleased = true;
        if (opts.holdRelease) {
          await opts.holdRelease().catch((err) => {
            logger.debug("Port reservation release failed (continuing)", {
              port,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }

      const instance = this.createInstance(scope, folderPath, opts, port, flight);
      const earlyExit = await this.raceEarlyExit(instance);

      if (
        attempt === 0 &&
        earlyExit != null &&
        looksLikeAddrInUse(instance.stderrTail) &&
        !flight.abort.signal.aborted
      ) {
        // The tiny release→bind window was lost (or the preferred port was
        // squatted): free this port, allocate the next one, respawn once.
        logger.warning("Preview server died instantly with EADDRINUSE; retrying on next port", {
          scope,
          serverId: opts.serverId,
          port,
          exitCode: earlyExit,
        });
        instance.stoppedIntentionally = true;
        await killPreviewTree(instance.process);
        const key = previewKey(scope, opts.serverId);
        if (this.previews.get(key) === instance) {
          this.previews.delete(key);
        }
        await this.deps.ports?.free(port, scope);
        port = await this.allocateFreePort(port + 1, scope);
        continue;
      }

      this.watchExit(scope, instance, flight);
      this.ensureSettle(instance);
      return;
    }
  }

  /** Resolve with the exit code when the child dies within the grace window. */
  private async raceEarlyExit(instance: PreviewInstance): Promise<number | null> {
    return Promise.race([
      instance.process.exited.then(async (code) => {
        // Give line readers a tick to drain stderr before we inspect the tail.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return code as number | null;
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), EARLY_EXIT_WINDOW_MS)),
    ]);
  }

  private createInstance(
    scope: string,
    folderPath: string,
    opts: {
      serverId: string;
      commandForPort: (port: number) => string;
      envForPort: (port: number) => Record<string, string>;
      primary: boolean;
      readyTimeoutMs?: number;
    },
    port: number,
    flight: StartFlight,
  ): PreviewInstance {
    const serverId = opts.serverId;
    const key = previewKey(scope, serverId);
    const generation = ++this.generationCounter;
    const abort = new AbortController();
    // Link flight abort → instance abort.
    const onFlightAbort = () => abort.abort();
    flight.abort.signal.addEventListener("abort", onFlightAbort, { once: true });
    // The flight listener is removed for good in watchExit; instances that
    // die before watchExit runs still get a leaked-free once-listener via
    // the flight's eventual settle.
    const command = opts.commandForPort(port);
    const child = this.deps.spawnChild({
      folderPath,
      command,
      port,
      env: opts.envForPort(port),
    });
    this.deps.ports?.claim(port, scope);

    const instance: PreviewInstance = {
      scope,
      folderPath,
      serverId,
      process: child,
      port,
      url: displayUrlForPort(port),
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

    const baseHandler = createInstanceLineHandler({
      onStderrChunk: (chunk) => {
        instance.stderrTail = appendStderrTail(instance.stderrTail, chunk, MAX_STDERR_CHARS);
      },
      onErrorLine: (source, line) => {
        if (this.previews.get(key) !== instance) return;
        if (instance.stoppedIntentionally) return;
        logger.info("Preview error line detected", {
          scope,
          folderPath,
          serverId,
          source,
          line,
        });
        this.deps.emitLog({
          scope,
          folderPath,
          serverId,
          source,
          line,
          ts: this.deps.now?.() ?? Date.now(),
        });
      },
    });

    const tapped = Object.assign(
      ((source: "stdout" | "stderr", line: string) => {
        this.deps.emitLine?.({
          scope,
          folderPath,
          serverId,
          source,
          line: line.slice(0, MAX_LOG_LINE_CHARS),
          ts: this.deps.now?.() ?? Date.now(),
        });
        baseHandler(source, line);
      }) as typeof baseHandler & { flush: () => void },
      { flush: () => baseHandler.flush() },
    );
    attachLineReaders(child, tapped);

    // Stash for watchExit / early-exit cleanup.
    instanceWiring.set(instance, { tapped, onFlightAbort, flight });
    return instance;
  }

  private watchExit(scope: string, instance: PreviewInstance, flight: StartFlight): void {
    const key = previewKey(scope, instance.serverId);
    const generation = instance.generation;
    const wiring = instanceWiring.get(instance);

    void instance.process.exited.then((exitCode) => {
      // Drain any in-progress error context window so partial output isn't lost.
      wiring?.tapped.flush();
      if (wiring) {
        wiring.flight.abort.signal.removeEventListener("abort", wiring.onFlightAbort);
        instanceWiring.delete(instance);
      }
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
          scope,
          serverId: instance.serverId,
          exitCode,
          stderr: error,
        });
        instance.phase = "failed";
        this.previews.delete(key);
        void this.deps.ports?.free(instance.port, scope);
        this.deps.emitStatus({
          scope,
          folderPath: instance.folderPath,
          serverId: instance.serverId,
          phase: "failed",
          error,
          url: instance.url,
          port: instance.port,
        });
      } else {
        logger.info("Preview server exited", { scope, serverId: instance.serverId, exitCode });
        instance.phase = "stopped";
        this.previews.delete(key);
        void this.deps.ports?.free(instance.port, scope);
        this.deps.emitStatus({
          scope,
          folderPath: instance.folderPath,
          serverId: instance.serverId,
          phase: "stopped",
          url: instance.url,
          port: instance.port,
        });
      }
    });
  }

  private ensureSettle(instance: PreviewInstance): void {
    const key = previewKey(instance.scope, instance.serverId);
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

        // Ownership guard: a responding port owned by another scope means a
        // cross-session clash — never adopt it as ours.
        const owner = this.deps.ports?.getPortOwner(instance.port);
        if (owner != null && owner !== instance.scope) {
          logger.debug("Preview port clash detected at readiness", {
            scope: instance.scope,
            serverId: instance.serverId,
            port: instance.port,
            owner,
          });
          instance.phase = "failed";
          this.deps.emitStatus({
            scope: instance.scope,
            folderPath: instance.folderPath,
            serverId: instance.serverId,
            phase: "failed",
            error: `Port ${instance.port} is already owned by another preview session.`,
            url: instance.url,
            port: instance.port,
          });
          return;
        }

        instance.phase = "ready";
        logger.info("Preview ready", {
          scope: instance.scope,
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
          scope: instance.scope,
          folderPath: instance.folderPath,
          serverId: instance.serverId,
          error: message,
        });
        // Keep process for resume; mark failed.
        instance.phase = "failed";
        this.deps.emitStatus({
          scope: instance.scope,
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

/** Per-instance wiring shared between createInstance and watchExit. */
const instanceWiring = new WeakMap<
  PreviewInstance,
  {
    tapped: { flush: () => void };
    onFlightAbort: () => void;
    flight: StartFlight;
  }
>();
