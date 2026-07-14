import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@logtape/logtape";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { agentDir, skillsDir } from "./app-paths.js";
import { writeFileAtomically } from "./fs-utils.js";

const logger = getLogger(["herman-desktop", "agent-config"]);

/**
 * Extensions that Herman bundles as npm packages. Pi auto-discovers them from
 * the agent settings and installs them into the shared agent dir's
 * npm/node_modules. Sources must use pi's protocol prefixes (npm:, git:).
 */
const BUNDLED_EXTENSIONS = ["npm:@bacnh85/pi-fff", "npm:@narumitw/pi-goal"];

const SUPPORTED_BUNDLED_PREFIXES = ["npm:", "git:"];

function validateBundledExtensions(sources: string[]): void {
  for (const source of sources) {
    const hasValidPrefix = SUPPORTED_BUNDLED_PREFIXES.some((prefix) => source.startsWith(prefix));
    if (!hasValidPrefix) {
      throw new Error(
        `Invalid bundled extension source "${source}". BUNDLED_EXTENSIONS entries must use a supported prefix: ${SUPPORTED_BUNDLED_PREFIXES.join(", ")}`,
      );
    }
  }
}

/**
 * Keep the `packages` array in settings.json in sync with BUNDLED_EXTENSIONS.
 * User-installed packages (anything not matching a bundled identity) are
 * preserved. Pi distinguishes "npm:@scope/pkg" (npm source) from "@scope/pkg"
 * (local path); we strip the protocol prefix for identity comparison.
 */
function syncBundledPackages(existing: string[]): string[] {
  const normalize = (source: string) => source.replace(/^npm:/, "").replace(/^git:/, "");
  const bundledIdentities = new Set(BUNDLED_EXTENSIONS.map(normalize));
  const unmanaged = existing.filter((p) => !bundledIdentities.has(normalize(p)));
  return [...unmanaged, ...BUNDLED_EXTENSIONS];
}

/**
 * Merge Herman-managed settings into an existing pi agent settings file.
 * Preserves user-managed extension paths and any non-Herman fields (theme, etc.).
 */
