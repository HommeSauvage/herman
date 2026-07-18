/**
 * Internal message used to ask the Herman extension to refresh its model list.
 *
 * The desktop sends this as a prompt command via the agent RPC. The Herman
 * extension intercepts it in its `input` event handler, performs a silent
 * refresh of the server models, and returns `handled` so the prompt is not
 * recorded as a user message.
 */
export const HERMAN_REFRESH_MODELS_MESSAGE = "__herman_refresh_models__";

/**
 * On-disk model catalog shared between the desktop main process and the agent
 * Herman extension. The desktop owns the file; the extension reads it for
 * instant (cache-first) provider registration at spawn and writes through on
 * successful refreshes so standalone CLI runs still populate it.
 *
 * Writers must preserve sections they do not own (`custom` is owned by the
 * desktop) and must never truncate the file on a failed fetch — the cache
 * exists precisely so models survive server errors and restarts.
 */
export const MODEL_CATALOG_FILENAME = "model-catalog.json";

/** Legacy cache file written by older agent extensions. Migrated on read. */
export const LEGACY_HERMAN_MODELS_CACHE_FILENAME = "herman-models-cache.json";

export type HermanModelCompat = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
};

/** A Herman-provider model as returned by `GET /api/agent/models`. */
export type HermanModelEntry = {
  id: string;
  name?: string;
  api?: "openai-completions" | "anthropic-messages";
  providerId?: string;
  contextWindow?: number;
  maxTokens?: number;
  compat?: HermanModelCompat;
};

export type ModelCatalogFile = {
  version: 1;
  /** Herman server base URL the `herman` section was fetched from. */
  serverUrl?: string;
  /** ISO timestamp of the last successful Herman models fetch. */
  fetchedAt?: string;
  /** Herman-provider models (server-authoritative). */
  herman: HermanModelEntry[];
  /** Custom-provider model ids observed from agent models_sync events. */
  custom: Record<string, string[]>;
};

/** Legacy on-disk shape written by older agent extensions. */
export type LegacyHermanModelsCacheFile = {
  serverUrl: string;
  fetchedAt: string;
  models: HermanModelEntry[];
};
