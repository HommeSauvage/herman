import { Button } from "@herman/ui/components/button";
import { cn } from "@herman/ui/lib/utils";
import { Cpu, Eye, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { useAgentStore } from "../../lib/agent-store.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";

export function ModelsTab() {
  const settings = useAgentStore((s) => s.settings);
  const setSettings = useAgentStore((s) => s.setSettings);

  // Subscribe only to availableModels from each tab, not the full tabs record
  // which changes on every streaming delta and causes unnecessary re-renders.
  // We build a stable version string from model IDs so useShallow can
  // detect when the set of models actually changed.
  const allModels = useAgentStore(
    useShallow((s) => {
      const seen = new Set<string>();
      for (const tab of Object.values(s.tabs)) {
        for (const modelId of tab.availableModels) {
          seen.add(modelId);
        }
      }
      return Array.from(seen).sort().join("\x00");
    }),
  );

  const [defaultModel, setDefaultModel] = useState(settings.models.defaultModel ?? "");

  const hiddenModels = settings.models.hiddenModels ?? [];

  async function saveDefaultModel(modelId: string) {
    const prevDefault = defaultModel;
    const prevSettings = settings;
    setDefaultModel(modelId);
    const next = {
      ...settings,
      models: { ...settings.models, defaultModel: modelId || undefined },
    };
    setSettings(next);
    try {
      await desktopRpc.request.saveSettings({ settings: next });
    } catch {
      setDefaultModel(prevDefault);
      setSettings(prevSettings);
      toast.error("Failed to save default model.");
    }
  }

  async function toggleModelHidden(modelId: string, hidden: boolean) {
    const prevSettings = settings;
    const nextHidden = hidden
      ? [...new Set([...hiddenModels, modelId])]
      : hiddenModels.filter((id) => id !== modelId);
    const next = {
      ...settings,
      models: { ...settings.models, hiddenModels: nextHidden },
    };
    setSettings(next);
    try {
      await desktopRpc.request.saveSettings({ settings: next });
    } catch {
      setSettings(prevSettings);
      toast.error("Failed to update model visibility.");
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const modelId of allModels.split("\x00")) {
      if (!modelId) continue;
      const slashIndex = modelId.indexOf("/");
      const provider = slashIndex > 0 ? modelId.slice(0, slashIndex) : "herman";
      const name = slashIndex > 0 ? modelId.slice(slashIndex + 1) : modelId;
      const list = map.get(provider) ?? [];
      list.push(name);
      map.set(provider, list);
    }
    return Array.from(map.entries());
  }, [allModels]);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-text mb-6 text-xl font-semibold">Models</h1>

      {allModels === "" ? (
        <div className="text-dim text-sm">
          No models available yet. Start a conversation to discover available models.
        </div>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="text-ghost mb-3 text-xs font-bold tracking-[0.08em] uppercase">
              Default Model
            </h2>
            <select
              value={defaultModel}
              onChange={(e) => void saveDefaultModel(e.target.value)}
              className="bg-surface text-text w-full max-w-xs rounded-lg border border-white/[0.06] px-3 py-2 text-sm focus:ring-1 focus:ring-white/10 focus:outline-none"
            >
              <option value="">None (use agent default)</option>
              {allModels
                .split("\x00")
                .filter(Boolean)
                .map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
            </select>
            <p className="text-ghost mt-1.5 text-xs">
              The default model is used when starting new conversations.
            </p>
          </section>

          <section>
            <h2 className="text-ghost mb-3 text-xs font-bold tracking-[0.08em] uppercase">
              Model Visibility
            </h2>
            <p className="text-dim mb-4 text-xs">
              Hide models you don't use from the model selector.
            </p>

            <div className="space-y-4">
              {grouped.map(([provider, modelNames]) => {
                const visibleCount = modelNames.filter(
                  (name) => !hiddenModels.includes(`${provider}/${name}`),
                ).length;
                return (
                  <div key={provider}>
                    <div className="text-ghost mb-2 px-1 text-[10px] font-bold tracking-[0.08em] uppercase">
                      {provider}
                      {visibleCount < modelNames.length && (
                        <span className="text-faint ml-1 font-normal">
                          ({visibleCount} of {modelNames.length} visible)
                        </span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {modelNames.map((name) => {
                        const fullId = `${provider}/${name}`;
                        const isHidden = hiddenModels.includes(fullId);
                        return (
                          <div
                            key={fullId}
                            className={cn(
                              "bg-surface flex items-center justify-between rounded-lg border border-white/[0.06] px-4 py-2.5 transition",
                              isHidden && "opacity-50",
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <Cpu size={15} className="text-faint shrink-0" />
                              <span className="text-text truncate text-sm">{name}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void toggleModelHidden(fullId, !isHidden)}
                              className="text-faint hover:text-text ml-2 shrink-0"
                            >
                              {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                              <span className="ml-1.5 text-xs">
                                {isHidden ? "Hidden" : "Visible"}
                              </span>
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
