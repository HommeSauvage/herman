/**
 * WizardToolSetup — the "Getting your computer ready" step between template
 * selection and the planning agent. Deterministic (no agent involved): check
 * the template's declared requirements, install what's missing via the
 * curated registry (or the manifest's install_cmd), then hand off.
 *
 * Optional requirements that are missing never block — they're surfaced with
 * a "skip" path. Manual tools (e.g. Docker) get a guided link + re-check.
 */

import { cn } from "@herman/ui/lib/utils";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ExternalLink,
  LaptopMinimalCheck,
  Loader2,
} from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RequirementCheckResult } from "../../../shared/herman-manifest.js";
import { currentToolPlatform, getStrategy, getToolEntry } from "../../../shared/tool-registry.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useToolchainInstall } from "../lib/use-toolchain-install.js";
import { ProgressLog } from "./progress-log.js";
import { ContentWidth, SignalButton } from "./ui/index.js";

type Phase = "checking" | "ready" | "needs-install" | "installing" | "failed";

export function WizardToolSetup({
  templateId,
  onReady,
}: {
  templateId: string;
  /** All required tools present — safe to start the planning agent. */
  onReady: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [missing, setMissing] = useState<RequirementCheckResult[]>([]);
  const [optionalMissing, setOptionalMissing] = useState<RequirementCheckResult[]>([]);
  const [failNote, setFailNote] = useState<string | null>(null);
  const { state, runInstall } = useToolchainInstall();
  const startedRef = useRef(false);

  const check = useCallback(async () => {
    const { results } = await desktopRpc.request.checkTemplateRequirements({ templateId });
    const requiredMissing = results.filter((r) => !r.ok && !r.optional);
    const optMissing = results.filter((r) => !r.ok && r.optional);
    setMissing(requiredMissing);
    setOptionalMissing(optMissing);
    return requiredMissing.length === 0;
  }, [templateId]);

  // Auto-advance when nothing is missing — the step flashes by.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void check().then((allGood) => {
      if (allGood) onReady();
      else setPhase("needs-install");
    });
  }, [check, onReady]);

  const handleInstall = useCallback(async () => {
    setPhase("installing");
    setFailNote(null);

    const items = missing.map((req) => {
      const entry = getToolEntry(req.id);
      const strategy = entry ? getStrategy(entry, currentToolPlatform()) : undefined;
      // Registry strategy → registry install. Manifest install_cmd → custom
      // command. Neither (or manual strategy) → still include so the user
      // gets a clear per-tool result; the engine reports MANUAL with the URL.
      return {
        toolId: req.id,
        label: req.label,
        ...(strategy || !req.installCmd ? {} : { customCommand: req.installCmd }),
      };
    });

    const results = await runInstall(items);
    const allOk = results.every((r) => r.ok);
    const healthy = await check();
    if (allOk && healthy) {
      setPhase("ready");
      setTimeout(onReady, 800);
    } else {
      const firstError = results.find((r) => !r.ok)?.error;
      setFailNote(firstError ?? "Some tools are still missing.");
      setPhase("failed");
    }
  }, [missing, runInstall, check, onReady]);

  const manualUrl = (req: RequirementCheckResult): string | undefined => {
    const entry = getToolEntry(req.id);
    const strategy = entry ? getStrategy(entry, currentToolPlatform()) : undefined;
    if (strategy?.kind === "manual") return strategy.url;
    return req.install;
  };

  return (
    <motion.div
      key="setup"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="w-full"
    >
      <ContentWidth size="form">
        {phase === "checking" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 size={20} className="text-signal animate-spin" />
            <p className="text-dim text-sm">Checking your computer…</p>
          </div>
        )}

        {(phase === "needs-install" ||
          phase === "installing" ||
          phase === "failed" ||
          phase === "ready") && (
          <>
            <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.08] bg-white/[0.02]">
              {missing.map((req) => {
                const progress = state.tools.find((t) => t.toolId === req.id);
                const st =
                  phase === "ready"
                    ? "done"
                    : (progress?.state ?? (phase === "installing" ? "pending" : "idle"));
                const url = manualUrl(req);
                return (
                  <div key={req.id} className="flex items-start gap-3 px-4 py-3">
                    <div
                      className={cn(
                        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                        st === "done" && "bg-emerald-500/10 text-emerald-400",
                        st === "idle" && "bg-amber-500/10 text-amber-400",
                        st === "pending" && "bg-white/[0.04] text-ghost",
                        (st === "running" || st === "waiting") && "bg-signal/10 text-signal",
                        st === "failed" && "bg-red-500/10 text-red-400",
                      )}
                    >
                      {st === "done" && <Check size={14} strokeWidth={2.5} />}
                      {st === "idle" && <LaptopMinimalCheck size={14} />}
                      {st === "pending" && <span className="text-[10px]">…</span>}
                      {(st === "running" || st === "waiting") && (
                        <Loader2 size={13} className="animate-spin" />
                      )}
                      {st === "failed" && <AlertCircle size={14} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="text-text text-sm font-medium">{req.label}</span>
                      <p className="text-dim mt-0.5 text-xs leading-relaxed">
                        {req.why ?? getToolEntry(req.id)?.why ?? "Needed by this template."}
                      </p>
                      {st === "waiting" && progress?.note && (
                        <p className="mt-1 text-[11px] leading-relaxed text-amber-300">
                          {progress.note}
                        </p>
                      )}
                      {st === "failed" && (
                        <p className="mt-1 text-[11px] leading-relaxed text-red-400">
                          {progress?.note}
                          {url && (
                            <>
                              {" "}
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-signal inline-flex items-center gap-0.5 hover:underline"
                              >
                                Install manually <ExternalLink size={10} />
                              </a>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {optionalMissing.length > 0 && phase === "needs-install" && (
              <p className="text-ghost mt-3 text-[11px] leading-relaxed">
                Optional and skipped for now: {optionalMissing.map((r) => r.label).join(", ")} — you
                can add them later.
              </p>
            )}

            {phase === "installing" && state.logLines.length > 0 && (
              <ProgressLog lines={state.logLines} className="mt-4" />
            )}

            {phase === "failed" && failNote && (
              <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="leading-relaxed">{failNote}</span>
              </div>
            )}

            {phase === "ready" ? (
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
                disabled={phase === "installing"}
                onClick={handleInstall}
              >
                {phase === "installing" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Getting your computer ready…
                  </>
                ) : phase === "failed" ? (
                  "Try again"
                ) : (
                  <>
                    Install and continue
                    <ArrowRight size={14} />
                  </>
                )}
              </SignalButton>
            )}
          </>
        )}
      </ContentWidth>
    </motion.div>
  );
}
