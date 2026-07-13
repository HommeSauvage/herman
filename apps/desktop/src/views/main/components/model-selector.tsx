import { cn } from "@herman/ui/lib/utils";
import { Brain, Cpu, Globe, Search, X, Zap } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { ElementType } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { refreshHermanModels, selectModel } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";

const EMPTY_MODELS: string[] = [];
const EMPTY_HIDDEN_MODELS: string[] = []; // stable fallback for useShallow selector
const HERMAN_PROVIDER_ID = 'herman';

function getEnabledProviders(settings: { providers: { herman: { enabled: boolean }; custom: Record<string, { enabled?: boolean } | undefined> } }): Set<string> {
  const enabled = new Set<string>();
  if (settings.providers.herman.enabled) enabled.add(HERMAN_PROVIDER_ID);
  for (const [id, config] of Object.entries(settings.providers.custom)) {
    if (config?.enabled) enabled.add(id);
  }
  return enabled;
}

type GroupedModels = {
  provider: string;
  models: string[];
};

const PROVIDER_ICONS: Record<string, ElementType> = {
  herman: Zap,
  openai: Cpu,
  anthropic: Brain,
  google: Globe,
};

function providerIcon(provider: string): ElementType {
  return PROVIDER_ICONS[provider] ?? Cpu;
}

function groupModels(models: string[]): GroupedModels[] {
  const groups = new Map<string, string[]>();
  for (const modelId of models) {
    const [provider, ...rest] = modelId.split("/");
    const key = provider ?? "unknown";
    const list = groups.get(key) ?? [];
    list.push(rest.length > 0 ? rest.join("/") : modelId);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([provider, models]) => ({
    provider,
    models,
  }));
}

function sortModelsHermanFirst(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const [aProvider, ...aRest] = a.split("/");
    const [bProvider, ...bRest] = b.split("/");
    const aHerman = aProvider === HERMAN_PROVIDER_ID ? -1 : 1;
    const bHerman = bProvider === HERMAN_PROVIDER_ID ? -1 : 1;
    if (aHerman !== bHerman) return aHerman - bHerman;
    if (aProvider !== bProvider) return aProvider.localeCompare(bProvider);
    const aId = aRest.join("/");
    const bId = bRest.join("/");
    return aId.localeCompare(bId);
  });
}

