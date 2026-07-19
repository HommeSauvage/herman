import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { logStorageError } from "../logging-shared.js";
import type { ContextStats, Message } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { historyDir as appHistoryDir } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

const logger = getLogger(["herman-desktop", "storage"]);

export type TabHistoryCache = {
  version: 1;
  messages: Message[];
  contextStats?: ContextStats;
  piSessionId?: string;
  updatedAt: number;
};

export type TabHistorySaveExtras = {
  contextStats?: ContextStats;
  piSessionId?: string;
};

function historyDir() {
  return appHistoryDir();
}

function historyPath(tabId: TabId) {
  return join(historyDir(), `${tabId}.json`);
}

function isMessageArray(value: unknown): value is Message[] {
  return Array.isArray(value);
}

function isTabHistoryCache(value: unknown): value is TabHistoryCache {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && Array.isArray(record.messages);
}

export async function saveTabHistory(
  tabId: TabId,
  messages: Message[],
  extras?: TabHistorySaveExtras,
): Promise<void> {
  const path = historyPath(tabId);
  try {
    ensureDir(historyDir());
    const cache: TabHistoryCache = {
      version: 1,
      messages,
      contextStats: extras?.contextStats,
      piSessionId: extras?.piSessionId,
      updatedAt: Date.now(),
    };
    await Bun.write(path, JSON.stringify(cache, null, 2));
  } catch (error) {
    logStorageError(logger, "saveTabHistory", path, error);
    throw error;
  }
}

export async function loadTabHistoryCache(tabId: TabId): Promise<TabHistoryCache | null> {
  const path = historyPath(tabId);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const raw = await file.json();
    if (isTabHistoryCache(raw)) {
      return raw;
    }
    if (isMessageArray(raw)) {
      return {
        version: 1,
        messages: raw,
        updatedAt: Date.now(),
      };
    }
    logger.warning("Tab history cache is corrupt", { tabId, path });
    return null;
  } catch (error) {
    logStorageError(logger, "loadTabHistoryCache", path, error);
    return null;
  }
}

export async function loadTabHistory(tabId: TabId): Promise<Message[]> {
  const cache = await loadTabHistoryCache(tabId);
  return cache?.messages ?? [];
}

export async function deleteTabHistory(tabId: TabId) {
  const path = historyPath(tabId);
  try {
    unlinkSync(path);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      logStorageError(logger, "deleteTabHistory", path, error);
    }
  }
}

export async function clearAllTabHistory(): Promise<void> {
  const files = await listHistoryFiles();
  for (const file of files) {
    try {
      unlinkSync(join(historyDir(), file));
    } catch (error) {
      logStorageError(logger, "clearAllTabHistory", join(historyDir(), file), error);
    }
  }
}

async function listHistoryFiles(): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(historyDir());
    return entries.filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
}
