import { unlinkSync } from "node:fs";
import { join } from "node:path";

import type { TabId } from "../shared/tab-utils.js";
import { draftsDir as appDraftsDir } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

function draftsDir() {
  return appDraftsDir();
}

function draftPath(tabId: TabId) {
  return join(draftsDir(), `${tabId}.txt`);
}

export async function saveComposerDraft(tabId: TabId, value: string) {
  ensureDir(draftsDir());
  await Bun.write(draftPath(tabId), value);
}

export async function loadComposerDraft(tabId: TabId): Promise<string> {
  try {
    return await Bun.file(draftPath(tabId)).text();
  } catch {
    return "";
  }
}

export async function deleteComposerDraft(tabId: TabId) {
  try {
    unlinkSync(draftPath(tabId));
  } catch {
    // draft file may not exist
  }
}

export async function clearAllComposerDrafts(): Promise<void> {
  const files = await listDraftFiles();
  for (const file of files) {
    try {
      unlinkSync(join(draftsDir(), file));
    } catch {
      // ignore
    }
  }
}

async function listDraftFiles(): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(draftsDir());
    return entries.filter((entry) => entry.endsWith(".txt"));
  } catch {
    return [];
  }
}
