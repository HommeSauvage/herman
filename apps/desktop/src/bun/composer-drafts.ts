import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { logStorageError } from "../logging-shared.js";
import type { TabId } from "../shared/tab-utils.js";
import { draftsDir as appDraftsDir } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

const logger = getLogger(["herman-desktop", "storage"]);

function draftsDir() {
  return appDraftsDir();
}

function draftPath(tabId: TabId) {
  return join(draftsDir(), `${tabId}.txt`);
}

export async function saveComposerDraft(tabId: TabId, value: string) {
  const path = draftPath(tabId);
  try {
    ensureDir(draftsDir());
    await Bun.write(path, value);
  } catch (error) {
    logStorageError(logger, "saveComposerDraft", path, error);
    throw error;
  }
}

export async function loadComposerDraft(tabId: TabId): Promise<string> {
  const path = draftPath(tabId);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch (error) {
    logStorageError(logger, "loadComposerDraft", path, error);
    return "";
  }
}

export async function deleteComposerDraft(tabId: TabId) {
  const path = draftPath(tabId);
  try {
    unlinkSync(path);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      logStorageError(logger, "deleteComposerDraft", path, error);
    }
  }
}

export async function clearAllComposerDrafts(): Promise<void> {
  const files = await listDraftFiles();
  for (const file of files) {
    const path = join(draftsDir(), file);
    try {
      unlinkSync(path);
    } catch (error) {
      logStorageError(logger, "clearAllComposerDrafts", path, error);
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
