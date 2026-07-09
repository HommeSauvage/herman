import { unlinkSync } from "node:fs";
import { join } from "node:path";

import type { ContextStats, Message } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { historyDir as appHistoryDir } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

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
  ensureDir(historyDir());
  const cache: TabHistoryCache = {
    version: 1,
    messages,
    contextStats: extras?.contextStats,
    piSessionId: extras?.piSessionId,
    updatedAt: Date.now(),
  };
  await Bun.write(historyPath(tabId), JSON.stringify(cache, null, 2));
}

export async function loadTabHistoryCache(tabId: TabId): Promise<TabHistoryCache | null> {
  try {
    const raw = await Bun.file(historyPath(tabId)).json();
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
    return null;
  } catch {
    return null;
  }
}

export async function loadTabHistory(tabId: TabId): Promise<Message[]> {
  const cache = await loadTabHistoryCache(tabId);
  return cache?.messages ?? [];
}

export async function deleteTabHistory(tabId: TabId) {
  try {
    unlinkSync(historyPath(tabId));
  } catch {
    // history file may not exist
  }
}

export async function clearAllTabHistory(): Promise<void> {
  const files = await listHistoryFiles();
  for (const file of files) {
    try {
      unlinkSync(join(historyDir(), file));
    } catch {
      // ignore
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
