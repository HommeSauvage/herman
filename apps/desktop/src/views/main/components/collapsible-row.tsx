import { cn } from "@herman/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

export function CollapsibleRow({
  hasBody,
  expanded,
  onToggle,
  trigger,
  children,
}: {
  hasBody: boolean;
  expanded: boolean;
  onToggle: () => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-component="collapsible-row" className="min-w-0">
      <button
        type="button"
        onClick={onToggle}
        disabled={!hasBody}
        aria-expanded={hasBody ? expanded : undefined}
        className={cn(
          "group/row flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left transition-colors",
          "disabled:cursor-default",
          hasBody && "cursor-pointer hover:bg-white/[0.03]",
        )}
      >
        {trigger}
        {hasBody && (
          <ChevronDown
            size={12}
            aria-hidden
            className={cn(
              "text-ghost ml-auto shrink-0 opacity-0 transition-[opacity,transform] duration-150",
              "group-hover/row:opacity-100",
              expanded && "rotate-180 opacity-100",
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasBody && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
