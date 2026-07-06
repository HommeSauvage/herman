import { cn } from "@herman/ui/lib/utils";
import { Sparkles, Code } from "lucide-react";
import { useCallback } from "react";

import { useAgentStore } from "../../lib/agent-store.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";

export function GeneralTab() {
  const settings = useAgentStore((s) => s.settings);
  const setSettings = useAgentStore((s) => s.setSettings);
  const mode = settings.mode ?? "normal";

  const handleModeChange = useCallback(
    (nextMode: "rookie" | "normal") => {
      const next = { ...settings, mode: nextMode };
      setSettings(next);
      void desktopRpc.request.saveSettings({ settings: next });
    },
    [settings, setSettings],
  );

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-text mb-6 text-xl font-semibold">General</h1>

      {/* Mode selector */}
      <section className="mb-8">
        <h2 className="text-text mb-1 text-sm font-medium">Interface mode</h2>
        <p className="text-dim mb-4 text-xs leading-relaxed">
          Rookie Mode simplifies the interface with guided onboarding and a preview-first layout.
          You can switch back anytime — nothing is lost.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => handleModeChange("rookie")}
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border p-5 text-left transition active:scale-[0.97]",
              mode === "rookie"
                ? "border-signal/30 bg-signal/5 ring-1 ring-signal/20"
                : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]",
            )}
          >
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl",
                mode === "rookie" ? "bg-signal/10 text-signal" : "bg-white/[0.04] text-dim",
              )}
            >
              <Sparkles size={22} strokeWidth={1.5} />
            </div>
            <div className="text-center">
              <div
                className={cn(
                  "text-sm font-semibold",
                  mode === "rookie" ? "text-text" : "text-dim",
                )}
              >
                Rookie Mode
              </div>
              <div className="text-ghost mt-0.5 text-[11px] leading-snug">
                Guided experience, preview-first, no jargon
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange("normal")}
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border p-5 text-left transition active:scale-[0.97]",
              mode === "normal"
                ? "border-signal/30 bg-signal/5 ring-1 ring-signal/20"
                : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]",
            )}
          >
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl",
                mode === "normal" ? "bg-signal/10 text-signal" : "bg-white/[0.04] text-dim",
              )}
            >
              <Code size={22} strokeWidth={1.5} />
            </div>
            <div className="text-center">
              <div
                className={cn(
                  "text-sm font-semibold",
                  mode === "normal" ? "text-text" : "text-dim",
                )}
              >
                Normal Mode
              </div>
              <div className="text-ghost mt-0.5 text-[11px] leading-snug">
                Full control, all settings, power user tools
              </div>
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}