export function mergeAgentSettings(
  existing: Record<string, unknown>,
  skills: string[],
): Record<string, unknown> {
  // The wizard extension is now loaded via a --extension CLI arg (per-bridge),
  // not via settings.extensions, so we no longer merge it here. Preserve any
  // extension paths the user added directly to the shared settings.
  const existingExtensions = Array.isArray(existing.extensions)
    ? (existing.extensions as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const { extensions: _e, ...rest } = existing;
  const out: Record<string, unknown> = { ...rest, skills };
  if (existingExtensions.length > 0) out.extensions = existingExtensions;
  return out;
}

function writeAgentConfigFile(path: string, data: Record<string, unknown>): void {
  writeFileAtomically(path, JSON.stringify(data, null, 2));
}

async function loadCredentials(): Promise<Record<string, unknown>> {
  const { loadCredentials: load } = await import("./credentials.js");
  const credentials = await load();
  void import("./credentials.js").then((m) => m.refreshAllOAuthCredentials?.().catch(() => undefined));
  const authJson: Record<string, unknown> = {};
  for (const [providerId, credential] of Object.entries(credentials)) {
    if (credential.type === "apiKey") {
      authJson[providerId] = {
        type: "api_key",
        key: credential.key,
        ...(credential.metadata ? { env: credential.metadata } : {}),
      };
    } else if (credential.type === "oauth") {
      authJson[providerId] = {
        type: "oauth",
        access: credential.accessToken,
        refresh: credential.refreshToken,
        expires: credential.expiresAt,
      };
    }
  }
  return authJson;
}

function buildModelsJson(
  settings: Awaited<ReturnType<typeof import("./settings.js").loadSettings>>,
): Record<string, unknown> {
  const modelsJson: Record<string, unknown> = { providers: {} };
  const providers = modelsJson.providers as Record<string, unknown>;
  for (const [providerId, providerSettings] of Object.entries(settings.providers.custom)) {
    if (!providerSettings?.enabled) continue;
    const options = (providerSettings as { options?: Record<string, string> }).options;
    if (!options?.baseUrl) continue;
    providers[providerId] = {
      baseUrl: options.baseUrl,
      api: "openai-completions",
      apiKey: options.apiKey,
      models: { default: { id: "default", name: options.name || providerId } },
    };
  }
  return modelsJson;
}

/**
 * Write auth.json, models.json, and settings.json into the shared agent dir,
 * keeping bundled extension packages in sync. Then run pi's package manager
 * resolve() so missing bundled extensions are installed once (pi has no install
 * lock, so this serializes the first-run install before any subprocess spawns).
 */
async function runSync(): Promise<void> {
  validateBundledExtensions(BUNDLED_EXTENSIONS);

  const dir = agentDir();
  mkdirSync(dir, { recursive: true });

  const [{ loadSettings }, authJson] = await Promise.all([
    import("./settings.js"),
    loadCredentials(),
  ]);
  const settings = await loadSettings();

  writeAgentConfigFile(join(dir, "auth.json"), authJson);
  writeAgentConfigFile(join(dir, "models.json"), buildModelsJson(settings));

  // settings.json: skills discovery path + disabled-skill patterns + packages.
  const disabledSkills = settings.disabledSkills ?? [];
  const skillsPatterns: string[] = [skillsDir(), ...disabledSkills.map((name) => `!${name}`)];

  const settingsPath = join(dir, "settings.json");
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existingSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // Overwrite corrupt settings below.
    }
  }
  const merged = mergeAgentSettings(existingSettings, skillsPatterns);
  const existingPackages = Array.isArray(merged.packages)
    ? (merged.packages as string[])
    : Array.isArray((existingSettings as { packages?: unknown }).packages)
      ? ((existingSettings as { packages: string[] }).packages)
      : [];
  merged.packages = syncBundledPackages(existingPackages);
  writeAgentConfigFile(settingsPath, merged);

  // Install missing bundled extensions once. After the first successful sync
  // this is a cheap existence check. Using a neutral cwd (the app dir) since
  // we only manage global packages here; project settings are ignored
  // (projectTrusted: false).
  try {
    const settingsManager = SettingsManager.create(dir, dir, { projectTrusted: false });
    const packageManager = new DefaultPackageManager({
      cwd: dir,
      agentDir: dir,
      settingsManager,
    });
    await packageManager.resolve();
  } catch (error) {
    logger.warning("Agent extension install/resolve failed; extensions may be unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("Synchronized shared agent config", { dir });
}

// ── Single-flight sync ──────────────────────────────────────────────────────

let syncInFlight: Promise<void> | undefined;
let lastSync: Promise<void> = Promise.resolve();
let everSynced = false;

/** Run (or join an in-progress) agent config sync. Safe to call repeatedly. */
export function syncAgentConfig(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  const p = runSync()
    .then(() => {
      everSynced = true;
    })
    .finally(() => {
      syncInFlight = undefined;
    });
  syncInFlight = p;
  lastSync = p.catch(() => undefined);
  return p;
}

/**
 * Await the latest agent config sync. Triggers the first sync if none has run
 * yet; otherwise returns the most recent sync's result without re-running.
 * Tab/wizard spawn paths await this so the subprocess sees a ready config.
 */
export function awaitAgentConfigSynced(): Promise<void> {
  if (!everSynced && !syncInFlight) return syncAgentConfig();
  return lastSync;
}

/**
 * Absolute path to the bundled wizard extension directory.
 * Production (bundled): app/bun -> app/wizard-extension
 * Local dev: apps/desktop/src/bun -> apps/desktop/src/bun/wizard-extension
 * Returns [] if not found (wizard tools just won't register).
 */
export function resolveWizardExtensionPath(): string[] {
  const bundled = resolve(import.meta.dir, "..", "wizard-extension");
  if (existsSync(join(bundled, "index.ts")) || existsSync(join(bundled, "index.js"))) {
    return [bundled];
  }
  const dev = resolve(import.meta.dir, "wizard-extension");
  if (existsSync(join(dev, "index.ts")) || existsSync(join(dev, "index.js"))) {
    return [dev];
  }
  logger.warning("Wizard extension directory not found; wizard tools will not load");
  return [];
}
