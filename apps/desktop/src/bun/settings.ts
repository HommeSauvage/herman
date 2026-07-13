import { getLogger } from "@logtape/logtape";
import { dirname } from "node:path";

import { config } from "../env.js";
import type { DesktopSettings, HermanProviderSettings, ProviderSettings } from "../shared/rpc.js";
import { settingsPath } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";
import { logStorageError } from "../logging-shared.js";

const logger = getLogger(["herman-desktop", "storage"]);

const sp = settingsPath;

function defaultHermanSettings(): HermanProviderSettings {
  return {
    enabled: Boolean(config.serverUrl),
    serverUrl: config.serverUrl || undefined,
  };
}

export function defaultSettings(): DesktopSettings {
  return {
    providers: {
      herman: defaultHermanSettings(),
      custom: {},
    },
    models: {},
    disabledSkills: [],
    // mode is intentionally undefined by default so we can detect first-launch
  };
}

function migrateProviders(
  providers?: Partial<DesktopSettings["providers"]>,
): DesktopSettings["providers"] {
  const herman = { ...defaultHermanSettings(), ...providers?.herman };
  const custom: Record<string, ProviderSettings | undefined> = { ...providers?.custom };

  // Backfill custom providers saved under the old flat `providers` shape.
  for (const [providerId, providerSettings] of Object.entries(providers ?? {})) {
    if (providerId === "herman" || providerId === "custom") continue;
    if (providerSettings && typeof providerSettings === "object" && "enabled" in providerSettings) {
      custom[providerId] = providerSettings as ProviderSettings;
    }
  }

  return { herman, custom };
}

export async function loadSettings(): Promise<DesktopSettings> {
  const path = sp();
  ensureDir(dirname(path));
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      logger.debug("Settings file missing; using defaults", { path });
      return defaultSettings();
    }
    const raw = (await file.json()) as Partial<DesktopSettings>;
    // credentialStoreError is transient and should never be persisted.
    const { credentialStoreError: _, ...rawWithoutError } = raw;
    return {
      ...defaultSettings(),
      ...rawWithoutError,
      providers: migrateProviders(raw.providers),
      models: { ...defaultSettings().models, ...raw.models },
    };
  } catch (error) {
    logStorageError(logger, "loadSettings", path, error);
    return defaultSettings();
  }
}

export async function saveSettings(settings: DesktopSettings): Promise<void> {
  const path = sp();
  ensureDir(dirname(path));
  try {
    // credentialStoreError is transient and should never be persisted.
    const { credentialStoreError: _, ...toSave } = settings;
    await Bun.write(path, JSON.stringify(toSave, null, 2));
  } catch (error) {
    logStorageError(logger, "saveSettings", path, error);
    throw error;
  }
}

export async function clearSettings(): Promise<void> {
  const path = sp();
  ensureDir(dirname(path));
  try {
    await Bun.write(path, JSON.stringify(defaultSettings(), null, 2));
  } catch (error) {
    logStorageError(logger, "clearSettings", path, error);
    throw error;
  }
}
