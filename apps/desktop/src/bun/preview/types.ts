import type { Subprocess } from "bun";

import type { DevServer } from "../../shared/herman-manifest.js";
import type {
  PreviewFleetSnapshot,
  PreviewLogEvent,
  PreviewPhase,
  PreviewServerSnapshot,
  PreviewStartResponse,
} from "../../shared/preview.js";

export type {
  PreviewFleetSnapshot,
  PreviewLogEvent,
  PreviewPhase,
  PreviewServerSnapshot,
  PreviewStartResponse,
};

export const PREVIEW_READY_TIMEOUT_MS = 20_000;
export const PREVIEW_READY_POLL_MS = 300;
export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_STDERR_CHARS = 8_192;

/** Abstract child process used by PreviewManager (real Bun subprocess or fake). */
export type PreviewChildProcess = {
  killed: boolean;
  /** OS pid when available; used for process-group teardown. */
  pid?: number;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill: (signal?: string) => void;
};

export type SpawnChildOpts = {
  folderPath: string;
  command: string;
  port: number;
  env: Record<string, string>;
};

export type PreviewProbeResult = {
  ok: boolean;
  status?: number;
};

export type PreviewInstance = {
  folderPath: string;
  serverId: string;
  process: PreviewChildProcess;
  port: number;
  url: string;
  primary: boolean;
  phase: PreviewPhase;
  generation: number;
  stoppedIntentionally: boolean;
  readyTimeoutMs: number;
  abort: AbortController;
  /** Ring buffer of recent stderr for crash messages. */
  stderrTail: string;
};

export type PreviewStartRequest = {
  folderPath: string;
  servers?: DevServer[];
  installCommand?: string;
  serverId?: string;
  command?: string;
  port?: number;
  /** Exact pre-resolved port; skips findFreePort when set. */
  resolvedPort?: number;
  exportUrlAs?: string | string[];
  all?: boolean;
  readyTimeoutMs?: number;
};

export type StartFlight = {
  scopeKey: string;
  promise: Promise<void>;
  abort: AbortController;
  /** Server IDs spawned by this flight (for partial rollback). */
  ownedServerIds: Set<string>;
};

export type PreviewManagerDeps = {
  spawnChild: (opts: SpawnChildOpts) => PreviewChildProcess;
  probe: (url: string, signal?: AbortSignal) => Promise<PreviewProbeResult>;
  findFreePort: (startPort: number) => Promise<number>;
  allocatePorts: (servers: { id: string; port?: number }[]) => Promise<Map<string, number>>;
  runInstall: (folderPath: string, installCommand: string) => Promise<void>;
  shouldInstall: (folderPath: string, installCommand: string | undefined) => boolean;
  emitStatus: (snapshot: PreviewServerSnapshot) => void;
  emitLog: (event: PreviewLogEvent) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Convert a Bun Subprocess into the abstract PreviewChildProcess. */
export function wrapBunSubprocess(proc: Subprocess): PreviewChildProcess {
  return {
    get killed() {
      return proc.killed;
    },
    pid: proc.pid,
    exited: proc.exited,
    stdout: proc.stdout as ReadableStream<Uint8Array> | null,
    stderr: proc.stderr as ReadableStream<Uint8Array> | null,
    kill: (signal) => {
      try {
        if (signal) proc.kill(signal as NodeJS.Signals);
        else proc.kill();
      } catch {
        // Process may already be dead.
      }
    },
  };
}

export function toServerSnapshot(instance: PreviewInstance): PreviewServerSnapshot {
  return {
    folderPath: instance.folderPath,
    serverId: instance.serverId,
    phase: instance.phase,
    url: instance.url,
    port: instance.port,
    ...(instance.phase === "failed" && instance.stderrTail
      ? { error: instance.stderrTail.slice(0, MAX_ERROR_MESSAGE_CHARS) }
      : {}),
  };
}

export function toStartResponse(
  snapshot: PreviewServerSnapshot,
  starting: boolean,
): PreviewStartResponse {
  return { ...snapshot, starting };
}

export function previewKey(folderPath: string, serverId: string): string {
  return `${folderPath}::${serverId}`;
}

export function fleetScopeKey(folderPath: string): string {
  return `${folderPath}::*`;
}

export function scopeKeyFor(
  folderPath: string,
  serverId: string | undefined,
  all: boolean,
): string {
  return all ? fleetScopeKey(folderPath) : previewKey(folderPath, serverId ?? "web");
}
