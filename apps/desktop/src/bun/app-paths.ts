import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/**
 * Shared pi agent configuration root (auth.json, models.json, settings.json,
 * npm/node_modules/, sessions/). One dir for all tabs/wizards/headless runs —
 * a tab is just a pi session (new or resumed by UUID) in this shared root.
 *
 * @deprecated alias of {@link agentDir}; prefer `agentDir()` for new code.
 */
export function agentConfigsDir(): string {
  return agentDir();
}

/** Encrypted provider credentials. */
export function credentialsPath(): string {
  return join(hermanDir(), "credentials.enc.json");
}

/** Herman-managed SSH keys (deploy keys for publishing). */
export function sshDir(): string {
  return join(hermanDir(), "ssh");
}

/** Desktop-managed skills (SKILL.md directories). */
export function skillsDir(): string {
  return join(agentDir(), "skills");
}

/** Shared pi sessions directory (flat: {timestamp}_{uuid}.jsonl). */
export function agentSessionsDir(): string {
  return join(agentDir(), "sessions");
}

/** Shared pi agent runtime directory (config, extensions, sessions). */
export function agentDir(): string {
  return join(hermanDir(), "agent");
}

/**
 * Resolve a read-only asset directory bundled with the app (templates,
 * rookie-docs, bundled-skills, …).
 *
 * - Production (bundled): `app/bun/index.js` → `app/<name>`
 * - Local dev: `apps/desktop/src/bun` → `apps/desktop/<name>`
 *
 * This helper lives directly in `src/bun/` so the relative depths match the
 * bundled layout — do not move the resolution into a nested folder.
 */
export function bundledAssetDir(name: string): string {
  const bundledPath = resolve(import.meta.dir, "..", name);
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(import.meta.dir, "..", "..", name);
}
