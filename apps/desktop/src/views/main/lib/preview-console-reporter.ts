import type { PreviewConsoleEntry } from "@herman/rpc/host-bridge";

import { desktopRpc } from "./desktop-rpc.js";

const FLUSH_INTERVAL_MS = 250;
const MAX_BATCH_SIZE = 50;
const RATE_LIMIT_WINDOW_MS = 30_000;
const RATE_LIMIT_MAX = 240;

type TabBatcher = {
  tabId: string;
  folderPath: string;
  entries: PreviewConsoleEntry[];
  dropped: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  rateWindow: number[];
};

const batchers = new Map<string, TabBatcher>();

function getBatcher(tabId: string, folderPath: string): TabBatcher {
  let batcher = batchers.get(tabId);
  if (!batcher) {
    batcher = {
      tabId,
      folderPath,
      entries: [],
      dropped: 0,
      timer: undefined,
      rateWindow: [],
    };
    batchers.set(tabId, batcher);
  }
  // Update folderPath if it changed.
  batcher.folderPath = folderPath;
  return batcher;
}

function rateLimited(batcher: TabBatcher): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  batcher.rateWindow = batcher.rateWindow.filter((t) => t >= cutoff);
  if (batcher.rateWindow.length >= RATE_LIMIT_MAX) {
    batcher.dropped++;
    return true;
  }
  batcher.rateWindow.push(now);
  return false;
}

function dedupeConsecutive(batcher: TabBatcher, entry: PreviewConsoleEntry): boolean {
  const last = batcher.entries[batcher.entries.length - 1];
  if (last && last.level === entry.level && last.message === entry.message) {
    return true;
  }
  return false;
}

function flush(batcher: TabBatcher): void {
  if (batcher.timer) {
    clearTimeout(batcher.timer);
    batcher.timer = undefined;
  }
  if (batcher.entries.length === 0 && batcher.dropped === 0) return;

  const { tabId, folderPath, entries, dropped } = batcher;
  batcher.entries = [];
  batcher.dropped = 0;

  void desktopRpc.send.previewConsoleBatch({
    tabId,
    folderPath,
    entries,
    dropped,
  });
}

export function reportPreviewConsoleEntry(
  tabId: string,
  folderPath: string,
  entry: PreviewConsoleEntry,
): void {
  const batcher = getBatcher(tabId, folderPath);
  if (rateLimited(batcher)) return;
  if (dedupeConsecutive(batcher, entry)) return;

  batcher.entries.push(entry);

  if (batcher.entries.length >= MAX_BATCH_SIZE) {
    flush(batcher);
    return;
  }

  if (!batcher.timer) {
    batcher.timer = setTimeout(() => flush(batcher), FLUSH_INTERVAL_MS);
  }
}

export function reportPreviewNavigation(tabId: string, folderPath: string, url: string): void {
  void desktopRpc.send.previewNavigated({ tabId, folderPath, url });
}
