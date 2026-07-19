import { Button } from "@herman/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@herman/ui/components/dialog";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { desktopRpc } from "../lib/desktop-rpc.js";

type UndoConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabId: string;
  messageIndex: number;
  messagePreview: string;
  onConfirm: () => void;
};

function countChangedFiles(diffSummary: string): number {
  if (!diffSummary.trim()) return 0;
  return diffSummary
    .split("\n")
    .filter((line) => line.startsWith("diff ") || line.startsWith("--- ")).length;
}

export function UndoConfirmDialog({
  open,
  onOpenChange,
  tabId,
  messageIndex,
  messagePreview,
  onConfirm,
}: UndoConfirmDialogProps) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [messageCount, setMessageCount] = useState(0);
  const [diffSummary, setDiffSummary] = useState("");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setConfirming(false);
      setMessageCount(0);
      setDiffSummary("");
      setError(undefined);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(undefined);

    void desktopRpc.request
      .previewRevertTab({ tabId, messageIndex })
      .then((preview) => {
        if (cancelled) return;
        setMessageCount(preview.messageCount);
        setDiffSummary(preview.diffSummary ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not preview this undo.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, tabId, messageIndex]);

  const fileCount = countChangedFiles(diffSummary);
  const messageLabel = messageCount === 1 ? "1 message" : `${messageCount} messages`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!confirming}>
        <DialogHeader>
          <DialogTitle>Undo from here?</DialogTitle>
          <DialogDescription className="text-left leading-relaxed">
            Herman will hide {messageLabel} after this point and roll back file changes made in this
            session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
            <p className="text-ghost mb-1 text-xs font-medium">Starting from</p>
            <p className="text-text line-clamp-2">{messagePreview}</p>
          </div>

          {loading ? (
            <div className="text-dim flex items-center gap-2 text-xs">
              <Loader2 size={14} className="animate-spin" />
              Checking which files would change…
            </div>
          ) : error ? (
            <p className="text-red-400 text-xs leading-relaxed">{error}</p>
          ) : fileCount > 0 ? (
            <p className="text-dim text-xs leading-relaxed">
              About {fileCount} {fileCount === 1 ? "file" : "files"} will be restored to an earlier
              version.
            </p>
          ) : (
            <p className="text-dim text-xs leading-relaxed">
              No file changes were detected for this undo.
            </p>
          )}

          <p className="text-faint text-xs leading-relaxed">
            This only affects this session&apos;s preview copy of your project. You can bring
            everything back with &ldquo;Keep my messages &amp; files&rdquo; until you confirm the
            undo.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={confirming}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={loading || confirming || !!error}
            onClick={() => {
              setConfirming(true);
              onConfirm();
            }}
          >
            {confirming ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Undoing…
              </>
            ) : (
              "Undo from here"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
