import { motion, AnimatePresence } from "motion/react";
import { Search, ArrowLeft, Sparkles, Plus, FolderOpen, Globe } from "lucide-react";
import { useMemo, useState, useCallback } from "react";

import { getProjectName, getProjectColor, getProjectInitial } from "../../../shared/tab-utils.js";
import type { PersistedSession } from "../../../shared/rpc.js";
import { openSession } from "../lib/agent-actions.js";
import { useAgentStore, useActiveTabStable } from "../lib/agent-store.js";
import { filterSessions, groupSessionsByDate } from "../lib/home-utils.js";
import { ProjectIcon } from "./project-icon.js";

type ViewState = { mode: "projects" } | { mode: "sessions"; folderPath: string };

/** Derives a stable gradient from the project path */
function projectGradient(folderPath: string): string {
  const color = getProjectColor(folderPath);
  // Each color is a hex like "#ef4444" — map to a subtle dark gradient
  const gradColors: Record<string, string> = {
    "#ef4444": "from-red-950/60 to-red-900/30",
    "#f97316": "from-orange-950/60 to-orange-900/30",
    "#eab308": "from-yellow-950/60 to-yellow-900/30",
    "#22c55e": "from-green-950/60 to-green-900/30",
    "#06b6d4": "from-cyan-950/60 to-cyan-900/30",
    "#3b82f6": "from-blue-950/60 to-blue-900/30",
    "#8b5cf6": "from-violet-950/60 to-violet-900/30",
    "#ec4899": "from-pink-950/60 to-pink-900/30",
  };
  return gradColors[color] ?? "from-neutral-950/60 to-neutral-900/30";
}

