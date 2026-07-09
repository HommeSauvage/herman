import { AnimatePresence, motion } from "motion/react";

import type { PendingAttachment } from "../../../shared/rpc.js";
import { AttachmentPreview } from "./attachment-preview.js";

type AttachmentListProps = {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  /** Localized label used for the remove button's aria-label. */
  removeLabel: string;
};

/** Renders the row of attachment chips above the composer input.  Each
 *  chip animates in/out as attachments are added/removed (mirrors
 *  opencode's behaviour).  The list is wrapped in a flex-wrap row so
 *  the chips reflow gracefully when the composer is resized. */
export function AttachmentList({ attachments, onRemove, removeLabel }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      role="list"
      aria-label="Attached files"
      className="flex max-h-32 w-full flex-wrap gap-1.5 overflow-y-auto px-1 pb-1"
    >
      <AnimatePresence initial={false}>
        {attachments.map((attachment) => (
          <motion.div
            key={attachment.id}
            role="listitem"
            layout
            initial={{ opacity: 0, scale: 0.85, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: 4 }}
            transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.6 }}
          >
            <AttachmentPreview
              attachment={attachment}
              onRemove={onRemove}
              removeLabel={removeLabel}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
