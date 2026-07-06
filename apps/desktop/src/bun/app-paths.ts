import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the herman application data directory.
 *
 * - macOS / Linux: ~/.herman
 * - Windows: %LOCALAPPDATA%/herman
 *
 * Set HERMAN_APP_DIR to override (useful for testing).
 */
export function hermanDir(): string {
  if (process.env.HERMAN_APP_DIR) {
    return process.env.HERMAN_APP_DIR;
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "herman");
  }
  return join(homedir(), ".herman");
}

/** Root application directory. */
export function appDir(): string {
  return hermanDir();
}

/** Global state (session token, last folder path). */
export function statePath(): string {
  return join(hermanDir(), "state.json");
}

/** Window geometry, open tabs, projects. */
export function windowStatePath(): string {
  return join(hermanDir(), "window-state.json");
}

/** User settings (providers, models, mode). */
export function settingsPath(): string {
  return join(hermanDir(), "settings.json");
}

/** SQLite database (provider pins, etc.). */
export function dbPath(): string {
  return join(hermanDir(), "herman.db");
}

/** Per-tab message history. */
export function historyDir(): string {
  return join(hermanDir(), "history");
}

/** Per-tab composer drafts. */
export function draftsDir(): string {
  return join(hermanDir(), "drafts");
}

/** Per-tab agent configuration (auth.json, models.json). */
export function agentConfigsDir(): string {
  return join(hermanDir(), "agent-configs");
}

/** Encrypted provider credentials. */
export function credentialsPath(): string {
  return join(hermanDir(), "credentials.enc.json");
}

/** Desktop-managed skills (SKILL.md directories). */
export function skillsDir(): string {
  return join(agentDir(), "skills");
}

/** CLI / headless agent runtime directory (sessions, extensions, etc.). */
export function agentDir(): string {
  return join(hermanDir(), "agent");
}
