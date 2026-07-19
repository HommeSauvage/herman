import { dirname } from "node:path";
import { getLogger } from "@logtape/logtape";
import { logStorageError } from "../logging-shared.js";
import type { Session } from "../shared/rpc.js";
import type { TabId } from "../shared/tab-utils.js";
import { statePath } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

const logger = getLogger(["herman-desktop", "storage"]);

const sp = statePath;

export type PersistedTab = {
  id: TabId;
  title: string;
  folderPath: string;
  projectColor: string;
  createdAt: number;
  updatedAt: number;
};

type State = {
  session?: Session;
  tabs?: PersistedTab[];
  activeTabId?: TabId;
  lastFolderPath?: string;
};

export async function loadState(): Promise<State> {
  const path = sp();
  ensureDir(dirname(path));
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    return (await file.json()) as State;
  } catch (error) {
    logStorageError(logger, "loadState", path, error);
    return {};
  }
}

export async function saveSession(session: Session) {
  const path = sp();
  ensureDir(dirname(path));
  try {
    const state = await loadState();
    state.session = session;
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch (error) {
    logStorageError(logger, "saveSession", path, error);
    throw error;
  }
}

export async function clearSession() {
  const path = sp();
  ensureDir(dirname(path));
  try {
    const state = await loadState();
    delete state.session;
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch (error) {
    logStorageError(logger, "clearSession", path, error);
    throw error;
  }
}

export async function clearAllState(): Promise<void> {
  const path = sp();
  ensureDir(dirname(path));
  try {
    await Bun.write(path, JSON.stringify({}, null, 2));
  } catch (error) {
    logStorageError(logger, "clearAllState", path, error);
    throw error;
  }
}

export async function saveTabs(tabs: PersistedTab[], activeTabId?: TabId) {
  const path = sp();
  ensureDir(dirname(path));
  try {
    const state = await loadState();
    state.tabs = tabs;
    state.activeTabId = activeTabId;
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch (error) {
    logStorageError(logger, "saveTabs", path, error);
    throw error;
  }
}

export async function loadTabs(): Promise<{ tabs: PersistedTab[]; activeTabId?: TabId }> {
  const state = await loadState();
  return {
    tabs: state.tabs ?? [],
    activeTabId: state.activeTabId,
  };
}

export async function saveLastFolderPath(folderPath: string) {
  const path = sp();
  ensureDir(dirname(path));
  try {
    const state = await loadState();
    state.lastFolderPath = folderPath;
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch (error) {
    logStorageError(logger, "saveLastFolderPath", path, error);
    throw error;
  }
}

export async function loadLastFolderPath(): Promise<string | undefined> {
  const state = await loadState();
  return state.lastFolderPath;
}
