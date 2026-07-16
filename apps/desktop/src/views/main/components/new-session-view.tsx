import { motion } from "motion/react";
import { Loader2 } from "lucide-react";

import { useAgentStore } from "../lib/agent-store.js";
import { Composer } from "./composer.js";
import { ErrorBoundary } from "./error-boundary.js";
import { ProjectSelect } from "./project-select.js";
import { SectionLabel } from "./ui/index.js";

export function NewSessionView() {
  const tabId = useAgentStore((s) => s.activeTabId);
  const isThinking = useAgentStore((s) =>
    s.activeTabId ? (s.tabs[s.activeTabId]?.isThinking ?? false) : false,
  );
  const worktreeStatus = useAgentStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.worktreeStatus : undefined,
  );
  const worktreeError = useAgentStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.connectionError : undefined,
  );

  if (!tabId) return null;

  const isPreparing = worktreeStatus === "pending";
  const hasWorktreeError = worktreeStatus === "error";

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
        className="flex w-full flex-col items-start"
      >
        {isPreparing ? (
          <div className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 py-4">
            <Loader2 size={18} className="text-signal animate-spin shrink-0" />
            <div>
              <p className="text-text text-sm font-medium">Preparing your session…</p>
              <p className="text-ghost mt-0.5 text-xs">
                Setting up an isolated workspace for your changes.
              </p>
            </div>
          </div>
        ) : hasWorktreeError ? (
          <div className="flex w-full flex-col gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-5 py-4">
            <p className="text-text text-sm font-medium">Failed to prepare session</p>
            <p className="text-dim text-xs">{worktreeError ?? "An unexpected error occurred."}</p>
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
