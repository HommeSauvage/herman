import {
  type HostBridgePreviewLogs,
  type HostBridgePreviewState,
  type HostBridgeSessionInfo,
  PREVIEW_LOGS_DEFAULT_CONTEXT,
  PREVIEW_LOGS_DEFAULT_MAX_ENTRIES,
  PREVIEW_LOGS_MAX_CONTEXT,
  PREVIEW_LOGS_MAX_ENTRIES,
  PREVIEW_TOOL_TEXT_MAX_CHARS,
  type PreviewConsoleEntry,
  type PreviewLogsQuery,
  RECENT_ERRORS_WINDOW_MS,
} from "@herman/rpc/host-bridge";

import type {
  PreviewFleetSnapshot,
  PreviewScope,
  PreviewServerLogLine,
} from "../../shared/preview.js";
import { MAX_LOG_LINE_CHARS, tabScope } from "../../shared/preview.js";
import type { SessionWorktree } from "../../shared/rpc.js";
import { HostBridgeError } from "../host-bridge/server.js";
import { looksLikeServerError } from "../preview/preview-log-filter.js";
import { formatConsoleLogText, formatServerLogText } from "./format.js";
import { RingBuffer } from "./ring-buffer.js";

export type { PreviewServerLogLine };
export { MAX_LOG_LINE_CHARS };

const SERVER_RING_CAPACITY = 500;
const SERVER_RING_MAP_CAP = 20;
const CONSOLE_RING_CAPACITY = 500;

export type TabSnapshot = {
  folderPath?: string;
  projectRoot?: string;
  worktree?: SessionWorktree;
};

/** Resolve a tab/wizard id to its preview scope + project snapshot. */
export type ContextResolution = {
  /** undefined → tab_not_found for logs, "no project" for info */
  snapshot?: TabSnapshot;
  scope: PreviewScope;
};

export type PreviewContextDeps = {
  resolve: (id: string) => ContextResolution;
  getMode: () => "rookie" | "normal" | undefined;
  /** Fleet status by owning scope (`tab:<id>` / `folder:<path>` / `wizard:<id>`). */
  getFleetStatus: (scope: PreviewScope) => PreviewFleetSnapshot;
  now?: () => number;
};

/**
 * Back-compat adapter for callers that still provide getTab.
 * Prefer `resolve` in new code.
 */
export function resolveFromGetTab(
  getTab: (tabId: string) => TabSnapshot | undefined,
): (id: string) => ContextResolution {
  return (id) => {
    const snapshot = getTab(id);
    return {
      ...(snapshot ? { snapshot } : {}),
      scope: tabScope(id),
    };
  };
}

export class PreviewContextService {
  private readonly serverRings = new Map<string, RingBuffer<PreviewServerLogLine>>();
  private readonly consoleRings = new Map<string, RingBuffer<PreviewConsoleEntry>>();
  private readonly navigationUrls = new Map<string, string>();
  private readonly rendererDropped = new Map<string, number>();
  private readonly resolve: (id: string) => ContextResolution;

  constructor(
    deps:
      | PreviewContextDeps
      | {
          getTab: (tabId: string) => TabSnapshot | undefined;
          getMode: () => "rookie" | "normal" | undefined;
          getFleetStatus: (scope: PreviewScope) => PreviewFleetSnapshot;
          now?: () => number;
        },
  ) {
    if ("resolve" in deps) {
      this.resolve = deps.resolve;
      this.deps = deps;
    } else {
      this.resolve = resolveFromGetTab(deps.getTab);
      this.deps = {
        resolve: this.resolve,
        getMode: deps.getMode,
        getFleetStatus: deps.getFleetStatus,
        now: deps.now,
      };
    }
  }

  private readonly deps: PreviewContextDeps;

  // ── Feeds ──

  handleServerLine(line: PreviewServerLogLine): void {
    const truncated = { ...line, line: line.line.slice(0, MAX_LOG_LINE_CHARS) };
    const key = serverRingKey(truncated.scope, truncated.serverId);
    let ring = this.serverRings.get(key);
    if (!ring) {
      // Evict oldest when at cap.
      if (this.serverRings.size >= SERVER_RING_MAP_CAP) {
        const oldest = this.serverRings.keys().next().value;
        if (oldest) this.serverRings.delete(oldest);
      }
      ring = new RingBuffer<PreviewServerLogLine>(SERVER_RING_CAPACITY);
      this.serverRings.set(key, ring);
    }
    ring.push(truncated);
  }

  handleConsoleBatch(tabId: string, _folderPath: string, entries: PreviewConsoleEntry[]): void {
    let ring = this.consoleRings.get(tabId);
    if (!ring) {
      ring = new RingBuffer<PreviewConsoleEntry>(CONSOLE_RING_CAPACITY);
      this.consoleRings.set(tabId, ring);
    }
    for (const entry of entries) {
      ring.push(entry);
    }
  }