export function ModelSelector() {
  const open = useAgentStore((s) => s.ui.modelSelectorOpen);
  const setModelSelectorOpen = useAgentStore((s) => s.setModelSelectorOpen);
  const { tabId, models, currentModel, hiddenModels, settings } = useAgentStore(
    useShallow((s) => {
      const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
      return {
        tabId: tab?.id,
        models: tab?.availableModels ?? EMPTY_MODELS,
        currentModel: tab?.currentModel,
        hiddenModels: s.settings.models.hiddenModels ?? EMPTY_HIDDEN_MODELS,
        settings: s.settings,
      };
    }),
  );
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const enabledProviders = useMemo(
    () => getEnabledProviders(settings),
    [settings],
  );
  const visibleModels = useMemo(
    () => models.filter((id) => {
      if (hiddenModels.includes(id)) return false;
      const [provider] = id.split('/');
      return enabledProviders.has(provider ?? 'unknown');
    }),
    [models, hiddenModels, enabledProviders],
  );
  const filteredModels = useMemo(
    () => sortModelsHermanFirst(visibleModels.filter((id) => id.toLowerCase().includes(query))),
    [visibleModels, query],
  );
  const grouped = useMemo(() => groupModels(filteredModels), [filteredModels]);
  const flatIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of grouped) {
      for (const model of group.models) {
        ids.push(`${group.provider}/${model}`);
      }
    }
    return ids;
  }, [grouped]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  useEffect(() => {
    if (open) {
      setSearch("");
      setFocusedIndex(-1);
      inputRef.current?.focus();
      // Refresh Herman models each time the selector opens. The refresh is
      // silent (no loading UI); the updated herman/models_sync event will
      // update the list if the server is now reachable.
      if (tabId && settings.providers.herman.enabled) {
        void refreshHermanModels(tabId);
      }
    }
  }, [open]);

  function handleOverlayKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      setModelSelectorOpen(false);
    }
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && flatIds.length > 0) {
      event.preventDefault();
      setFocusedIndex(0);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setModelSelectorOpen(false);
    }
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (flatIds.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedIndex((prev) => Math.min(flatIds.length - 1, Math.max(0, prev) + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (focusedIndex <= 0) {
        setFocusedIndex(-1);
        inputRef.current?.focus();
      } else {
        setFocusedIndex(focusedIndex - 1);
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFocusedIndex(flatIds.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setFocusedIndex(-1);
      inputRef.current?.focus();
    }
  }

  useEffect(() => {
    if (focusedIndex >= 0) {
      itemRefs.current[focusedIndex]?.focus();
    }
  }, [focusedIndex]);

  useEffect(() => {
    setFocusedIndex(-1);
  }, [search]);

  async function handleSelect(modelId: string) {
    if (!tabId) return;
    // Optimistically update the UI so the model changes immediately.
    // The async models_sync event will confirm it later.
    useAgentStore.getState().setModels(tabId, modelId);
    setModelSelectorOpen(false);
    await selectModel(tabId, modelId);
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={reducedMotion ? undefined : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24 backdrop-blur-sm"
          onClick={() => setModelSelectorOpen(false)}
          onKeyDown={handleOverlayKeyDown}
        >
          <motion.div
            initial={reducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
            transition={
              reducedMotion ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.25 }
            }
            className="bg-surface flex w-[480px] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-white/[0.06] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bg-void flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
              <Search size={14} className="text-ghost" />
              <input
                ref={inputRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Search models…"
                className="text-text placeholder:text-ghost flex-1 bg-transparent text-sm focus:outline-none"
              />
              <button
                onClick={() => setModelSelectorOpen(false)}
                className="text-faint hover:text-text rounded-md p-1 transition hover:bg-white/[0.06]"
              >
                <X size={14} />
              </button>
            </div>

            <div className="max-h-[320px] overflow-y-auto p-2" onKeyDown={handleListKeyDown}>
              {filteredModels.length === 0 ? (
                <div className="text-dim px-3 py-6 text-center text-xs">
                  {models.length === 0
                    ? "No models available."
                    : visibleModels.length === 0
                      ? "All models are hidden. Manage visibility in Settings → Models."
                      : "No models match your search."}
                </div>
              ) : (
                (() => {
                  let itemIndex = -1;
                  return grouped.map((group, groupIndex) => (
                    <div key={group.provider} className="mb-3 last:mb-0">
                      <div className="text-ghost bg-surface sticky top-0 flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold tracking-[0.08em] uppercase">
                        {(() => {
                          const Icon = providerIcon(group.provider);
                          return <Icon size={12} className="shrink-0" />;
                        })()}
                        {group.provider}
                      </div>
                      <div className="space-y-0.5">
                        {group.models.map((modelId, index) => {
                          itemIndex++;
                          const fullId = `${group.provider}/${modelId}`;
                          return (
                            <motion.button
                              ref={(el) => {
                                itemRefs.current[itemIndex] = el;
                              }}
                              key={fullId}
                              onFocus={() => setFocusedIndex(itemIndex)}
                              initial={reducedMotion ? undefined : { opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={
                                reducedMotion
                                  ? { duration: 0 }
                                  : { duration: 0.15, delay: (groupIndex * 4 + index) * 0.02 }
                              }
                              onClick={() => handleSelect(fullId)}
                              className={cn(
                                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition",
                                fullId === currentModel
                                  ? "text-text bg-white/[0.06]"
                                  : "text-dim hover:text-text hover:bg-white/[0.04]",
                              )}
                            >
                              <Cpu
                                size={15}
                                className={fullId === currentModel ? "text-signal" : "text-faint"}
                              />
                              <span className="flex-1 truncate text-sm">{modelId}</span>
                              {fullId === currentModel && (
                                <span className="text-signal text-[10px]">Active</span>
                              )}
                            </motion.button>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
