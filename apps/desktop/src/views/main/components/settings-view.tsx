import { cn } from "@herman/ui/lib/utils";
import { ArrowLeft, Cpu, Layers, Puzzle, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { GeneralTab } from "./settings/general-tab.js";
import { ModelsTab } from "./settings/models-tab.js";
import { ProvidersTab } from "./settings/providers-tab.js";
import { SkillsTab } from "./settings/skills-tab.js";

type SettingsTab = "providers" | "models" | "general" | "skills";

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "providers", label: "Providers", icon: Layers },
  { id: "models", label: "Models", icon: Cpu },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "general", label: "General", icon: SlidersHorizontal },
];

export function SettingsView() {
  const settings = useAgentStore((s) => s.settings);
  const setSettings = useAgentStore((s) => s.setSettings);
  const setView = useAgentStore((s) => s.setView);
  const [activeTab, setActiveTabState] = useState<SettingsTab>(
    settings.settingsActiveTab ?? "providers",
  );

  const setActiveTab = useCallback(
    (tab: SettingsTab) => {
      setActiveTabState(tab);
      const next = { ...settings, settingsActiveTab: tab };
      setSettings(next);
      void desktopRpc.request.saveSettings({ settings: next });
    },
    [settings, setSettings],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Don't navigate away if a dialog is open.
        if (document.querySelector('[role="dialog"]')) return;
        useAgentStore.getState().setView("home");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-full w-full">
      <nav
        role="tablist"
        className="bg-surface/40 flex w-14 shrink-0 flex-col items-center border-r border-white/[0.06] p-2 transition min-[501px]:w-52 min-[501px]:items-stretch min-[501px]:p-3"
      >
        <h2 className="text-ghost mb-2 hidden px-2 text-[10px] font-bold tracking-[0.12em] uppercase min-[501px]:block">
          Settings
        </h2>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-label={tab.label}
              className={cn(
                "flex w-full items-center justify-center rounded-lg px-0 py-2 text-sm transition focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:outline-none min-[501px]:justify-start min-[501px]:gap-2 min-[501px]:px-2 min-[501px]:text-left",
                activeTab === tab.id
                  ? "text-text bg-white/[0.06]"
                  : "text-dim hover:text-text hover:bg-white/[0.04]",
              )}
            >
              <Icon size={14} className="text-faint shrink-0" />
              <span className="hidden min-[501px]:inline">{tab.label}</span>
            </button>
          );
        })}

        <div className="mt-auto" />
        <button
          onClick={() => setView("home")}
          aria-label="Back to home"
          className="text-dim hover:text-text flex w-full items-center justify-center rounded-lg px-0 py-2 text-sm transition hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:outline-none min-[501px]:justify-start min-[501px]:gap-2 min-[501px]:px-2 min-[501px]:text-left"
        >
          <ArrowLeft size={14} className="text-faint shrink-0" />
          <span className="hidden min-[501px]:inline">Back</span>
        </button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        {settings.credentialStoreError && (
          <div
            role="alert"
            aria-live="polite"
            className="bg-warning/10 border-warning/20 text-text mb-4 flex items-start gap-3 rounded-lg border p-3 text-sm"
          >
            <TriangleAlert size={16} className="text-warning mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Could not unlock saved credentials</p>
              <p className="text-dim text-xs">{settings.credentialStoreError}</p>
            </div>
          </div>
        )}
        <div role="tabpanel" hidden={activeTab !== "providers"}>
          <ProvidersTab />
        </div>
        <div role="tabpanel" hidden={activeTab !== "models"}>
          <ModelsTab />
        </div>
        <div role="tabpanel" hidden={activeTab !== "skills"}>
          <SkillsTab />
        </div>
        <div role="tabpanel" hidden={activeTab !== "general"}>
          <GeneralTab />
        </div>
      </div>
    </div>
  );
}
