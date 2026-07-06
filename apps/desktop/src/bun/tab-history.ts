import { unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Message } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { historyDir as appHistoryDir } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

function historyDir() {
  return appHistoryDir();
}

function historyPath(tabId: TabId) {
  return join(historyDir(), `${tabId}.json`);
}

export async function saveTabHistory(tabId: TabId, messages: Message[]) {
  ensureDir(historyDir());
  await Bun.write(historyPath(tabId), JSON.stringify(messages, null, 2));
}

export async function loadTabHistory(tabId: TabId): Promise<Message[]> {
  try {
    return (await Bun.file(historyPath(tabId)).json()) as Message[];
  } catch {
    return [];
  }
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
