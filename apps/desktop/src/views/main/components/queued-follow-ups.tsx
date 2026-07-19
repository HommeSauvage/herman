import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { Pencil, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { QueuedFollowUp } from "../../../shared/rpc.js";

type QueuedFollowUpsProps = {
  items: QueuedFollowUp[];
  onEdit: (item: QueuedFollowUp) => void;
  onRemove: (id: string) => void;
};

export function QueuedFollowUps({ items, onEdit, onRemove }: QueuedFollowUpsProps) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((item) => (
          <motion.div
            key={item.id}
            layout
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: -12, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className="group flex items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm"
          >
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="text-body hover:text-text min-w-0 flex-1 text-left leading-relaxed transition"
            >
              <span className="line-clamp-2">{item.text}</span>
            </button>
            <div className="mt-0.5 flex shrink-0 items-center gap-0.5 opacity-60 transition group-hover:opacity-100">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Edit"
                      onClick={() => onEdit(item)}
                      className="text-dim hover:text-text flex h-7 w-7 items-center justify-center rounded-lg transition hover:bg-white/[0.06]"
                    />
                  }
                >
                  <Pencil size={13} />
                </TooltipTrigger>
                <TooltipContent side="top">Edit</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Remove"
                      onClick={() => onRemove(item.id)}
                      className="text-dim hover:text-text flex h-7 w-7 items-center justify-center rounded-lg transition hover:bg-white/[0.06]"
                    />
                  }
                >
                  <X size={14} />
                </TooltipTrigger>
                <TooltipContent side="top">Remove</TooltipContent>
              </Tooltip>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
