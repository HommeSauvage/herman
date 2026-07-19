import { Bug, FileSearch, FlaskConical, Sparkles, Wand2 } from "lucide-react";
import { motion } from "motion/react";
import { sendPrompt } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";

const SUGGESTIONS = [
  { label: "Refactor this function", icon: Wand2 },
  { label: "Explain this file", icon: FileSearch },
  { label: "Write a test for this module", icon: FlaskConical },
  { label: "Find and fix the bug", icon: Bug },
];

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
};

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

export function HydrationPendingState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-4">
        <div className="h-8 w-8 animate-pulse rounded-full bg-white/[0.08]" />
        <p className="text-sm text-dim">...</p>
      </div>
    </div>
  );
}

export function EmptyState() {
  const activeTabId = useAgentStore((s) => s.activeTabId);

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex max-w-md flex-col items-center"
      >
        <motion.div
          variants={item}
          className="animate-signal-pulse mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-signal/10 text-signal"
        >
          <Sparkles size={26} strokeWidth={1.5} />
        </motion.div>

        <motion.h2 variants={item} className="mb-2 text-lg font-semibold tracking-tight text-text">
          What should Herman do?
        </motion.h2>

        <motion.p variants={item} className="mb-7 max-w-xs text-sm leading-relaxed text-dim">
          Ask a question, paste code, or describe a task. Herman works in your project folder.
        </motion.p>

        <motion.div variants={item} className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              type="button"
              key={suggestion.label}
              onClick={() => activeTabId && void sendPrompt(activeTabId, suggestion.label)}
              className="group flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.04] px-3.5 py-2 text-xs text-dim transition hover:border-signal/20 hover:bg-signal/5 hover:text-text active:scale-[0.96]"
            >
              <suggestion.icon
                size={13}
                className="text-faint transition group-hover:text-signal"
              />
              {suggestion.label}
            </button>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
