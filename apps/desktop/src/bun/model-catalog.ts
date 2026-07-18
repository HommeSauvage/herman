import { existsSync, readFileSync } from "node:fs";

import { getLogger } from "@logtape/logtape";
import {
  LEGACY_HERMAN_MODELS_CACHE_FILENAME,
  MODEL_CATALOG_FILENAME,
  type HermanModelEntry,
  type LegacyHermanModelsCacheFile,
  type ModelCatalogFile,
} from "@herman/rpc/agent";

import {
  mergeCatalogModels,
  normalizeModelId,
  type ModelCatalogSnapshot,
  type ModelMetadata,
} from "../shared/model-selection.js";
import { hermanDir } from "./app-paths.js";
import { writeFileAtomically } from "./fs-utils.js";

const logger = getLogger(["herman-desktop", "model-catalog"]);

export type { ModelCatalogSnapshot } from "../shared/model-selection.js";

export type ModelCatalogChangeInfo = {
  /** True when the herman model id list itself changed (agents should
   *  re-register their provider so `set_model` sees the new list). */
  hermanListChanged: boolean;
};

export type ModelCatalogServiceDeps = {
  getServerUrl: () => string | undefined;
  getToken: () => Promise<string | undefined>;
  isHermanEnabled: () => boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to `<hermanDir>/model-catalog.json`. */
  catalogFilePath?: () => string;
  /** Injectable for tests. Defaults to `<hermanDir>/herman-models-cache.json`. */
  legacyCacheFilePath?: () => string;
  onChange?: (snapshot: ModelCatalogSnapshot, info: ModelCatalogChangeInfo) => void;
  /** Fetch timeout (ms). */
  timeoutMs?: number;
};

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Single owner of the "which models exist" question for the desktop.
 *
 * Responsibilities:
 *  - Fetch Herman-provider models from the server (with the session token).
 *  - Persist them to `model-catalog.json` **only on success** — a failed or
 *    suspicious (empty) fetch never removes previously cached models, so the
 *    selector stays populated across restarts and server outages.
 *  - Merge custom-provider models observed from agent `models_sync` events.
 *  - Notify listeners (renderer broadcast, agent re-registration) on change.
 *
 * The agent Herman extension reads the same file for cache-first provider
 * registration at spawn; both writers preserve the section they do not own.
 */
export class ModelCatalogService {
  private hermanModels: HermanModelEntry[] = [];
  private hermanServerUrl?: string;
  private fetchedAt?: string;
  /** True once a network refresh succeeded in this process lifetime. */
  private hermanFresh = false;
  private customModels: Record<string, string[]> = {};
  private customMetadata: Record<string, ModelMetadata> = {};
  private lastSnapshotKey = "";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ModelCatalogServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  private catalogPath(): string {
    return this.deps.catalogFilePath?.() ?? `${hermanDir()}/${MODEL_CATALOG_FILENAME}`;
  }

  private legacyCachePath(): string {
    return (
      this.deps.legacyCacheFilePath?.() ?? `${hermanDir()}/${LEGACY_HERMAN_MODELS_CACHE_FILENAME}`
    );
  }

  /**
   * Synchronously seed the catalog from the on-disk cache. Call once at
   * startup before the renderer asks for the catalog — this is what makes the
   * model selector instant after a restart, even offline.
   */
  loadFromDisk(): void {
    const file = this.readCatalogFile();
    if (!file) return;

    this.customModels = file.custom ?? {};
    // The herman section is only valid for the server it was fetched from.
    const serverUrl = this.deps.getServerUrl()?.replace(/\/$/, "");
    if (file.serverUrl && serverUrl && file.serverUrl !== serverUrl) {
      logger.info("Ignoring cached Herman models from a different server", {
        cachedServerUrl: file.serverUrl,
        serverUrl,
      });
      return;
    }
    this.hermanModels = file.herman ?? [];
    this.hermanServerUrl = file.serverUrl;
    this.fetchedAt = file.fetchedAt;
    this.emitIfChanged({ hermanListChanged: this.hermanModels.length > 0 });
  }

