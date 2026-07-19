/**
 * ToolchainSetup — the one-time first-run gate (tier-0 tools: git, Homebrew,
 * bun on macOS). Shown only when something required is missing; users with a
 * healthy machine never see it.
 *
 * UX contract (rookie-first, shown in both modes since nothing works without
 * these tools): one screen, one button, plain-language whys, native OS
 * dialogs announced in advance, logs behind a disclosure, per-tool retry.
 */

import { cn } from "@herman/ui/lib/utils";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";

import type { ToolchainToolStatus } from "../../../shared/tool-registry.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { type ToolProgress, useToolchainInstall } from "../lib/use-toolchain-install.js";
import { ProgressLog } from "./progress-log.js";
import { ContentWidth, SignalButton } from "./ui/index.js";

function ToolRow({ tool, progress }: { tool: ToolchainToolStatus; progress?: ToolProgress }) {
  const state = progress?.state ?? (tool.installed ? "done" : "pending");
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
          state === "done" && "bg-emerald-500/10 text-emerald-400",
          state === "pending" && "bg-white/[0.04] text-ghost",
          (state === "running" || state === "waiting") && "bg-signal/10 text-signal",
          state === "failed" && "bg-red-500/10 text-red-400",
        )}
      >
        {state === "done" && <Check size={14} strokeWidth={2.5} />}
        {state === "pending" && <Wrench size={13} />}
        {(state === "running" || state === "waiting") && (
          <Loader2 size={13} className="animate-spin" />
        )}
        {state === "failed" && <AlertCircle size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-text text-sm font-medium">{tool.label}</span>
          {state === "done" && tool.detail && (
            <span className="text-ghost truncate text-[10px]">{tool.detail}</span>
          )}
        </div>
        <p className="text-dim mt-0.5 text-xs leading-relaxed">{tool.why}</p>
        {(state === "waiting" || state === "failed") && progress?.note && (
          <p
            className={cn(
              "mt-1 text-[11px] leading-relaxed",
              state === "failed" ? "text-red-400" : "text-amber-300",
            )}
          >
            {progress.note}
          </p>
        )}
      </div>
    </div>
  );
}

export function ToolchainSetup({ onComplete }: { onComplete: () => void }) {
  const [tools, setTools] = useState<ToolchainToolStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const { state, runInstall } = useToolchainInstall();

  const refresh = useCallback(async () => {
    try {
      const status = await desktopRpc.request.getToolchainStatus();
      const required = status.tools.filter((t) => status.required.includes(t.id));
      setTools(required);
      setLoadError(null);
      return required.every((t) => t.installed);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh().then((allGood) => {
      // Race guard: another component may have finished setup already.
      if (allGood) onComplete();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstall = useCallback(async () => {
    if (!tools) return;
    const missing = tools.filter((t) => !t.installed);
    const results = await runInstall(missing.map((t) => ({ toolId: t.id, label: t.label })));
    const allOk = results.every((r) => r.ok);
    // Re-detect from scratch (also covers tools the user installed manually
    // in another window while this screen was up).
    const healthy = await refresh();
    if (allOk && healthy) {
      setFinished(true);
      setTimeout(onComplete, 900);
    }
  }, [tools, runInstall, refresh, onComplete]);

  const missingCount = tools?.filter((t) => !t.installed).length ?? 0;
  const anyFailed = state.tools.some((t) => t.state === "failed");

  return (
    <div className="bg-void relative flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <ContentWidth size="form">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col"
          >
            <div className="mb-6 text-center">
              <div className="bg-signal/10 text-signal mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ring-signal/20">
                <ShieldCheck size={26} strokeWidth={1.5} />
              </div>
              <h1 className="text-text text-2xl font-semibold tracking-tight">
                One-time computer setup
              </h1>
              <p className="text-dim mt-1.5 text-sm leading-relaxed">
                Herman needs a few free tools to build projects on your computer. This takes about
                10 minutes and only happens once.
              </p>
            </div>

            {loadError && (
              <div className="mb-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>Couldn't check your computer: {loadError}</span>
              </div>
            )}

            <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.08] bg-white/[0.02]">
              {(tools ?? []).map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  progress={state.tools.find((p) => p.toolId === tool.id)}
                />
              ))}
              {!tools && (
                <div className="flex items-center justify-center gap-2 px-4 py-8">
                  <Loader2 size={14} className="text-signal animate-spin" />
                  <span className="text-dim text-sm">Checking your computer…</span>
                </div>
              )}
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/15 bg-amber-500/[0.06] px-4 py-3">
              <span className="text-amber-200/90 text-[11px] leading-relaxed">
                Along the way your Mac will show two system dialogs — an Apple installer and a
                password prompt. Both are expected; Herman never sees your password.
              </span>
            </div>

            {state.logLines.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setShowLogs((v) => !v)}
                  className="text-ghost hover:text-dim mb-2 flex items-center gap-1 text-[11px] transition"
                >
                  <ChevronDown size={12} className={cn("transition", showLogs && "rotate-180")} />
                  {showLogs ? "Hide details" : "Show details"}
                </button>
                {showLogs && <ProgressLog lines={state.logLines} />}
              </div>
            )}

            {finished ? (
              <div className="text-emerald-400 mt-5 flex items-center justify-center gap-2 text-sm font-medium">
                <Check size={16} strokeWidth={2.5} />
                Your computer is ready
              </div>
            ) : (
              <SignalButton
                size="lg"
                fullWidth
                glow
                className="mt-5"
                disabled={!tools || state.running || missingCount === 0}
                onClick={handleInstall}
              >
                {state.running ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Setting up your computer…
                  </>
                ) : anyFailed ? (
                  "Retry"
                ) : (
                  "Set up my computer"
                )}
              </SignalButton>
            )}

            <p className="text-ghost mt-3 text-center text-[11px] leading-relaxed">
              Everything is installed from its official source.
            </p>
          </motion.div>
        </ContentWidth>
      </div>
    </div>
  );
}

/** Small inline link used by failure messages that carry a manual URL. */
export function ManualInstallLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-signal hover:underline inline-flex items-center gap-1"
    >
      Install manually
      <ExternalLink size={10} />
    </a>
  );
}
