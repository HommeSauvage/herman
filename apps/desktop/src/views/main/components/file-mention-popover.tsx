import { cn } from "@herman/ui/lib/utils";
import { FileText, Folder } from "lucide-react";

import { Spinner } from "./spinner.js";

export type FileMentionPopoverProps = {
  open: boolean;
  folderPath: string | undefined;
  items: string[];
  activeIndex: number;
  loading: boolean;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
};

function splitPath(filePath: string): {
  directory: string;
  filename: string;
  isDirectory: boolean;
} {
  const isDirectory = filePath.endsWith("/");
  if (isDirectory) {
    return { directory: filePath, filename: "", isDirectory: true };
  }

  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) {
    return { directory: "", filename: filePath, isDirectory: false };
  }

  return {
    directory: filePath.slice(0, lastSlash + 1),
    filename: filePath.slice(lastSlash + 1),
    isDirectory: false,
  };
}

export function FileMentionPopover({
  open,
  folderPath,
  items,
  activeIndex,
  loading,
  onSelect,
  onHover,
}: FileMentionPopoverProps) {
  if (!open) return null;

  const visible = items.slice(0, 10);
  const hasProject = Boolean(folderPath);
  const showNoProject = !loading && !hasProject;
  const showEmpty = !loading && hasProject && visible.length === 0;

  return (
    <div
      className="bg-surface absolute inset-x-0 bottom-full z-20 mb-2 max-h-80 overflow-y-auto rounded-xl border border-white/[0.06] p-1.5 shadow-2xl"
      onMouseDown={(event) => event.preventDefault()}
    >
      {loading && visible.length === 0 && (
        <div className="text-dim flex items-center justify-center gap-2 px-3 py-4 text-xs">
          <Spinner className="size-3.5" />
          Searching files…
        </div>
      )}

      {showNoProject && (
        <div className="text-dim px-3 py-4 text-center text-xs">
          Select a project folder to @mention files.
        </div>
      )}

      {showEmpty && (
        <div className="text-dim px-3 py-4 text-center text-xs">No files match your search.</div>
      )}

      {visible.map((filePath, index) => {
        const { directory, filename, isDirectory } = splitPath(filePath);
        const isActive = index === activeIndex;

        return (
          <button
            key={filePath}
            type="button"
            data-active={isActive ? "" : undefined}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition",
              isActive
                ? "text-text bg-white/[0.06]"
                : "text-dim hover:text-text hover:bg-white/[0.04]",
            )}
            onClick={() => onSelect(filePath)}
            onMouseMove={() => onHover(index)}
          >
            {isDirectory ? (
              <Folder size={14} className="text-faint shrink-0" />
            ) : (
              <FileText size={14} className="text-faint shrink-0" />
            )}
            <div className="min-w-0 flex-1 truncate">
              <span className="text-ghost truncate">{directory}</span>
              {!isDirectory && <span className="text-text truncate">{filename}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
