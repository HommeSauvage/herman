import { isHermanModel } from "../../../shared/model-utils.js";
import { useAgentStore } from "./agent-store.js";

/** Returns true when the active tab's current model uses the herman provider. */
export function useIsHermanProvider(): boolean {
  const currentModel = useAgentStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.currentModel : undefined,
  );
  return isHermanModel(currentModel);
}
