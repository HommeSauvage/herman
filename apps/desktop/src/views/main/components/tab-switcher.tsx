import { cn } from "@herman/ui/lib/utils";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { activateTab } from "../lib/agent-actions.js";
import { useAgentStore, useTabSummaries } from "../lib/agent-store.js";
import { ProjectIcon } from "./project-icon.js";

export function TabSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const tabs = useTabSummaries();
  const activeTabId = useAgentStore((state) => state.activeTabId);

  useEffect(() => {
    if (selectedIndex >= tabs.length) {
      setSelectedIndex(Math.max(0, tabs.length - 1));
    }
  }, [tabs.length, selectedIndex]);

  useEffect(() => {
    if (tabs.length < 2) {
      if (isOpen) setIsOpen(false);
      return;
    }

    const activeIndex = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === activeTabId),
    );

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        setIsOpen(false);
        return;
      }

      if (event.key !== "Tab") return;
      if (!event.ctrlKey || event.metaKey || event.altKey) return;

      event.preventDefault();
      event.stopPropagation();

      setIsOpen(true);
      setSelectedIndex((current) => {
        const base = isOpen ? current : activeIndex;
        if (event.shiftKey) {
          return base <= 0 ? tabs.length - 1 : base - 1;
        }
        return base >= tabs.length - 1 ? 0 : base + 1;
      });
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (!isOpen) return;
      if (event.key !== "Control") return;

      const tab = tabs[selectedIndex];
      if (tab && tab.id !== activeTabId) {
        void activateTab(tab.id);
      }
      setIsOpen(false);
    }

    function handleBlur() {
      if (isOpen) setIsOpen(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [tabs, activeTabId, isOpen, selectedIndex]);

  if (!isOpen) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay backdrop - click/keyboard handled
    <div
      data-herman-overlay=""
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => setIsOpen(false)}
      onKeyDown={(e) => e.key === "Escape" && setIsOpen(false)}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.12 }}
        className="bg-ridge max-w-[85vw] rounded-2xl border border-white/[0.08] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex max-w-3xl flex-wrap items-stretch justify-center gap-3">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              className={cn(
                "flex w-44 items-start gap-2 rounded-xl border p-3 transition-colors",
                index === selectedIndex
                  ? "text-text border-white/[0.12] bg-white/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                  : "text-dim border-transparent bg-white/[0.03]",
              )}
            >
              <ProjectIcon folderPath={tab.folderPath} size="sm" />
              <span className="min-w-0 flex-1 text-xs font-medium break-words whitespace-normal">
                {tab.title || "New Session"}
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