function ProjectCard({
  folderPath,
  sessionCount,
  lastUpdated,
  onClick,
}: {
  folderPath: string;
  sessionCount: number;
  lastUpdated: number;
  onClick: () => void;
}) {
  const name = getProjectName(folderPath);
  const initial = getProjectInitial(folderPath);

  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] text-left transition hover:border-white/[0.14] hover:bg-white/[0.04]"
    >
      {/* Thumbnail placeholder */}
      <div
        className={`relative flex h-36 items-center justify-center bg-gradient-to-br ${projectGradient(folderPath)}`}
      >
        {/* Decorative grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        />
        <div className="relative flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-black/40 ring-1 ring-white/[0.08] backdrop-blur-sm">
            <span className="text-2xl font-bold text-white/80">{initial}</span>
          </div>
        </div>

        {/* Hover overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
            <FolderOpen size={13} />
            Open project
          </span>
        </div>
      </div>

      {/* Info */}
      <div className="p-4">
        <div className="text-text truncate text-sm font-semibold">{name}</div>
        <div className="text-ghost mt-1 flex items-center gap-2 text-[11px]">
          <span>
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          </span>
          <span className="text-white/[0.12]">·</span>
          <span>{timeAgo(lastUpdated)}</span>
        </div>
      </div>
    </motion.button>
  );
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function SessionRow({
  session,
  isActive,
  onClick,
}: {
  session: PersistedSession;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
        isActive
          ? "text-text bg-white/[0.06]"
          : "text-dim hover:text-text hover:bg-white/[0.04]"
      }`}
    >
      <ProjectIcon folderPath={session.folderPath} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{session.title}</div>
        <div className="text-ghost mt-0.5 text-[11px]">{timeAgo(session.updatedAt)}</div>
      </div>
      {isActive && <span className="text-signal shrink-0 text-[10px] font-medium">Active</span>}
    </motion.button>
  );
}

function SessionList({
  sessions,
  folderPath,
  onBack,
}: {
  sessions: PersistedSession[];
  folderPath: string;
  onBack: () => void;
}) {
  const activeTab = useActiveTabStable();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return filterSessions(sessions, search).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, search]);

  const grouped = useMemo(() => groupSessionsByDate(filtered), [filtered]);

  function handleOpenSession(sessionId: string) {
    void openSession(sessionId);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-center border-b border-white/[0.06] px-6 py-3">
        <div className="flex w-full max-w-4xl items-center gap-3">
          <button
            onClick={onBack}
            className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/[0.04]"
          >
            <ArrowLeft size={13} />
            All projects
          </button>
          <div className="text-ghost h-4 w-px bg-white/[0.08]" />
          <div className="text-text text-sm font-semibold">{getProjectName(folderPath)}</div>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center justify-center border-b border-white/[0.06] px-6 py-3">
        <div className="bg-peak/50 flex w-full max-w-4xl items-center gap-2 rounded-lg px-3 py-1.5">
          <Search size={14} className="text-ghost shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions"
            className="text-text placeholder:text-ghost w-full bg-transparent text-sm focus:outline-none"
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex flex-1 justify-center overflow-y-auto px-6 py-4">
        <div className="w-full max-w-4xl">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="text-ghost flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.02]">
              <Search size={18} strokeWidth={1} />
            </div>
            <p className="text-dim text-sm">
              {search ? "No sessions match your search." : "No sessions in this project yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {grouped.today.length > 0 && (
              <div className="mb-4">
                <div className="text-ghost mb-1 px-3 text-[10px] font-bold tracking-[0.12em] uppercase">
                  Today
                </div>
                {grouped.today.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    isActive={s.id === activeTab?.id}
                    onClick={() => handleOpenSession(s.id)}
                  />
                ))}
              </div>
            )}
            {grouped.yesterday.length > 0 && (
              <div className="mb-4">
                <div className="text-ghost mb-1 px-3 text-[10px] font-bold tracking-[0.12em] uppercase">
                  Yesterday
                </div>
                {grouped.yesterday.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    isActive={s.id === activeTab?.id}
                    onClick={() => handleOpenSession(s.id)}
                  />
                ))}
              </div>
            )}
            {grouped.older.length > 0 && (
              <div>
                <div className="text-ghost mb-1 px-3 text-[10px] font-bold tracking-[0.12em] uppercase">
                  Older
                </div>
                {grouped.older.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    isActive={s.id === activeTab?.id}
                    onClick={() => handleOpenSession(s.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export function RookieHomeView() {
  const projects = useAgentStore((s) => s.projects);
  const sessions = useAgentStore((s) => s.sessions);
  const setOnboardingVisible = useAgentStore((s) => s.setOnboardingVisible);
  const [view, setView] = useState<ViewState>({ mode: "projects" });

  // Group sessions by project
  const projectData = useMemo(() => {
    const map = new Map<string, PersistedSession[]>();
    for (const session of sessions) {
      if (session.folderPath) {
        const existing = map.get(session.folderPath) ?? [];
        existing.push(session);
        map.set(session.folderPath, existing);
      }
    }
    return map;
  }, [sessions]);

  // Derive last updated for each project
  const projectCards = useMemo(() => {
    return [...projects]
      .map((folderPath) => {
        const projectSessions = projectData.get(folderPath) ?? [];
        const lastUpdated = projectSessions.reduce(
          (max, s) => Math.max(max, s.updatedAt),
          0,
        );
        return {
          folderPath,
          sessionCount: projectSessions.length,
          lastUpdated,
        };
      })
      .sort((a, b) => b.lastUpdated - a.lastUpdated);
  }, [projects, projectData]);

  const handleBackToProjects = useCallback(() => {
    setView({ mode: "projects" });
  }, []);

  // Session view for a specific project
  if (view.mode === "sessions") {
    const projectSessions = projectData.get(view.folderPath) ?? [];
    return (
      <SessionList
        sessions={projectSessions}
        folderPath={view.folderPath}
        onBack={handleBackToProjects}
      />
    );
  }

  // Project grid view
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-center border-b border-white/[0.06] px-6 py-4">
        <div className="flex w-full max-w-4xl items-center justify-between">
          <div>
            <h1 className="text-text text-lg font-semibold">Your projects</h1>
            <p className="text-ghost mt-0.5 text-xs">
              {projects.length === 0
                ? "Create your first project to get started"
                : `${projects.length} ${projects.length === 1 ? "project" : "projects"} · ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
            </p>
          </div>
          <button
            onClick={() => setOnboardingVisible(true)}
            className="bg-signal hover:bg-signal-dim flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_20px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_28px_rgba(34,197,94,0.28)] active:scale-[0.97]"
          >
            <Sparkles size={15} />
            New project
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 items-start justify-center overflow-y-auto p-6">
        <div className="w-full max-w-4xl">
        {projects.length === 0 ? (
          <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-4 text-center">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="bg-signal/10 text-signal flex h-20 w-20 items-center justify-center rounded-3xl">
                <Globe size={34} strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="text-text text-xl font-semibold">No projects yet</h2>
                <p className="text-dim mt-1.5 max-w-sm text-sm leading-relaxed">
                  Ready to build something? Pick a template and we&apos;ll create your first
                  project together.
                </p>
              </div>
              <button
                onClick={() => setOnboardingVisible(true)}
                className="bg-signal hover:bg-signal-dim flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_32px_rgba(34,197,94,0.28)] active:scale-[0.97]"
              >
                <Plus size={16} />
                Create your first project
              </button>
            </motion.div>
          </div>
        ) : (
          <div className="mx-auto grid max-w-3xl grid-cols-1 place-items-center gap-4 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence mode="popLayout">
              {projectCards.map((project, index) => (
                <motion.div
                  key={project.folderPath}
                  className="w-full max-w-80"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04, duration: 0.25 }}
                >
                  <ProjectCard
                    folderPath={project.folderPath}
                    sessionCount={project.sessionCount}
                    lastUpdated={project.lastUpdated}
                    onClick={() =>
                      setView({ mode: "sessions", folderPath: project.folderPath })
                    }
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
