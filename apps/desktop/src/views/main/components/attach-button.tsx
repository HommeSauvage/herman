import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { Paperclip } from "lucide-react";

type AttachButtonProps = {
  onAttach: () => void;
  /** Localized tooltip + aria-label. */
  label: string;
  /** Optional localized suffix shown in the tooltip (e.g. a keybind hint). */
  hint?: string;
  disabled?: boolean;
};

/** Paperclip button rendered on the left of the composer input.  Clicking
 *  it opens the native file dialog so the user can pick one or more
 *  files to attach.  The button mirrors the size and style of the
 *  queue/send buttons on the right so the two sides feel balanced. */
export function AttachButton({ onAttach, label, hint, disabled }: AttachButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onAttach}
            className="text-text/60 hover:text-text flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] transition hover:border-white/[0.14] hover:bg-white/[0.08] active:scale-[0.96] disabled:opacity-40"
          />
        }
      >
        <Paperclip size={16} />
      </TooltipTrigger>
      <TooltipContent side="top">
        {hint ? (
          <span className="flex items-center gap-1.5">
            {label}
            <span className="text-dim">{hint}</span>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  );
}