  /**
   * Fetch the Herman model list from the server. On success the cache file is
   * rewritten atomically; on any failure the previous in-memory and on-disk
   * state is kept untouched.
   *
   * A 200 response with an empty model list is treated as a failure: the
   * Herman proxy always serves at least one model, so an empty list almost
   * certainly means a misconfigured server — not a reason to wipe the cache.
   */
  async refresh(): Promise<{ snapshot: ModelCatalogSnapshot; hermanListChanged: boolean }> {
    const serverUrl = this.deps.getServerUrl()?.replace(/\/$/, "");
    if (!this.deps.isHermanEnabled() || !serverUrl) {
      // The snapshot may still have changed (e.g. herman was just disabled,
      // which drops its models from the computed list) — notify if so.
      this.emitIfChanged({ hermanListChanged: false });
      return { snapshot: this.getSnapshot(), hermanListChanged: false };
    }

    let hermanListChanged = false;
    const token = await this.deps.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${serverUrl}/api/agent/models`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Herman server returned ${response.status}`);
      }
      const payload = (await response.json()) as { models?: HermanModelEntry[] };
      const models = Array.isArray(payload.models)
        ? payload.models.filter((m) => m && typeof m.id === "string" && m.id.length > 0)
        : [];
      if (models.length === 0) {
        throw new Error("Herman server returned an empty model list");
      }

      const previousIds = this.hermanModels.map((m) => m.id).join("\u0000");
      const nextIds = models.map((m) => m.id).join("\u0000");
      hermanListChanged = previousIds !== nextIds;

      this.hermanModels = models;
      this.hermanServerUrl = serverUrl;
      this.fetchedAt = new Date().toISOString();
      this.hermanFresh = true;
      this.persistToDisk();
      logger.info("Refreshed Herman model catalog", { modelCount: models.length });
      this.emitIfChanged({ hermanListChanged });
    } catch (error) {
      logger.warning("Failed to refresh Herman models; keeping cached catalog", {
        error: error instanceof Error ? error.message : String(error),
        cachedModelCount: this.hermanModels.length,
      });
    } finally {
      clearTimeout(timer);
    }
    return { snapshot: this.getSnapshot(), hermanListChanged };
  }

  /**
   * Merge models reported by an agent `models_sync` event into the catalog.
   * Only non-herman providers are ingested — the herman list is owned by the
   * server fetch. `models` are canonical `provider/id` strings.
   */
  ingestAgentModels(models: string[], metadata?: Record<string, ModelMetadata>): void {
    let changed = false;
    for (const fullId of models) {
      const normalized = normalizeModelId(fullId);
      if (!normalized) continue;
      const slash = normalized.indexOf("/");
      const provider = normalized.slice(0, slash);
      const id = normalized.slice(slash + 1);
      if (provider === "herman") continue;
      const list = this.customModels[provider] ?? [];
      if (!list.includes(id)) {
        this.customModels[provider] = [...list, id];
        changed = true;
      }
    }
    if (metadata) {
      for (const [fullId, meta] of Object.entries(metadata)) {
        if (!fullId.startsWith("herman/") && meta && meta.contextWindow > 0) {
          if (this.customMetadata[fullId]?.contextWindow !== meta.contextWindow) {
            this.customMetadata[fullId] = meta;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      this.persistToDisk();
      this.emitIfChanged({ hermanListChanged: false });
    }
  }

  getSnapshot(): ModelCatalogSnapshot {
    const hermanEnabled = this.deps.isHermanEnabled();
    const models = mergeCatalogModels({
      herman: this.hermanModels.map((m) => m.id),
      custom: this.customModels,
      hermanEnabled,
    });
    const modelMetadata: Record<string, ModelMetadata> = { ...this.customMetadata };
    if (hermanEnabled) {
      for (const model of this.hermanModels) {
        if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
          modelMetadata[`herman/${model.id}`] = {
            contextWindow: model.contextWindow,
            ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
          };
        }
      }
    }
    const snapshot: ModelCatalogSnapshot = {
      models,
      modelMetadata,
      hermanFromCache: !this.hermanFresh,
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
    };
    return snapshot;
  }

  private emitIfChanged(info: ModelCatalogChangeInfo): void {
    const snapshot = this.getSnapshot();
    const key = JSON.stringify([snapshot.models, snapshot.modelMetadata, snapshot.hermanFromCache]);
    if (key === this.lastSnapshotKey) return;
    this.lastSnapshotKey = key;
    this.deps.onChange?.(snapshot, info);
  }

  /** Read the catalog file, migrating the legacy agent-extension cache. */
  private readCatalogFile(): ModelCatalogFile | undefined {
    const path = this.catalogPath();
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelCatalogFile>;
        return {
          version: 1,
          serverUrl: parsed.serverUrl,
          fetchedAt: parsed.fetchedAt,
          herman: Array.isArray(parsed.herman) ? parsed.herman : [],
          custom: parsed.custom ?? {},
        };
      }
    } catch (error) {
      logger.warning("Failed to read model catalog cache; starting empty", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    // Migration: adopt the legacy agent-extension cache if present.
    const legacyPath = this.legacyCachePath();
    try {
      if (existsSync(legacyPath)) {
        const legacy = JSON.parse(
          readFileSync(legacyPath, "utf-8"),
        ) as LegacyHermanModelsCacheFile;
        if (Array.isArray(legacy.models)) {
          logger.info("Migrated legacy Herman models cache", { legacyPath });
          return {
            version: 1,
            serverUrl: legacy.serverUrl,
            fetchedAt: legacy.fetchedAt,
            herman: legacy.models,
            custom: {},
          };
        }
      }
    } catch {
      // Corrupt legacy cache — ignore.
    }
    return undefined;
  }

  private persistToDisk(): void {
    const path = this.catalogPath();
    const file: ModelCatalogFile = {
      version: 1,
      ...(this.hermanServerUrl ? { serverUrl: this.hermanServerUrl } : {}),
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
      herman: this.hermanModels,
      custom: this.customModels,
    };
    try {
      writeFileAtomically(path, JSON.stringify(file, null, 2));
    } catch {
      // Persisting is best-effort: the in-memory catalog keeps working and
      // the agent extension keeps its own read path. Logged inside
      // writeFileAtomically already.
    }
  }
}
