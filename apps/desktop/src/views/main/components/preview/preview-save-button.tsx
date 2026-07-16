import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { Loader2, Save } from "lucide-react";

type PreviewSaveButtonProps = {
  show: boolean;
  isSaving: boolean;
  isSynced: boolean;
  changedFiles: number;
  disabled: boolean;
  tooltip: string;
  onSave: () => void;
};

export function PreviewSaveButton({
  show,
  isSaving,
  isSynced,
  changedFiles,
  disabled,
  tooltip,
  onSave,
}: PreviewSaveButtonProps) {
  if (!show) return null;

  const hasChanges = changedFiles > 0;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Save to project"
            onClick={onSave}
            disabled={disabled}
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-lg transition",
              isSynced || disabled
                ? "text-ghost cursor-default opacity-50"
                : "text-text hover:bg-white/4",
            )}
          />
        }
      >
        {isSaving ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Save size={14} strokeWidth={2} />
        )}
        {hasChanges && !isSaving && (
          <span className="bg-signal text-primary-foreground absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none">
            {changedFiles > 99 ? "99+" : changedFiles}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
