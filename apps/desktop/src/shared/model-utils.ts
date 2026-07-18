import { HERMAN_PROVIDER_ID, parseModelRef } from "./model-selection.js";

/**
 * Returns the provider prefix for a model ID.
 *
 * Model IDs are formatted as "provider/modelName". IDs without a slash are
 * treated as belonging to the "herman" provider for backward compatibility.
 */
export function getModelProvider(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  return parseModelRef(modelId)?.provider;
}

/** Returns true when the given model ID belongs to the herman provider. */
export function isHermanModel(modelId?: string): boolean {
  return getModelProvider(modelId) === HERMAN_PROVIDER_ID;
}
