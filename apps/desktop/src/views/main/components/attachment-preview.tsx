import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { File, FileCode, FileImage, FileText, X } from "lucide-react";
import { memo } from "react";

import type { PendingAttachment } from "../../../shared/rpc.js";

type AttachmentPreviewProps = {
  attachment: PendingAttachment;
  onRemove: (id: string) => void;
  removeLabel: string;
};

/** Pick a lucide icon based on the file's mime type.  Falls back to a
 *  generic `File` icon for anything we don't recognize. */
function FileIcon({ mime, className }: { mime: string; className?: string }) {
  if (mime.startsWith("image/")) {
    return <FileImage className={className} />;
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return <FileText className={className} />;
  }
  if (
    mime === "application/javascript" ||
    mime === "application/typescript" ||
    mime === "application/x-sh" ||
    mime === "application/xml"
  ) {
    return <FileCode className={className} />;
  }
  return <File className={className} />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function AttachmentPreviewImpl({ attachment, onRemove, removeLabel }: AttachmentPreviewProps) {
  const isImage = attachment.mime.startsWith("image/") && Boolean(attachment.previewDataUrl);
  const tooltipLabel = `${attachment.name} (${formatSize(attachment.size)})`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <fieldset
            aria-label={attachment.name}
            className={cn(
              "group/attachment relative flex h-9 max-w-[240px] items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] py-1.5 pr-1.5 pl-2 text-left transition",
              "hover:border-white/[0.14] hover:bg-white/[0.06]",
            )}
          />
        }
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/[0.04] text-dim">
          {isImage ? (
            <img
              src={attachment.previewDataUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <FileIcon mime={attachment.mime} className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-text truncate text-xs font-medium">{attachment.name}</div>
          <div className="text-faint truncate text-[10px] leading-tight">
            {formatSize(attachment.size)}
          </div>
        </div>
        <button
          type="button"
          aria-label={removeLabel}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove(attachment.id);
          }}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-dim transition",
            "hover:bg-white/[0.08] hover:text-text",
            "opacity-0 group-hover/attachment:opacity-100 focus-visible:opacity-100",
          )}
        >
          <X size={12} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
}

export const AttachmentPreview = memo(AttachmentPreviewImpl);
