/**
 * Pure model-selection logic shared between the desktop main process, the
 * renderer, and (indirectly) the agent Herman extension.
 *
 * Model ids are canonical in provider-prefixed form: `herman/kimi-k2.7-code`,
 * `openai/gpt-4o-mini`. Bare ids (no slash) belong to the `herman` provider.
 *
 * The selection model has three distinct pieces of state:
 *
 *  - **Catalog** — which models exist (owned by the main-process
 *    `ModelCatalogService`; the renderer only mirrors it).
 *  - **Desired per-tab model** — the user's selection for one session,
 *    persisted with the session and applied to the tab's agent whenever the
 *    agent's model registry reports it as available.
 *  - **Last-used model** — the last model the user explicitly picked in any
 *    tab, persisted globally; seeds the desired model of fresh tabs.
 */

export const HERMAN_PROVIDER_ID = "herman";

export type ModelMetadata = {
  contextWindow: number;
  maxTokens?: number;
};

/**
 * Computed view of the model catalog, produced by the main-process
 * `ModelCatalogService` and consumed by the renderer and tab seeding logic.
 * `models` are canonical provider-prefixed ids, herman first.
 */
export type ModelCatalogSnapshot = {
  models: string[];
  /** contextWindow/maxTokens per full model id, when known. */
  modelMetadata: Record<string, ModelMetadata>;
  /** True when the herman section comes from the on-disk cache (or is empty)
   *  rather than from a successful fetch in this process lifetime. */
  hermanFromCache: boolean;
  /** ISO timestamp of the last successful herman fetch, if any. */
  fetchedAt?: string;
};

export type ModelRef = {
  provider: string;
  /** Model id without the provider prefix. May itself contain slashes. */
  modelId: string;
};

/**
 * Split a model id into provider + model id. Bare ids default to the herman
 * provider. Only the first slash separates provider from id — nested slashes
 * (`custom/org/model`) stay in the model id.
 */
export function parseModelRef(modelId: string): ModelRef | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) {
    return { provider: HERMAN_PROVIDER_ID, modelId: trimmed };
  }
  const provider = trimmed.slice(0, slashIndex);
  const id = trimmed.slice(slashIndex + 1);
  if (!provider || !id) return undefined;
  return { provider, modelId: id };
}

/**
 * Canonical provider-prefixed form of a model id, or `undefined` when the id
 * is malformed (empty, or a dangling `provider/` with no model id).
 */
export function normalizeModelId(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  const ref = parseModelRef(modelId);
  if (!ref) return undefined;
  return `${ref.provider}/${ref.modelId}`;
}

/** Strip the provider prefix for display. */
export function shortModelId(modelId: string): string {
  const ref = parseModelRef(modelId);
  return ref ? ref.modelId : modelId;
}

/** Sort a model list with herman models first, then provider, then id. */
export function sortModelsHermanFirst(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const aRef = parseModelRef(a);
    const bRef = parseModelRef(b);
    const aProvider = aRef?.provider ?? "unknown";
    const bProvider = bRef?.provider ?? "unknown";
    const aHerman = aProvider === HERMAN_PROVIDER_ID ? -1 : 1;
    const bHerman = bProvider === HERMAN_PROVIDER_ID ? -1 : 1;
    if (aHerman !== bHerman) return aHerman - bHerman;
    if (aProvider !== bProvider) return aProvider.localeCompare(bProvider);
    return (aRef?.modelId ?? a).localeCompare(bRef?.modelId ?? b);
  });
}

/**
 * Merge the server-authoritative herman model list with custom-provider
 * models observed from agent `models_sync` events into one deduplicated,
 * sorted catalog. `herman/*` entries in the custom map are ignored — the
 * server list always wins for the herman provider.
 */
export function mergeCatalogModels(args: {
  /** Bare herman model ids (from the server or the on-disk cache). */
  herman: string[];
  /** provider -> model ids observed from agents. */
  custom: Record<string, string[]>;
  hermanEnabled: boolean;
}): string[] {
  const merged = new Set<string>();
  if (args.hermanEnabled) {
    for (const id of args.herman) {
      const normalized = normalizeModelId(`${HERMAN_PROVIDER_ID}/${id}`);
      if (normalized) merged.add(normalized);
    }
  }
  for (const [provider, ids] of Object.entries(args.custom)) {
    if (provider === HERMAN_PROVIDER_ID) continue;
    for (const id of ids) {
      const normalized = normalizeModelId(`${provider}/${id}`);
      if (normalized) merged.add(normalized);
    }
  }
  return sortModelsHermanFirst([...merged]);
}

/**
 * Decide whether the agent's desired model should be (re)sent to the agent.
 *
 * The apply is driven by `models_sync` events — the signal that the agent's
 * model registry is populated. We apply only when the desired model exists,
 * differs from what the agent reports as current, and is actually in the
 * registry's advertised list. A model that is not (yet) in the list is left
 * alone: it may appear on the next refresh, at which point the apply fires.
 */
export function shouldApplyDesiredModel(args: {
  desired?: string;
  /** Model the agent currently reports (models_sync.currentModel). */
  actual?: string;
  /** Models the agent's registry currently advertises. */
  available: string[];
}): boolean {
  const desired = normalizeModelId(args.desired);
  if (!desired) return false;
  if (desired === normalizeModelId(args.actual)) return false;
  return args.available.includes(desired);
}

/**
 * Fingerprint of an apply attempt: the desired model plus the registry
 * snapshot it was attempted against. Retry budgets are scoped to this
 * fingerprint — a changed model list (or a changed selection) earns a fresh
 * budget, while repeated identical failures stop quickly.
 */
export function modelApplyFingerprint(desired: string, available: string[]): string {
  return `${desired}|${[...available].sort().join(",")}`;
}

/**
 * Pick the initial model for a fresh tab. The last-used model wins when it
 * is known to exist; when the catalog is empty (unknown — e.g. offline first
 * run) we still seed optimistically and let the apply machinery settle it
 * once the agent's registry syncs.
 */
export function resolveSeedModel(args: {
  lastUsed?: string;
  available?: string[];
}): string | undefined {
  const lastUsed = normalizeModelId(args.lastUsed);
  if (!lastUsed) return undefined;
  const available = args.available ?? [];
  if (available.length === 0) return lastUsed;
  return available.includes(lastUsed) ? lastUsed : undefined;
}
