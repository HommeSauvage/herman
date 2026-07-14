import { dirname } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { TabId, PersistedSession } from "../shared/rpc.js";
import { createTabId, getProjectColor, getProjectName } from "../shared/tab-utils.js";
import { windowStatePath } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";
import { logStorageError } from "../logging-shared.js";

const logger = getLogger(["herman-desktop", "storage"]);

const wsp = windowStatePath;

type WindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** @deprecated use PersistedSession */
export type PersistedTab = PersistedSession;

export type { PersistedSession };

export type WindowState = {
  frame?: WindowFrame;
  projects?: string[];
  sessions?: PersistedSession[];
  openTabIds?: TabId[];
  activeTabId?: TabId;
  lastFolderPath?: string;
  settingsActiveTab?: "providers" | "models" | "general" | "skills";
  /** @deprecated migrated to sessions + openTabIds on read */
  tabs?: PersistedSession[];
  /** @deprecated single-folder path migrated to the first tab on read */
  folderPath?: string;
};

const DEFAULT_FRAME: WindowFrame = {
  x: 100,
  y: 100,
  width: 1200,
  height: 800,
};

const MIN_SIZE = { width: 900, height: 600 };

function uniqueFolderPaths(sessions: PersistedSession[]): string[] {
  const paths = new Set<string>();
  for (const session of sessions) {
    if (session.folderPath) paths.add(session.folderPath);
  }
  return Array.from(paths);
}

function migrateLegacyFolderPath(state: WindowState): WindowState {
  if (state.folderPath && (!state.tabs || state.tabs.length === 0)) {
    const id = createTabId();
    const now = Date.now();
    return {
      ...state,
      folderPath: undefined,
      lastFolderPath: state.folderPath,
      tabs: [
        {
          id,
          title: getProjectName(state.folderPath),
          folderPath: state.folderPath,
          projectRoot: state.folderPath,
          projectColor: getProjectColor(state.folderPath),
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeTabId: id,
    };
  }
  return state;
}

function migrateTabsToSessions(state: WindowState): WindowState {
  if (state.sessions && state.sessions.length > 0) return state;
  if (!state.tabs || state.tabs.length === 0) return state;

  const sessions = state.tabs;
  const openTabIds = sessions.map((session) => session.id);
  const projects = uniqueFolderPaths(sessions);

  return {
    ...state,
    sessions,
    openTabIds,
    projects: state.projects ?? projects,
    tabs: undefined,
  };
}

function migrateWindowState(state: WindowState): WindowState {
  return migrateTabsToSessions(migrateLegacyFolderPath(state));
}

export async function loadWindowState(): Promise<WindowState> {
  const path = wsp();
  ensureDir(dirname(path));
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      logger.debug("Window state file missing", { path });
      return {};
    }
    const raw = (await file.json()) as WindowState;
    return migrateWindowState(raw);
  } catch (error) {
    logStorageError(logger, "loadWindowState", path, error);
    return {};
  }
}

export async function saveWindowState(state: WindowState) {
  const path = wsp();
  ensureDir(dirname(path));
  try {
    const existing = await loadWindowState();
    await Bun.write(path, JSON.stringify({ ...existing, ...state }, null, 2));
  } catch (error) {
    logStorageError(logger, "saveWindowState", path, error);
    throw error;
  }
}

export async function clearWindowState(): Promise<void> {
  const path = wsp();
  ensureDir(dirname(path));
  await Bun.write(path, JSON.stringify({}, null, 2));
}

export function resolveFrame(frame?: WindowFrame): WindowFrame {
  const resolved = frame ?? DEFAULT_FRAME;
  return {
    x: resolved.x,
    y: resolved.y,
    width: Math.max(resolved.width, MIN_SIZE.width),
    height: Math.max(resolved.height, MIN_SIZE.height),
  };
}

/** @deprecated use saveWindowState or the tab persistence layer instead */
export async function saveFolderPath(folderPath?: string) {
  await saveWindowState({ folderPath });
}

/** @deprecated use loadWindowState instead */
export async function loadFolderPath(): Promise<string | undefined> {
  const state = await loadWindowState();
  return state.lastFolderPath ?? state.folderPath;
}
