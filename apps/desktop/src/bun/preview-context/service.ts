import {
  type HostBridgePreviewLogs,
  type HostBridgePreviewState,
  type HostBridgeSessionInfo,
  type PreviewConsoleEntry,
  type PreviewLogsQuery,
  PREVIEW_LOGS_DEFAULT_CONTEXT,
  PREVIEW_LOGS_DEFAULT_MAX_ENTRIES,
  PREVIEW_LOGS_MAX_CONTEXT,
  PREVIEW_LOGS_MAX_ENTRIES,
  PREVIEW_TOOL_TEXT_MAX_CHARS,
  RECENT_ERRORS_WINDOW_MS,
} from "@herman/rpc/host-bridge";

import type { PreviewFleetSnapshot, PreviewServerLogLine } from "../../shared/preview.js";
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

export type PreviewContextDeps = {
  getTab: (tabId: string) => TabSnapshot | undefined;
  getMode: () => "rookie" | "normal" | undefined;
  /** Fleet status by owning scope (`tab:<id>` / `folder:<path>` / `wizard:<id>`). */
  getFleetStatus: (scope: string) => PreviewFleetSnapshot;
  now?: () => number;
};

export class PreviewContextService {
  private readonly serverRings = new Map<string, RingBuffer<PreviewServerLogLine>>();
  private readonly consoleRings = new Map<string, RingBuffer<PreviewConsoleEntry>>();
  private readonly navigationUrls = new Map<string, string>();
  private readonly rendererDropped = new Map<string, number>();

  constructor(private readonly deps: PreviewContextDeps) {}

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

  // ── Queries ──

  getSessionInfo(tabId: string): HostBridgeSessionInfo {
    const tab = this.deps.getTab(tabId);
    const folderPath = tab?.folderPath ?? "";
    const preview = this.deps.getFleetStatus(tabScope(tabId));

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
    const tab = this.deps.getTab(tabId);
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

    const preview = this.deps.getFleetStatus(tabScope(tabId));
    const now = this.deps.now?.() ?? Date.now();
    const windowStart = now - RECENT_ERRORS_WINDOW_MS;
    const scope = tabScope(tabId);

    // Count recent server errors across all servers in this tab's scope.
    let serverErrors = 0;
    for (const [key, ring] of this.serverRings) {
      if (!key.startsWith(`${scope}::`)) continue;
      for (const entry of ring.items()) {
        if (entry.ts >= windowStart && looksLikeServerError(entry.line)) {
          serverErrors++;
        }
      }
    }

    // Count recent console errors for this tab.
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

    const error = preview.phase === "failed"
      ? (primary?.error ? primary.error.split("\n")[0] : undefined)
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
    const tab = this.deps.getTab(tabId);
    if (!tab) {
      throw new HostBridgeError(404, "tab_not_found", "Tab not found");
    }

    const folderPath = tab.folderPath ?? "";
    const maxEntries = clamp(query.maxEntries ?? PREVIEW_LOGS_DEFAULT_MAX_ENTRIES, 1, PREVIEW_LOGS_MAX_ENTRIES);
    const maxLinesBeforeAfter = clamp(query.maxLinesBeforeAfter ?? PREVIEW_LOGS_DEFAULT_CONTEXT, 0, PREVIEW_LOGS_MAX_CONTEXT);

    if (query.environment === "server") {
      return this.getServerLogs(tabId, folderPath, query.serverId, maxEntries, maxLinesBeforeAfter);
    }
    return this.getConsoleLogs(tabId, folderPath, maxEntries, maxLinesBeforeAfter);
  }

  private getServerLogs(
    tabId: string,
    folderPath: string,
    serverId: string | undefined,
    maxEntries: number,
    maxLinesBeforeAfter: number,
  ): HostBridgePreviewLogs {
    const preview = this.deps.getFleetStatus(tabScope(tabId));

    // Resolve serverId.
    const resolvedId = serverId ?? preview.primaryServerId ?? "web";
    const key = serverRingKey(tabScope(tabId), resolvedId);
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
    const formatted = formatServerLogText(rawLines, { maxEntries, maxLinesBeforeAfter, maxChars: PREVIEW_TOOL_TEXT_MAX_CHARS });

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
    folderPath: string,
    maxEntries: number,
    maxLinesBeforeAfter: number,
  ): HostBridgePreviewLogs {
    const preview = this.deps.getFleetStatus(tabScope(tabId));

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
