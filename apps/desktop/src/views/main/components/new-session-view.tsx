import { AlertTriangle, CheckCircle2, Circle, Loader2, Wrench } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import type { SessionSetupStepSnapshot } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { Composer } from "./composer.js";
import { ErrorBoundary } from "./error-boundary.js";
import { ProjectSelect } from "./project-select.js";
import { SectionLabel } from "./ui/index.js";

function SetupStepRow({ step }: { step: SessionSetupStepSnapshot }) {
  return (
    <li className="flex items-center gap-2.5 text-xs">
      {step.status === "running" ? (
        <Loader2 size={13} className="text-signal animate-spin shrink-0" />
      ) : step.status === "done" || step.status === "skipped" ? (
        <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
      ) : step.status === "warning" ? (
        <AlertTriangle size={13} className="text-amber-400 shrink-0" />
      ) : step.status === "failed" ? (
        <AlertTriangle size={13} className="text-red-400 shrink-0" />
      ) : (
        <Circle size={13} className="text-ghost shrink-0" />
      )}
      <span
        className={
          step.status === "running"
            ? "text-text"
            : step.status === "pending"
              ? "text-ghost"
              : step.status === "warning"
                ? "text-amber-200/80"
                : step.status === "failed"
                  ? "text-red-300"
                  : "text-dim"
        }
      >
        {step.label}
      </span>
    </li>
  );
}

export function NewSessionView() {
  const tabId = useAgentStore((s) => s.activeTabId);
  const isThinking = useAgentStore((s) =>
    s.activeTabId ? (s.tabs[s.activeTabId]?.isThinking ?? false) : false,
  );
  const setup = useAgentStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.setup : undefined));
  const [retrying, setRetrying] = useState(false);

  if (!tabId) return null;

  const phase = setup?.phase ?? "none";
  const isPreparing = phase === "pending";
  const hasSetupError = phase === "error";
  const steps = setup?.phase === "pending" ? setup.steps : undefined;
  const setupError = setup?.phase === "error" ? setup.error : undefined;
  const setupOutput = setup?.phase === "error" ? setup.output : undefined;
  const setupRetryable = setup?.phase === "error" ? setup.retryable : false;
  // The agent still starts on a retryable setup failure (it shares the
  // workspace and is the best fixer) — offer the composer when one exists.
  const hasWorkspace = useAgentStore((s) =>
    s.activeTabId ? Boolean(s.tabs[s.activeTabId]?.worktree) : false,
  );

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await desktopRpc.request.retrySessionSetup({ tabId });
    } finally {
      setRetrying(false);
    }
  };

  const handleAskHerman = () => {
    const promptText = [
      "Setting up my workspace failed with this error:",
      "",
      setupError ?? "Unknown error",
      ...(setupOutput ? ["", "Output:", setupOutput.slice(-2000)] : []),
      "",
      'Please investigate and fix the project setup so it can complete. The full setup logs are available via the preview logs tool (serverId: "setup").',
    ].join("\n");
    useAgentStore.getState().setComposerValue(tabId, promptText);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
        className="flex w-full flex-col items-start"
      >
        {isPreparing ? (
          <div className="flex w-full flex-col gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 py-4">
            <div className="flex items-center gap-3">
              <Loader2 size={18} className="text-signal animate-spin shrink-0" />
              <div>
                <p className="text-text text-sm font-medium">
                  {setup?.phase === "pending" && setup.label
                    ? setup.label
                    : "Preparing your session…"}
                </p>
                <p className="text-ghost mt-0.5 text-xs">
                  Setting up an isolated workspace for your changes.
                </p>
              </div>
            </div>
            {steps && steps.length > 0 && (
              <ul className="flex flex-col gap-1.5 border-t border-white/[0.06] pt-3">
                {steps.map((step) => (
                  <SetupStepRow key={step.id} step={step} />
                ))}
              </ul>
            )}
          </div>
        ) : hasSetupError ? (
          <div className="flex w-full flex-col gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-5 py-4">
            <p className="text-text text-sm font-medium">Failed to prepare your session</p>
            <p className="text-dim text-xs">{setupError ?? "An unexpected error occurred."}</p>
            {setupOutput && (
              <pre className="text-ghost max-h-32 overflow-auto rounded-lg bg-black/30 p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                {setupOutput.slice(-2000)}
              </pre>
            )}
            <div className="flex items-center gap-2 pt-1">
              {setupRetryable && (
                <button
                  type="button"
                  onClick={() => void handleRetry()}
                  disabled={retrying}
                  className="bg-signal/90 hover:bg-signal text-void flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
                >
                  {retrying ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                  Retry setup
                </button>
              )}
              {hasWorkspace && (
                <button
                  type="button"
                  onClick={handleAskHerman}
                  className="text-dim hover:text-text flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs transition hover:bg-white/[0.04]"
                >
                  Ask Herman to fix
                </button>
              )}
            </div>
            {hasWorkspace && (
              <div className="border-t border-white/[0.06] pt-3">
                <ErrorBoundary>
                  <Composer key={tabId} />
                </ErrorBoundary>
              </div>
            )}
          </div>
        ) : (
          <>
            <ErrorBoundary>
              <Composer key={tabId} />
            </ErrorBoundary>

            {!isThinking && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.1, ease: [0.2, 0, 0, 1] }}
                className="mt-4 flex items-center gap-2"
              >
                <SectionLabel className="mb-0 px-0">Project</SectionLabel>
                <ProjectSelect tabId={tabId} />
              </motion.div>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}