  handleNavigation(tabId: string, _folderPath: string, url: string): void {
    const prev = this.navigationUrls.get(tabId);
    if (prev === url) return;
    this.navigationUrls.set(tabId, url);
    // Push a synthetic console entry for chronological correlation.
    const synthetic: PreviewConsoleEntry = {
      level: "log",
      message: `→ Navigated to ${url}`,
      url,
      ts: this.deps.now?.() ?? Date.now(),
    };
    this.handleConsoleBatch(tabId, _folderPath, [synthetic]);
  }

  addRendererDropped(tabId: string, count: number): void {
    this.rendererDropped.set(tabId, (this.rendererDropped.get(tabId) ?? 0) + count);
  }

  clearTab(tabId: string): void {
    this.consoleRings.delete(tabId);
    this.navigationUrls.delete(tabId);
    this.rendererDropped.delete(tabId);
  }

  /** Expose server log tail for wizard-verify cold-boot failure reports. */
  getServerLogTail(scope: PreviewScope, serverId: string, maxLines: number): string {
    const ring = this.serverRings.get(serverRingKey(scope, serverId));
    if (!ring) return "";
    return ring
      .items()
      .slice(-maxLines)
      .map((l) => `[${l.source}] ${l.line}`)
      .join("\n");
  }

  // ── Queries ──

  getSessionInfo(tabId: string): HostBridgeSessionInfo {
    const { snapshot: tab, scope } = this.resolve(tabId);
    const folderPath = tab?.folderPath ?? "";
    const preview = this.deps.getFleetStatus(scope);

    const primary =
      preview.servers.find((s) => s.serverId === preview.primaryServerId) ??
      preview.servers.find((s) => s.phase === "ready" && s.url) ??
      preview.servers[0];

    const response: HostBridgeSessionInfo = {
      version: 1,
      projectPath: folderPath,
      preview: {
        phase: preview.phase,
        ...(primary?.url ? { primaryUrl: primary.url } : {}),
        servers: preview.servers.map((s) => ({
          serverId: s.serverId,
          phase: s.phase,
          ...(s.url ? { url: s.url } : {}),
          ...(s.port != null ? { port: s.port } : {}),
          ...(s.error ? { error: s.error } : {}),
        })),
      },
      currentUrl: this.navigationUrls.get(tabId),
    };

    if (tab?.projectRoot) {
      response.projectRoot = tab.projectRoot;
    }

    if (tab?.worktree && folderPath) {
      response.worktree = {
        folderPath,
        mainFolderPath: tab.worktree.mainFolderPath,
        branch: tab.worktree.branch,
        ...(tab.worktree.baseBranch ? { baseBranch: tab.worktree.baseBranch } : {}),
      };
    }

    const mode = this.deps.getMode();
    if (mode) {
      response.mode = mode;
    }

    if (!folderPath) {
      response.error = "No project is open in this tab.";
    }

    return response;
  }

