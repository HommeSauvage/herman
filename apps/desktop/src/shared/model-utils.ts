/**
 * Returns the provider prefix for a model ID.
 *
 * Model IDs are formatted as "provider/modelName". IDs without a slash are
 * treated as belonging to the "herman" provider for backward compatibility.
 */
export function getModelProvider(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  const slashIndex = modelId.indexOf("/");
  return slashIndex > 0 ? modelId.slice(0, slashIndex) : "herman";
}

/** Returns true when the given model ID belongs to the herman provider. */
export function isHermanModel(modelId?: string): boolean {
  return getModelProvider(modelId) === "herman";
}
