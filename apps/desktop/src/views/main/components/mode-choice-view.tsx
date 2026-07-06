import { motion } from "motion/react";
import { Sparkles, Code } from "lucide-react";
import { useCallback } from "react";

import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";

export function ModeChoiceView({ onChoose }: { onChoose: (mode: "rookie" | "normal") => void }) {
  const setSettings = useAgentStore((s) => s.setSettings);
  const settings = useAgentStore((s) => s.settings);

  const handleChoose = useCallback(
    (mode: "rookie" | "normal") => {
      const next = { ...settings, mode };
      setSettings(next);
      void desktopRpc.request.saveSettings({ settings: next });
      onChoose(mode);
    },
    [settings, setSettings, onChoose],
  );

  return (
    <div className="bg-void flex h-full items-center justify-center p-6">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="bg-signal/10 h-[520px] w-[520px] rounded-full blur-[140px]" />
      </div>

      <div className="animate-fade-in-up relative w-full max-w-lg">
        <div className="bg-peak rounded-3xl border border-white/[0.12] p-10 shadow-2xl shadow-black/50">
          <div className="mb-6 flex justify-center">
            <div className="animate-signal-pulse bg-signal/10 text-signal flex h-16 w-16 items-center justify-center rounded-2xl">
              <Sparkles size={28} strokeWidth={1.5} />
            </div>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-text mb-2 text-2xl font-semibold tracking-tight">
              Welcome to Herman
            </h1>
            <p className="text-dim mx-auto max-w-xs text-sm leading-relaxed text-balance">
              How would you like to get started?
            </p>
          </div>

          <div className="space-y-3">
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => handleChoose("rookie")}
              className="bg-signal/5 border-signal/20 hover:border-signal/40 hover:bg-signal/10 flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-all"
            >
              <div className="bg-signal/10 text-signal flex h-12 w-12 shrink-0 items-center justify-center rounded-xl">
                <Sparkles size={22} strokeWidth={1.5} />
              </div>
              <div>
                <div className="text-text text-sm font-semibold">Rookie Mode</div>
                <div className="text-dim text-xs leading-snug">
                  Guided experience. Pick a template, answer a few questions, and we&apos;ll build
                  it together. No tech knowledge needed.
                </div>
              </div>
            </motion.button>

            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => handleChoose("normal")}
              className="bg-white/[0.02] border-white/[0.06] hover:border-white/[0.14] hover:bg-white/[0.04] flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-all"
            >
              <div className="bg-white/[0.04] text-dim flex h-12 w-12 shrink-0 items-center justify-center rounded-xl">
                <Code size={22} strokeWidth={1.5} />
              </div>
              <div>
                <div className="text-text text-sm font-semibold">Normal Mode</div>
                <div className="text-dim text-xs leading-snug">
                  Full control. Open any project folder, choose models and providers, use all the
                  power tools. For experienced developers.
                </div>
              </div>
            </motion.button>
          </div>
        </div>

        <p className="text-ghost mt-5 text-center text-xs">
          You can switch modes anytime in Settings.
        </p>
      </div>
    </div>
  );
}
