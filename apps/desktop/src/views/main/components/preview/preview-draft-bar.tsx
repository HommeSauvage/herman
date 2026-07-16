import { Button } from "@herman/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@herman/ui/components/dialog";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

import { PreviewErrorBox } from "./preview-error-box.js";

type PreviewDraftBarProps = {
  statusCopy: string;
  isSaving: boolean;
  isSynced: boolean;
  saveDisabled: boolean;
  onDiscardClick: () => void;
  onApply: () => void;
  discardOpen: boolean;
  onDiscardOpenChange: (open: boolean) => void;
  onConfirmDiscard: () => void;
  saveError: string | null;
  onAskFixSaveError: () => void;
  askDisabled: boolean;
};

export function PreviewDraftBar({
  statusCopy,
  isSaving,
  isSynced,
  saveDisabled,
  onDiscardClick,
  onApply,
  discardOpen,
  onDiscardOpenChange,
  onConfirmDiscard,
  saveError,
  onAskFixSaveError,
  askDisabled,
}: PreviewDraftBarProps) {
  return (
    <div className="shrink-0 border-b border-mist bg-fog px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-ghost flex items-center gap-1.5 text-xs">
          {isSaving ? (
            <Loader2 size={13} className="text-signal animate-spin" />
          ) : isSynced ? (
            <CheckCircle2 size={13} className="text-signal shrink-0" aria-hidden />
          ) : (
            <AlertCircle size={13} className="text-warning shrink-0" aria-hidden />
          )}
          {statusCopy}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onDiscardClick}
            disabled={isSaving}
            className="text-ghost hover:text-dim rounded-md border border-mist px-2 py-1 text-xs disabled:opacity-50"
          >
            Discard
          </button>
          <button
            onClick={onApply}
            disabled={saveDisabled}
            className="bg-signal hover:bg-signal-dim rounded-md px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            Save to my project
          </button>
        </div>
      </div>

      {saveError && (
        <div className="mt-3">
          <PreviewErrorBox
            title="Could not save changes"
            subtitle="Your draft could not be applied to the project."
            error={saveError}
            onAsk={onAskFixSaveError}
            disabled={askDisabled}
          />
        </div>
      )}

      <Dialog open={discardOpen} onOpenChange={onDiscardOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Throw away this draft?</DialogTitle>
            <DialogDescription className="text-left leading-relaxed">
              Your real project won&apos;t change. This draft and everything you did here will be
              removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onDiscardOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={isSaving} onClick={onConfirmDiscard}>
              Throw away draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
