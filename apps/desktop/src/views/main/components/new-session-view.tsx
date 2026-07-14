import { motion } from "motion/react";

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

  if (!tabId) return null;

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
        className="flex w-full flex-col items-start"
      >
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
      </motion.div>
    </div>
  );
}
