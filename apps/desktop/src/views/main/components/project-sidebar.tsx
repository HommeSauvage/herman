import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@herman/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import {
  FolderPlus,
  HelpCircle,
  LayoutGrid,
  LogOut,
  MoreHorizontal,
  Plus,
  Settings,
} from "lucide-react";

import { getProjectName } from "../../../shared/tab-utils.js";
import { closeProject, createTab, signOut } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";
import { CommandButton } from "./command-button.js";
import { ProjectIcon } from "./project-icon.js";

function ProjectRow({ folderPath }: { folderPath: string }) {
  const selectedProject = useAgentStore((s) => s.ui.selectedProject);
  const view = useAgentStore((s) => s.ui.view);
  const setSelectedProject = useAgentStore((s) => s.setSelectedProject);
  const setView = useAgentStore((s) => s.setView);
  const isSelected = view === "home" && selectedProject === folderPath;

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-2 rounded-lg px-2 py-2 transition",
        isSelected ? "text-text bg-white/[0.06]" : "text-dim hover:text-text hover:bg-white/[0.04]",
      )}
    >
      <button
        onClick={() => {
          setSelectedProject(folderPath);
          setView("home");
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <ProjectIcon folderPath={folderPath} size="md" active={isSelected} />
        <span className="truncate text-sm">{getProjectName(folderPath)}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="text-faint hover:text-text rounded-md p-1 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08]"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            onClick={() => {
              void createTab(folderPath);
            }}
          >
            <Plus size={14} />
            New session
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              void closeProject(folderPath);
            }}
          >
            Close project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ProjectSidebar() {
  const projects = useAgentStore((s) => s.projects);
  const view = useAgentStore((s) => s.ui.view);
  const selectedProject = useAgentStore((s) => s.ui.selectedProject);
  const hermanEnabled = useAgentStore((s) => s.settings.providers.herman.enabled);
  const setView = useAgentStore((s) => s.setView);
  const setSelectedProject = useAgentStore((s) => s.setSelectedProject);
  const isHomeActive = view === "home" && selectedProject === null;

  return (
    <aside className="bg-surface/40 flex w-56 shrink-0 flex-col border-r border-white/[0.06]">
      <div className="flex items-center justify-between px-3 pt-4 pb-2">
        <span className="text-ghost text-[10px] font-bold tracking-[0.12em] uppercase">
          Projects
        </span>
        <CommandButton
          command="project.open"
          label="Open project folder"
          className="electrobun-webkit-app-region-no-drag text-faint hover:text-text rounded-md p-1 transition hover:bg-white/[0.06]"
        >
          <FolderPlus size={14} />
        </CommandButton>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <button
          onClick={() => {
            setSelectedProject(null);
            setView("home");
          }}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition",
            isHomeActive
              ? "text-text bg-white/[0.06]"
              : "text-dim hover:text-text hover:bg-white/[0.04]",
          )}
        >
          <LayoutGrid size={16} className="text-faint shrink-0" />
          Home
        </button>

        {projects.length === 0 ? (
          <CommandButton
            command="project.open"
            label="Open project folder"
            className="electrobun-webkit-app-region-no-drag text-dim hover:text-text w-full px-2 py-4 text-center text-xs transition"
          >
            Open a folder to add a project.
          </CommandButton>
        ) : (
          projects.map((folderPath) => <ProjectRow key={folderPath} folderPath={folderPath} />)
        )}
      </div>

      <div className="border-t border-white/[0.06] p-2">
        <button
          onClick={() => setView("settings")}
          className={cn(
            "text-dim hover:text-text flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs transition hover:bg-white/[0.04]",
            view === "settings" && "text-text bg-white/[0.06]",
          )}
        >
          <Settings size={14} />
          Settings
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label="Help (coming soon)"
                onClick={() => {}}
                className="text-dim hover:text-text flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs transition hover:bg-white/[0.04]"
              />
            }
          >
            <HelpCircle size={14} />
            Help
          </TooltipTrigger>
          <TooltipContent side="right">Help (coming soon)</TooltipContent>
        </Tooltip>
        {hermanEnabled && (
          <button
            onClick={() => void signOut()}
            className="text-dim flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs transition hover:bg-white/[0.04] hover:text-red-400"
          >
            <LogOut size={14} />
            Sign out
          </button>
        )}
      </div>
    </aside>
  );
}
