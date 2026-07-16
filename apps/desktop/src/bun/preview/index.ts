import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DevServer } from "../../shared/herman-manifest.js";
import type {
  PreviewFleetSnapshot,
  PreviewLogEvent,
  PreviewServerSnapshot,
} from "../../shared/preview.js";
import { runInstallCommand } from "../worktree.js";
import { PreviewManager } from "./preview-manager.js";
import {
  allocatePorts as allocatePortsImpl,
  buildExportEnv as buildExportEnvImpl,
  displayUrlForPort,
  findFreePort as findFreePortImpl,
  probeUrlForPort as probeUrlForPortImpl,
} from "./preview-ports.js";
import { spawnPreviewChild } from "./preview-process.js";
import { httpProbe, waitForReady as waitForReadyImpl } from "./preview-readiness.js";
import {
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  type PreviewStartRequest,
  type PreviewStartResponse,
} from "./types.js";

export {
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  probeUrlForPortImpl as probeUrlForPort,
  findFreePortImpl as findFreePort,
  allocatePortsImpl as allocatePorts,
  buildExportEnvImpl as buildExportEnv,
  displayUrlForPort,
};

export type { PreviewStartResponse, PreviewStartRequest };

export type EnsurePreviewOpts = {
  servers?: DevServer[];
  installCommand?: string;
  serverId?: string;
  command?: string;
  port?: number;
  exportUrlAs?: string | string[];
  all?: boolean;
  readyTimeoutMs?: number;
};

export type StartDevServerOpts = {
  serverId?: string;
  label?: string;
  command?: string;
  port?: number;
  resolvedPort?: number;
  extraEnv?: Record<string, string>;
  exportUrlAs?: string | string[];
  primary?: boolean;
  installCommand?: string;
  readyTimeoutMs?: number;
};

let statusHandler: ((snapshot: PreviewServerSnapshot) => void) | undefined;
let logHandler: ((event: PreviewLogEvent) => void) | undefined;

function shouldInstall(folderPath: string, installCommand: string | undefined): boolean {
  if (!installCommand) return false;
  return !existsSync(join(folderPath, "node_modules"));
}

const manager = new PreviewManager({
  spawnChild: spawnPreviewChild,
  probe: httpProbe,
  findFreePort: findFreePortImpl,
  allocatePorts: allocatePortsImpl,
  runInstall: runInstallCommand,
  shouldInstall,
  emitStatus: (snapshot) => statusHandler?.(snapshot),
  emitLog: (event) => logHandler?.(event),
});

export function setPreviewStatusHandler(
  handler: (snapshot: PreviewServerSnapshot) => void,
): void {
  statusHandler = handler;
}

export function setPreviewLogHandler(handler: (event: PreviewLogEvent) => void): void {
  logHandler = handler;
}

/** @deprecated Prefer ensurePreviewStarted — kept for tests. Awaits spawn (not readiness). */
export async function startDevServer(
  folderPath: string,
  opts?: StartDevServerOpts,
): Promise<PreviewStartResponse> {
  const serverId = opts?.serverId ?? "web";
  const result = await manager.ensureStarted({
    folderPath,
    serverId,
    command: opts?.command,
    port: opts?.port,
    resolvedPort: opts?.resolvedPort,
    exportUrlAs: opts?.exportUrlAs,
    installCommand: opts?.installCommand,
    readyTimeoutMs: opts?.readyTimeoutMs,
    all: false,
  });
  await manager.awaitStartFlight(folderPath, serverId, false);
  const status = manager.getStatus(folderPath, serverId);
  const snap = status.servers[0];
  if (snap) {
    return { ...snap, starting: snap.phase === "starting" || snap.phase === "installing" };
  }
  return result;
}

/** @deprecated Prefer ensurePreviewStarted — kept for tests. Awaits spawn (not readiness). */
export async function startAllDevServers(
  folderPath: string,
  servers: DevServer[],
  installCommand?: string,
  readyTimeoutMs?: number,
): Promise<PreviewStartResponse> {
  const result = await manager.ensureStarted({
    folderPath,
    servers,
    installCommand,
    readyTimeoutMs,
    all: true,
  });
  await manager.awaitStartFlight(folderPath, undefined, true);
  const status = manager.getStatus(folderPath);
  const snap =
    status.servers.find((s) => s.serverId === status.primaryServerId) ?? status.servers[0];
  if (snap) {
    return { ...snap, starting: snap.phase === "starting" || snap.phase === "installing" };
  }
  return result;
}

export async function ensurePreviewStarted(
  folderPath: string,
  opts: EnsurePreviewOpts = {},
): Promise<PreviewStartResponse> {
  return manager.ensureStarted({
    folderPath,
    ...opts,
  });
}

export async function restartPreview(
  folderPath: string,
  opts: EnsurePreviewOpts = {},
): Promise<PreviewStartResponse> {
  return manager.restart({
    folderPath,
    ...opts,
  });
}

export async function stopDevServer(folderPath: string, serverId?: string): Promise<void> {
  await manager.stop(folderPath, serverId);
}

export async function stopAllDevServers(): Promise<void> {
  await manager.stopAll();
}

export function getDevServerStatus(
  folderPath: string,
  serverId?: string,
): PreviewFleetSnapshot {
  return manager.getStatus(folderPath, serverId);
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
