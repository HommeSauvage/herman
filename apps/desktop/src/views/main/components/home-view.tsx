import { Kbd } from "@herman/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { Plus, SquarePen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { PiSessionSummary } from "../../../shared/rpc.js";
import {
  createTab,
  getAllPiSessions,
  getPiSessionsForProject,
  openPiSession,
  openProject,
  openSession,
} from "../lib/agent-actions.js";
import { useAgentStore, useActiveTabStable } from "../lib/agent-store.js";
import { getShortcutLabelForCommand } from "../lib/commands.js";
import { filterSessions, filterSessionsByProject, groupSessionsByDate } from "../lib/home-utils.js";
import {
  SearchField,
  SessionDateGroups,
  SessionRow,
  sessionProjectSubtitle,
} from "./ui/index.js";

// ── Unified display type (open tabs + native pi sessions) ────────────────────

type DisplaySession = {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: number;
  /** true if this is a currently open tab (mark with "Active" badge). */
  isOpen: boolean;
  /** Only set for native sessions without an open tab — clicking opens via openPiSession. */
  piSessionId?: string;
};

function toDisplaySession(
  session: { id: string; title: string; folderPath: string; updatedAt: number },
  isOpen: boolean,
  piSessionId?: string,
): DisplaySession {
  return {
    id: session.id,
    title: session.title,
    folderPath: session.folderPath,
    updatedAt: session.updatedAt,
    isOpen,
    piSessionId,
  };
}

function nativeToDisplay(
  s: PiSessionSummary,
  openTabId?: string,
  openPiSessionId?: string,
): DisplaySession {
  if (openPiSessionId && openTabId) {
    return toDisplaySession(
      {
        id: openTabId,
        title: s.name || s.firstMessage || "Untitled",
        folderPath: s.cwd,
        updatedAt: s.modified,
      },
      true,
    );
  }
  return toDisplaySession(
    {
      id: s.id,
      title: s.name || s.firstMessage || "Untitled",
      folderPath: s.cwd,
      updatedAt: s.modified,
    },
    false,
    s.id,
  );
}

// ── Home View ─────────────────────────────────────────────────────────────────

export function HomeView() {
  const storeSessions = useAgentStore((s) => s.sessions);
  const selectedProject = useAgentStore((s) => s.ui.selectedProject);
  const activeTab = useActiveTabStable();
  const [search, setSearch] = useState("");
  const [piSessions, setPiSessions] = useState<PiSessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = selectedProject
          ? await getPiSessionsForProject(selectedProject)
          : await getAllPiSessions().then((r) => r.sessions);
        if (!cancelled) setPiSessions(result);
      } catch {
        if (!cancelled) setPiSessions([]);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  const mergedSessions = useMemo(() => {
    const openByPiId = new Map<string, (typeof storeSessions)[number]>();
    for (const s of storeSessions) {
      if (s.piSessionId) openByPiId.set(s.piSessionId, s);
    }

    const seen = new Set<string>();
    const result: DisplaySession[] = [];

    for (const s of storeSessions) {
      const matched = !selectedProject || s.folderPath === selectedProject;
      if (!matched) continue;
      result.push(toDisplaySession(s, true));
      if (s.piSessionId) seen.add(s.piSessionId);
    }

    for (const pi of piSessions) {
      if (!pi.cwd || seen.has(pi.id)) continue;
      const matched = !selectedProject || pi.cwd === selectedProject;
      if (!matched) continue;
      seen.add(pi.id);
      result.push(nativeToDisplay(pi));
    }

    return result;
  }, [storeSessions, piSessions, selectedProject]);

  const filteredSessions = useMemo(() => {
    const byProject = filterSessionsByProject(mergedSessions, selectedProject);
    return filterSessions(byProject, search).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [mergedSessions, selectedProject, search]);

  const grouped = useMemo(() => groupSessionsByDate(filteredSessions), [filteredSessions]);
  const showProject = selectedProject === null;
  const newSessionShortcut = getShortcutLabelForCommand("tab.new");
  const allSessions = storeSessions;

  function handleNewSession() {
    void createTab(selectedProject ?? undefined);
  }

  function handleOpenSession(session: DisplaySession) {
    if (session.isOpen) {
      void openSession(session.id);
    } else if (session.piSessionId) {
      void openPiSession(session.folderPath, session.piSessionId);
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-mist px-5 py-4">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search sessions"
          density="compact"
          className="flex-1"
        />
        <button
          onClick={handleNewSession}
          disabled={!selectedProject && allSessions.length === 0}
          className="bg-peak text-text flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition hover:bg-white/[0.08] active:scale-[0.96] disabled:opacity-40"
        >
          <SquarePen size={13} />
          New session
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {filteredSessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-dim text-sm">
              {selectedProject
                ? "No sessions in this project yet."
                : search
                  ? "No sessions match your search."
                  : "No sessions yet. Open a project and start a new session."}
            </p>
            {!selectedProject && allSessions.length === 0 && (
              <button
                onClick={() => void openProject()}
                className="bg-peak text-text flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:bg-white/[0.08] active:scale-[0.96]"
              >
                Open project folder
              </button>
            )}
            {selectedProject && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={handleNewSession}
                      aria-label="New session"
                      className="bg-peak text-text flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:bg-white/[0.08] active:scale-[0.96]"
                    >
                      <Plus size={13} />
                      New session
                    </button>
                  }
                />
                <TooltipContent className="flex items-center gap-1.5">
                  New session
                  {newSessionShortcut ? <Kbd>{newSessionShortcut}</Kbd> : null}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        ) : (
          <SessionDateGroups grouped={grouped} density="compact">
            {(session) => (
              <SessionRow
                folderPath={session.folderPath}
                title={session.title}
                subtitle={showProject ? sessionProjectSubtitle(session.folderPath) : null}
                isActive={session.isOpen && session.id === activeTab?.id}
                showActiveBadge={session.isOpen}
                density="compact"
                onClick={() => handleOpenSession(session)}
              />
            )}
          </SessionDateGroups>
        )}
      </div>
    </div>
  );
}
