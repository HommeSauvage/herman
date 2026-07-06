import { dirname } from "node:path";

import { config } from "../env.js";
import type { DesktopSettings, HermanProviderSettings, ProviderSettings } from "../shared/rpc.js";
import { settingsPath } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";

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
    const raw = (await Bun.file(path).json()) as Partial<DesktopSettings>;
    // credentialStoreError is transient and should never be persisted.
    const { credentialStoreError: _, ...rawWithoutError } = raw;
    return {
      ...defaultSettings(),
      ...rawWithoutError,
      providers: migrateProviders(raw.providers),
      models: { ...defaultSettings().models, ...raw.models },
    };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(settings: DesktopSettings): Promise<void> {
  const path = sp();
  ensureDir(dirname(path));
  // credentialStoreError is transient and should never be persisted.
  const { credentialStoreError: _, ...toSave } = settings;
  await Bun.write(path, JSON.stringify(toSave, null, 2));
}

export async function clearSettings(): Promise<void> {
  const path = sp();
  ensureDir(dirname(path));
  await Bun.write(path, JSON.stringify(defaultSettings(), null, 2));
}
