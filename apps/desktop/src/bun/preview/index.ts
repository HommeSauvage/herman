import type { DevServer } from "../../shared/herman-manifest.js";
import type {
  PreviewFleetSnapshot,
  PreviewLogEvent,
  PreviewServerLogLine,
  PreviewServerSnapshot,
} from "../../shared/preview.js";
import { PortRegistry, previewPortRegistry } from "./port-registry.js";
import { PreviewManager } from "./preview-manager.js";
import {
  buildExportEnv as buildExportEnvImpl,
  displayUrlForPort,
  findFreePort as findFreePortImpl,
  probeUrlForPort as probeUrlForPortImpl,
} from "./preview-ports.js";
import { spawnPreviewChild } from "./preview-process.js";
import { httpProbe, waitForReady as waitForReadyImpl } from "./preview-readiness.js";
import {
  type PortReservation,
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  type PreviewStartRequest,
  type PreviewStartResponse,
} from "./types.js";

export { folderScope, tabScope, wizardScope } from "../../shared/preview.js";
export type { PortReservation, PreviewStartRequest, PreviewStartResponse };
export {
  buildExportEnvImpl as buildExportEnv,
  displayUrlForPort,
  findFreePortImpl as findFreePort,
  PortRegistry,
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  previewPortRegistry,
  probeUrlForPortImpl as probeUrlForPort,
};

export type EnsurePreviewOpts = {
  servers?: DevServer[];
  serverId?: string;
  command?: string;
  port?: number;
  /** Exact pre-resolved port; skips port allocation when set. */
  resolvedPort?: number;
  /** Pre-reserved ports per server id (bootstrap plan phase). Used verbatim. */
  reservedPorts?: Map<string, PortReservation>;
  exportUrlAs?: string | string[];
  portEnv?: string | string[];
  all?: boolean;
  readyTimeoutMs?: number;
};

let statusHandler: ((snapshot: PreviewServerSnapshot) => void) | undefined;
let logHandler: ((event: PreviewLogEvent) => void) | undefined;
let lineHandler: ((line: PreviewServerLogLine) => void) | undefined;

const manager = new PreviewManager({
  spawnChild: spawnPreviewChild,
  probe: httpProbe,
  findFreePort: findFreePortImpl,
  ports: previewPortRegistry,
  emitStatus: (snapshot) => statusHandler?.(snapshot),
  emitLog: (event) => logHandler?.(event),
  emitLine: (line) => lineHandler?.(line),
});

export function setPreviewStatusHandler(handler: (snapshot: PreviewServerSnapshot) => void): void {
  statusHandler = handler;
}

export function setPreviewLogHandler(handler: (event: PreviewLogEvent) => void): void {
  logHandler = handler;
}

export function setPreviewLineHandler(handler: (line: PreviewServerLogLine) => void): void {
  lineHandler = handler;
}

/**
 * Start (or resume) the preview server(s) for a scope. Scope is the owning
 * tab (`tab:<id>`) or a synthetic `wizard:<id>` / `folder:<path>` scope.
 */
export async function ensurePreviewStarted(
  scope: string,
  folderPath: string,
  opts: EnsurePreviewOpts = {},
): Promise<PreviewStartResponse> {
  return manager.ensureStarted({
    scope,
    folderPath,
    ...opts,
  });
}

export async function restartPreview(
  scope: string,
  folderPath: string,
  opts: EnsurePreviewOpts = {},
): Promise<PreviewStartResponse> {
  return manager.restart({
    scope,
    folderPath,
    ...opts,
  });
}

/** Stop one server or the whole fleet owned by a scope. */
export async function stopPreviewsForScope(scope: string, serverId?: string): Promise<void> {
  await manager.stop(scope, serverId);
}

/** Stop every preview instance running in a folder, regardless of scope. */
export async function stopAllPreviewsForProject(folderPath: string): Promise<void> {
  await manager.stopFolder(folderPath);
}

export async function stopAllDevServers(): Promise<void> {
  await manager.stopAll();
}

export function getDevServerStatus(scope: string, serverId?: string): PreviewFleetSnapshot {
  return manager.getStatus(scope, serverId);
}

export async function waitForReady(
  url: string,
  timeoutMs = PREVIEW_READY_TIMEOUT_MS,
  process?: { exited: Promise<number> },
): Promise<void> {
  await waitForReadyImpl({
    url,
    timeoutMs,
    processExited: process?.exited,
    probe: httpProbe,
  });
}

/** Test access to the singleton manager. */
export function __getPreviewManagerForTests(): PreviewManager {
  return manager;
}