  getPreviewState(tabId: string): HostBridgePreviewState {
    const { snapshot: tab, scope } = this.resolve(tabId);
    const folderPath = tab?.folderPath ?? "";
    const available = Boolean(folderPath);

    if (!available) {
      return {
        version: 1,
        available: false,
        phase: "stopped",
        servers: [],
        recentErrors: { server: 0, console: 0 },
      };
    }

    const preview = this.deps.getFleetStatus(scope);
    const now = this.deps.now?.() ?? Date.now();
    const windowStart = now - RECENT_ERRORS_WINDOW_MS;

    // Count recent server errors across all servers in this scope.
    let serverErrors = 0;
    for (const [key, ring] of this.serverRings) {
      if (!key.startsWith(`${scope}::`)) continue;
      for (const entry of ring.items()) {
        if (entry.ts >= windowStart && looksLikeServerError(entry.line)) {
          serverErrors++;
        }
      }
    }

    // Count recent console errors for this id.
    let consoleErrors = 0;
    const consoleRing = this.consoleRings.get(tabId);
    if (consoleRing) {
      for (const entry of consoleRing.items()) {
        if (entry.ts >= windowStart && entry.level === "error") {
          consoleErrors++;
        }
      }
    }

    const primary =
      preview.servers.find((s) => s.serverId === preview.primaryServerId) ??
      preview.servers.find((s) => s.phase === "ready" && s.url) ??
      preview.servers[0];

    const error =
      preview.phase === "failed"
        ? primary?.error
          ? primary.error.split("\n")[0]
          : undefined
        : undefined;

    return {
      version: 1,
      available: true,
      phase: preview.phase,
      primaryServerId: preview.primaryServerId,
      primaryUrl: primary?.url,
      port: primary?.port,
      servers: preview.servers.map((s) => ({
        serverId: s.serverId,
        phase: s.phase,
        ...(s.url ? { url: s.url } : {}),
        ...(s.port != null ? { port: s.port } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
      currentUrl: this.navigationUrls.get(tabId),
      recentErrors: { server: serverErrors, console: consoleErrors },
      ...(error ? { error } : {}),
    };
  }

  getPreviewLogs(tabId: string, query: PreviewLogsQuery): HostBridgePreviewLogs {
    const { snapshot: tab, scope } = this.resolve(tabId);
    if (!tab) {
      throw new HostBridgeError(404, "tab_not_found", "Tab not found");
    }

    const folderPath = tab.folderPath ?? "";
    const maxEntries = clamp(
      query.maxEntries ?? PREVIEW_LOGS_DEFAULT_MAX_ENTRIES,
      1,
      PREVIEW_LOGS_MAX_ENTRIES,
    );
    const maxLinesBeforeAfter = clamp(
      query.maxLinesBeforeAfter ?? PREVIEW_LOGS_DEFAULT_CONTEXT,
      0,
      PREVIEW_LOGS_MAX_CONTEXT,
    );

    if (query.environment === "server") {
      return this.getServerLogs(
        tabId,
        scope,
        folderPath,
        query.serverId,
        maxEntries,
        maxLinesBeforeAfter,
      );
    }
    return this.getConsoleLogs(tabId, scope, folderPath, maxEntries, maxLinesBeforeAfter);
  }

  private getServerLogs(
    tabId: string,
    scope: PreviewScope,
    _folderPath: string,
    serverId: string | undefined,
    maxEntries: number,
    maxLinesBeforeAfter: number,
  ): HostBridgePreviewLogs {
    const preview = this.deps.getFleetStatus(scope);

    // Resolve serverId.
    const resolvedId = serverId ?? preview.primaryServerId ?? "web";
    const key = serverRingKey(scope, resolvedId);
    const ring = this.serverRings.get(key);

    if (!ring || ring.items().length === 0) {
      const primary = preview.servers.find((s) => s.serverId === resolvedId);
      return {
        version: 1,
        environment: "server",
        serverId: resolvedId,
        phase: preview.phase,
        url: primary?.url,
        currentUrl: this.navigationUrls.get(tabId),
        text: "(no server output captured yet)",
        entries: [],
        droppedEntries: 0,
        truncated: false,
      };
    }

    const rawLines = [...ring.items()];
    const formatted = formatServerLogText(rawLines, {
      maxEntries,
      maxLinesBeforeAfter,
      maxChars: PREVIEW_TOOL_TEXT_MAX_CHARS,
    });

    const primary = preview.servers.find((s) => s.serverId === resolvedId);
    let text = formatted.text;
    const droppedEntries = ring.droppedCount;
    if (droppedEntries > 0) {
      text += `\n(+${droppedEntries} earlier entries dropped)`;
    }

    return {
      version: 1,
      environment: "server",
      serverId: resolvedId,
      phase: preview.phase,
      url: primary?.url,
      currentUrl: this.navigationUrls.get(tabId),
      text,
      entries: formatted.entries,
      droppedEntries,
      truncated: formatted.truncated,
    };
  }

  private getConsoleLogs(
    tabId: string,
    scope: PreviewScope,
    _folderPath: string,
    maxEntries: number,
    maxLinesBeforeAfter: number,
  ): HostBridgePreviewLogs {
    const preview = this.deps.getFleetStatus(scope);

    const ring = this.consoleRings.get(tabId);
    if (!ring || ring.items().length === 0) {
      return {
        version: 1,
        environment: "console",
        phase: preview.phase,
        url: undefined,
        currentUrl: this.navigationUrls.get(tabId),
        text: "(no console output captured yet)",
        entries: [],
        droppedEntries: 0,
        truncated: false,
      };
    }

    const entries = [...ring.items()];
    const formatted = formatConsoleLogText(entries, {
      maxEntries,
      maxLinesBeforeAfter,
      maxChars: PREVIEW_TOOL_TEXT_MAX_CHARS,
      currentUrl: this.navigationUrls.get(tabId),
    });

    const droppedEntries = ring.droppedCount + (this.rendererDropped.get(tabId) ?? 0);
    let text = formatted.text;
    if (droppedEntries > 0) {
      text += `\n(+${droppedEntries} earlier entries dropped)`;
    }

    return {
      version: 1,
      environment: "console",
      phase: preview.phase,
      url: undefined,
      currentUrl: this.navigationUrls.get(tabId),
      text,
      entries: formatted.entries,
      droppedEntries,
      truncated: formatted.truncated,
    };
  }
}

function serverRingKey(scope: string, serverId: string): string {
  return `${scope}::${serverId}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
