import { Kbd } from "@herman/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { Plus, Search, SquarePen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { PiSessionSummary } from "../../../shared/rpc.js";
import { getProjectName } from "../../../shared/tab-utils.js";
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
import { ProjectIcon } from "./project-icon.js";

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
  return { id: session.id, title: session.title, folderPath: session.folderPath, updatedAt: session.updatedAt, isOpen, piSessionId };
}

function nativeToDisplay(s: PiSessionSummary, openTabId?: string, openPiSessionId?: string): DisplaySession {
  // If a native pi session already has an open tab, show it AS that tab (with Active badge).
  if (openPiSessionId && openTabId) {
    return toDisplaySession(
      { id: openTabId, title: s.name || s.firstMessage || "Untitled", folderPath: s.cwd, updatedAt: s.modified },
      true,
    );
  }
  return toDisplaySession(
    { id: s.id, title: s.name || s.firstMessage || "Untitled", folderPath: s.cwd, updatedAt: s.modified },
    false,
    s.id,
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="text-ghost mb-2 px-2 text-[10px] font-bold tracking-[0.12em] uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function SessionRow({
  session,
  showProject,
  isActive,
  onClick,
}: {
  session: DisplaySession;
  showProject: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition",
        isActive ? "text-text bg-white/[0.06]" : "text-dim hover:text-text hover:bg-white/[0.04]",
      )}
    >
      <ProjectIcon folderPath={session.folderPath} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{session.title}</div>
        {showProject && (
          <div className="text-ghost truncate text-[11px]">
            {getProjectName(session.folderPath)}
          </div>
        )}
      </div>
      {session.isOpen && <span className="text-signal text-[10px]">Active</span>}
    </button>
  );
}

// ── Home View ─────────────────────────────────────────────────────────────────

export function HomeView() {
  const storeSessions = useAgentStore((s) => s.sessions);
  const selectedProject = useAgentStore((s) => s.ui.selectedProject);
  const activeTab = useActiveTabStable();
  const [search, setSearch] = useState("");
  const [piSessions, setPiSessions] = useState<PiSessionSummary[]>([]);

  // Fetch native pi sessions whenever the selected project changes.
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
    return () => { cancelled = true; };
  }, [selectedProject]);

  // Merge open tabs (store.sessions) with native pi sessions.
  // - Open tabs appear first, marked Active.
  // - Native sessions without an open tab appear as past sessions.
  const mergedSessions = useMemo(() => {
    // Build a map of piSessionId → open tab's PersistedSession for lookup.
    const openByPiId = new Map<string, typeof storeSessions[number]>();
    for (const s of storeSessions) {
      if (s.piSessionId) openByPiId.set(s.piSessionId, s);
    }

    const seen = new Set<string>();
    const result: DisplaySession[] = [];

    // 1. Open tabs for the selected project (already in store.sessions).
    for (const s of storeSessions) {
      const matched = !selectedProject || s.folderPath === selectedProject;
      if (!matched) continue;
      result.push(toDisplaySession(s, true));
      if (s.piSessionId) seen.add(s.piSessionId);
    }

    // 2. Native pi sessions NOT already open as a tab.
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
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="bg-peak/50 flex flex-1 items-center gap-2 rounded-lg px-3 py-2">
          <Search size={14} className="text-ghost shrink-0" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search sessions"
            className="text-text placeholder:text-ghost w-full bg-transparent text-sm focus:outline-none"
          />
        </div>
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
          <>
            {grouped.today.length > 0 && (
              <Section title="Today">
                {grouped.today.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    showProject={showProject}
                    isActive={session.isOpen && session.id === activeTab?.id}
                    onClick={() => handleOpenSession(session)}
                  />
                ))}
              </Section>
            )}
            {grouped.yesterday.length > 0 && (
              <Section title="Yesterday">
                {grouped.yesterday.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    showProject={showProject}
                    isActive={session.isOpen && session.id === activeTab?.id}
                    onClick={() => handleOpenSession(session)}
                  />
                ))}
              </Section>
            )}
            {grouped.older.length > 0 && (
              <Section title="Older">
                {grouped.older.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    showProject={showProject}
                    isActive={session.isOpen && session.id === activeTab?.id}
                    onClick={() => handleOpenSession(session)}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
