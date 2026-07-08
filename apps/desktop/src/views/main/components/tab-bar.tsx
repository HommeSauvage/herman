import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { LayoutGrid, Plus, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { closeTab, activateTab } from "../lib/agent-actions.js";
import { useAgentStore, useTabSummaries } from "../lib/agent-store.js";
import { getShortcutLabelForCommand, type CommandId } from "../lib/commands.js";
import { CommandButton } from "./command-button.js";
import { FuelGauge } from "./fuel-gauge.js";
import { ProjectIcon } from "./project-icon.js";

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function tabActivationCommand(index: number): CommandId | null {
  if (index < 0 || index > 8) return null;
  return `tab.activate.${index + 1}` as CommandId;
}

function shortcutLabel(index: number): string | null {
  const command = tabActivationCommand(index);
  return command ? getShortcutLabelForCommand(command) : null;
}

function HomeButton() {
  const view = useAgentStore((s) => s.ui.view);
  const isActive = view === "home";

  return (
    <CommandButton
      command="view.home"
      label="Home"
      className={cn(
        "electrobun-webkit-app-region-no-drag rounded-lg p-1.5 transition active:scale-[0.96]",
        isActive
          ? "text-text bg-white/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
          : "text-faint hover:text-text hover:bg-white/[0.06]",
      )}
    >
      <LayoutGrid size={15} />
    </CommandButton>
  );
}

function NewTabButton() {
  return (
    <CommandButton
      command="tab.new"
      label="New tab"
      className="text-faint hover:text-text rounded-lg p-1.5 transition hover:bg-white/[0.06] active:scale-[0.96]"
    >
      <Plus size={15} />
    </CommandButton>
  );
}

function SidebarToggle() {
  const sidebarOpen = useAgentStore((s) => s.ui.sidebarOpen);
  const view = useAgentStore((s) => s.ui.view);
  const hermanEnabled = useAgentStore((s) => s.settings.providers.herman.enabled);
  const mode = useAgentStore((s) => s.settings.mode);

  // Rookie mode has no sidebar — only the preview pane.
  if (view !== "session" || !hermanEnabled || mode === "rookie") return null;

  return (
    <CommandButton
      command="sidebar.toggle"
      label="Toggle sidebar"
      className="text-faint hover:text-text rounded-lg p-1.5 transition hover:bg-white/[0.06] active:scale-[0.96]"
    >
      {sidebarOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
    </CommandButton>
  );
}

function ContextUsageGauge() {
  const activeTabId = useAgentStore((s) => s.activeTabId);
  const stats = useAgentStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.contextStats : undefined,
  );
  const sidebarOpen = useAgentStore((s) => s.ui.sidebarOpen);
  const setSidebarTab = useAgentStore((s) => s.setSidebarTab);
  const toggleSidebar = useAgentStore((s) => s.toggleSidebar);
  const view = useAgentStore((s) => s.ui.view);
  const hermanEnabled = useAgentStore((s) => s.settings.providers.herman.enabled);
  const mode = useAgentStore((s) => s.settings.mode);

  // Only show in normal-mode sessions where the right sidebar exists.
  if (view !== "session" || !hermanEnabled || mode === "rookie") return null;

  const handleClick = () => {
    if (!activeTabId) return;
    if (!sidebarOpen) {
      toggleSidebar();
    }
    setSidebarTab("context");
  };

  return <FuelGauge stats={stats} onClick={handleClick} />;
}

function TabItem({
  tab,
  index,
  isActive,
  showShortcuts,
}: {
  tab: { id: string; title: string; folderPath: string };
  index: number;
  isActive: boolean;
  showShortcuts: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const title = tab.title || "New Session";

  return (
    <motion.div
      role="tab"
      tabIndex={0}
      layout="position"
      initial={reducedMotion ? undefined : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? undefined : { opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: 0.2,
              delay: index * 0.03,
              ease: [0.2, 0, 0, 1] as const,
              layout: { duration: 0.2, ease: [0.2, 0, 0, 1] as const },
            }
      }
      data-active-tab={isActive}
      onClick={() => activateTab(tab.id).catch(() => {})}
      className={cn(
        "group electrobun-webkit-app-region-no-drag relative flex h-8 w-40 max-w-[200px] flex-shrink-0 cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
        isActive
          ? "text-text bg-white/[0.08] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
          : "text-dim hover:text-text hover:bg-white/[0.04]",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <ProjectIcon folderPath={tab.folderPath} size="sm" />
              <span className="flex-1 truncate text-left">{title}</span>
              {showShortcuts && (
                <span
                  className={cn(
                    "text-ghost text-[10px] transition-opacity",
                    isActive ? "opacity-60" : "opacity-0 group-hover:opacity-60",
                  )}
                >
                  {shortcutLabel(index)}
                </span>
              )}
            </div>
          }
        />
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{title}</span>
            {tab.folderPath ? (
              <span className="text-[10px] opacity-70">{tab.folderPath}</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id).catch(() => {});
              }}
              className="text-faint hover:text-text rounded-md p-0.5 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08]"
              aria-label="Close tab"
            />
          }
        >
          <X size={12} />
        </TooltipTrigger>
        <TooltipContent side="top">Close tab</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

export function TabBar() {
  const tabs = useTabSummaries();
  const activeTabId = useAgentStore((s) => s.activeTabId);
  const view = useAgentStore((s) => s.ui.view);
  const leftInset = isMac ? "pl-20" : "pl-4";
  const showShortcuts = tabs.length > 1;
  const showActiveTab = view === "session";
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view !== "session") return;
    const list = tabListRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>("[data-active-tab='true']");
    if (active) {
      active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
    }
  }, [activeTabId, tabs.length, view]);

  return (
    <div className="bg-ridge electrobun-webkit-app-region-drag relative flex h-11 shrink-0 items-center border-b border-white/[0.06]">
      <div className={cn("flex h-full shrink-0 items-center gap-2", leftInset)}>
        <HomeButton />
      </div>

      <motion.div
        ref={tabListRef}
        layoutScroll
        className="electrobun-webkit-app-region-no-drag hide-scrollbar flex h-full flex-1 items-center gap-1 overflow-x-auto px-1"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {tabs.map((tab, index) => (
            <TabItem
              key={tab.id}
              tab={{
                id: tab.id,
                title: tab.title,
                folderPath: tab.folderPath,
              }}
              index={index}
              isActive={showActiveTab && tab.id === activeTabId}
              showShortcuts={showShortcuts}
            />
          ))}
        </AnimatePresence>

        <motion.div
          layout
          transition={{ layout: { duration: 0.2, ease: [0.2, 0, 0, 1] as const } }}
          className="bg-ridge before:from-ridge relative sticky right-0 z-10 flex h-full shrink-0 items-center pl-1 before:absolute before:inset-y-0 before:left-0 before:-ml-2 before:w-2 before:bg-gradient-to-r before:to-transparent"
        >
          <NewTabButton />
        </motion.div>
      </motion.div>

      <div className="electrobun-webkit-app-region-no-drag flex h-full shrink-0 items-center gap-1 pr-3">
        <ContextUsageGauge />
        <SidebarToggle />
      </div>
    </div>
  );
}
