import { FileDiff as FileDiffIcon, FilePlus, FileMinus, RefreshCw, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { FileDiff as FileDiffType } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";

/** Stable empty array to avoid new references on every render. */
const EMPTY_DIFFS: readonly FileDiffType[] = Object.freeze([]);

/** Map file path to a display label (filename + directory) */
function fileDisplayInfo(path: string): { dir: string; name: string } {
  const lastSep = path.lastIndexOf("/");
  if (lastSep === -1) return { dir: "", name: path };
  return { dir: path.slice(0, lastSep) + "/", name: path.slice(lastSep + 1) };
}

function statusIcon(status: FileDiffType["status"]) {
  switch (status) {
    case "added":
      return <FilePlus size={14} className="text-emerald-400 shrink-0" />;
    case "deleted":
      return <FileMinus size={14} className="text-red-400 shrink-0" />;
    case "modified":
      return <FileDiffIcon size={14} className="text-amber-400 shrink-0" />;
  }
}

/** Color the unified diff lines */
function colorizePatch(patch: string): React.ReactNode {
  return patch.split("\n").map((line, i) => {
    let cls = "text-faint";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cls = "bg-emerald-500/10 text-emerald-300";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cls = "bg-red-500/10 text-red-300";
    } else if (line.startsWith("@@")) {
      cls = "text-signal";
    }
    return (
      <div key={i} className={cls}>
        {line || "\u00A0"}
      </div>
    );
  });
}

function FileDiffAccordion({ file }: { file: FileDiffType }) {
  const [open, setOpen] = useState(false);
  const info = fileDisplayInfo(file.path);

  return (
    <div className="border-b border-white/[0.05]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
      >
        <ChevronDown
          size={12}
          className="text-dim shrink-0 transition-transform"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        />
        {statusIcon(file.status)}
        <span className="min-w-0 flex-1 truncate text-xs">
          {info.dir && (
            <span className="text-faint">{info.dir}</span>
          )}
          <span className="text-text font-medium">{info.name}</span>
        </span>
        <span className="text-dim shrink-0 text-[10px] tabular-nums">
          <span className="text-emerald-400">+{file.additions}</span>
          {" / "}
          <span className="text-red-400">-{file.deletions}</span>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="overflow-hidden"
          >
            <div className="max-h-64 overflow-y-auto border-t border-white/[0.05]">
              <pre className="text-[11px] font-mono leading-snug whitespace-pre px-3 py-1.5">
                {colorizePatch(file.patch)}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ChangesPanel() {
  const { activeTabId, diffScope, diffFiles, diffLoading, setDiffScope, fetchDiff } =
    useAgentStore(
      useShallow((s) => ({
        activeTabId: s.activeTabId,
        diffScope: s.ui.diffScope,
        diffFiles: s.activeTabId ? (s.ui.diffFiles[s.activeTabId] ?? EMPTY_DIFFS) : EMPTY_DIFFS,
        diffLoading: s.activeTabId ? (s.ui.diffLoading[s.activeTabId] ?? false) : false,
        setDiffScope: s.setDiffScope,
        fetchDiff: s.fetchDiff,
      })),
    );

  // Fetch diffs on mount and when tab/scope changes.
  // Brief race is possible on rapid scope toggling; eventual consistency holds.
  useEffect(() => {
    if (!activeTabId) return;
    void fetchDiff(activeTabId, diffScope);
  }, [activeTabId, diffScope, fetchDiff]);

  const scopes = useMemo(
    (): Array<{ value: typeof diffScope; label: string }> => [
      { value: "last-message", label: "Last message" },
      { value: "everything", label: "Everything" },
      { value: "working-tree", label: "Working tree" },
    ],
    [],
  );

  const totalAdditions = diffFiles.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = diffFiles.reduce((sum, f) => sum + f.deletions, 0);

  // Group by directories for display (just sort by path)
  const sorted = useMemo(
    () => [...diffFiles].sort((a, b) => a.path.localeCompare(b.path)),
    [diffFiles],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" data-component="changes-panel">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <h3 className="text-ghost text-[10px] font-bold tracking-[0.12em] uppercase">
          Changed files
        </h3>
        <button
          type="button"
          onClick={() => activeTabId && fetchDiff(activeTabId, diffScope)}
          disabled={diffLoading}
          className="text-faint hover:text-text ml-auto rounded p-0.5 transition hover:bg-white/[0.06] disabled:opacity-30"
          title="Refresh"
        >
          <RefreshCw size={12} className={diffLoading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Scope toggle */}
      <div className="flex gap-0.5 border-b border-white/[0.06] p-1">
        {scopes.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setDiffScope(value)}
            className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
              diffScope === value
                ? "text-text bg-white/[0.08]"
                : "text-dim hover:text-text hover:bg-white/[0.04]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Stats bar */}
      {sorted.length > 0 && (
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-3 py-1.5">
          <span className="text-dim text-[10px] tabular-nums">
            {sorted.length} {sorted.length === 1 ? "file" : "files"}
          </span>
          <span className="text-emerald-400 text-[10px] tabular-nums">+{totalAdditions}</span>
          <span className="text-red-400 text-[10px] tabular-nums">-{totalDeletions}</span>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {diffLoading && sorted.length === 0 ? (
          <div className="text-dim flex items-center justify-center py-8 text-[10px]">
            Loading changes…
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-dim flex items-center justify-center py-8 text-[10px]">
            No changed files
          </div>
        ) : (
          sorted.map((file) => <FileDiffAccordion key={file.path} file={file} />)
        )}
      </div>
    </div>
  );
}
