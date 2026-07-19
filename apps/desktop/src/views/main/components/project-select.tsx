import { cn } from "@herman/ui/lib/utils";
import { Check, ChevronDown, FolderPlus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getProjectName } from "../../../shared/tab-utils.js";
import { selectTabProject, setTabFolder } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";
import { ProjectIcon } from "./project-icon.js";

type ProjectSelectProps = {
  tabId: string;
};

export function ProjectSelect({ tabId }: ProjectSelectProps) {
  const projects = useAgentStore((s) => s.projects);
  // Subscribe directly to the tab's projectRoot so this component re-renders
  // independently when it changes (even if the parent doesn't propagate).
  const currentProjectRoot = useAgentStore((s) => s.tabs[tabId]?.projectRoot ?? "");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = projects.filter((project) =>
    getProjectName(project).toLowerCase().includes(search.toLowerCase()),
  );

  const handleSelect = useCallback(
    (projectRoot: string) => {
      if (projectRoot !== currentProjectRoot) {
        // Optimistic update: immediately reflect the selection so the UI is always
        // responsive. The RPC call restarts the agent bridge with the new folder.
        useAgentStore.getState().setProjectForTab(tabId, {
          folderPath: projectRoot,
          projectRoot,
        });
        void selectTabProject(tabId, projectRoot);
      }
      setOpen(false);
      setSearch("");
    },
    [tabId, currentProjectRoot],
  );

  const handleOpenFolder = useCallback(async () => {
    setOpen(false);
    setSearch("");
    await setTabFolder(tabId);
  }, [tabId]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
      setSearch("");
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Focus search input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setActiveIndex(0);
    }
  }, [open]);

  function handleKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, filtered.length));
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      }
      case "Enter": {
        event.preventDefault();
        const selected = filtered[activeIndex];
        if (selected) handleSelect(selected);
        break;
      }
      case "Escape":
        setOpen(false);
        setSearch("");
        break;
    }
  }

  const displayName = currentProjectRoot ? getProjectName(currentProjectRoot) : "Select project";

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        className="text-dim hover:text-text flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-xs transition hover:border-white/[0.12] active:scale-[0.98]"
      >
        {currentProjectRoot ? (
          <>
            <ProjectIcon folderPath={currentProjectRoot} size="sm" />
            <span>{displayName}</span>
          </>
        ) : (
          <>
            <FolderPlus size={12} />
            <span>{displayName}</span>
          </>
        )}
        <ChevronDown
          size={12}
          className={cn("text-ghost transition-transform", open && "rotate-180")}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
            className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1a1a1e] shadow-xl shadow-black/30"
            onKeyDown={handleKeyDown}
          >
            <div className="border-b border-white/[0.06] px-3 py-2">
              <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-2.5 py-1.5">
                <Search size={13} className="text-ghost shrink-0" />
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setActiveIndex(0);
                  }}
                  placeholder="Search projects…"
                  className="text-text placeholder:text-ghost w-full bg-transparent text-xs focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <div className="text-ghost px-2 py-4 text-center text-xs">
                  {search ? "No matching projects" : "No projects yet"}
                </div>
              ) : (
                filtered.map((project, index) => (
                  <button
                    type="button"
                    key={project}
                    onClick={() => handleSelect(project)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition",
                      index === activeIndex
                        ? "text-text bg-white/[0.08]"
                        : "text-dim hover:text-text hover:bg-white/[0.04]",
                    )}
                  >
                    <ProjectIcon folderPath={project} size="sm" />
                    <span className="flex-1 truncate">{getProjectName(project)}</span>
                    {currentProjectRoot === project && (
                      <Check size={12} className="text-signal shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>

            <div className="border-t border-white/[0.06] p-1.5">
              <button
                type="button"
                onClick={handleOpenFolder}
                className="text-dim hover:text-text flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition hover:bg-white/[0.04]"
              >
                <FolderPlus size={13} />
                Open folder…
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
