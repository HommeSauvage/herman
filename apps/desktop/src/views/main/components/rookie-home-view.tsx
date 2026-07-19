import { ArrowLeft, FolderOpen, Globe, Plus, Search, Sparkles, SquarePen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useState } from "react";
import type { PersistedSession } from "../../../shared/rpc.js";
import { getProjectColor, getProjectInitial, getProjectName } from "../../../shared/tab-utils.js";
import { createTab, openSession } from "../lib/agent-actions.js";
import { useActiveTabStable, useAgentStore } from "../lib/agent-store.js";
import { filterSessions, groupSessionsByDate } from "../lib/home-utils.js";
import {
  ContentWidth,
  formatTimeAgo,
  SearchField,
  SessionDateGroups,
  SessionRow,
  SignalButton,
} from "./ui/index.js";

type ViewState = { mode: "projects" } | { mode: "sessions"; projectRoot: string };

/** Derives a stable gradient from the project path */
function projectGradient(folderPath: string): string {
  const color = getProjectColor(folderPath);
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
  projectRoot,
  sessionCount,
  lastUpdated,
  onClick,
}: {
  projectRoot: string;
  sessionCount: number;
  lastUpdated: number;
  onClick: () => void;
}) {
  const name = getProjectName(projectRoot);
  const initial = getProjectInitial(projectRoot);

  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="group relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-mist bg-white/[0.02] text-left transition hover:border-white/[0.14] hover:bg-fog"
    >
      <div
        className={`relative flex h-36 items-center justify-center bg-gradient-to-br ${projectGradient(projectRoot)}`}
      >
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

        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
            <FolderOpen size={13} />
            Open project
          </span>
        </div>
      </div>

      <div className="w-full min-w-0 p-4">
        <div className="text-text truncate text-sm font-semibold">{name}</div>
        <div className="text-ghost mt-1 flex items-center gap-2 text-[11px]">
          <span>
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          </span>
          <span className="text-white/[0.12]">·</span>
          <span>{formatTimeAgo(lastUpdated)}</span>
        </div>
      </div>
    </motion.button>
  );
}

function SessionList({
  sessions,
  projectRoot,
  onBack,
}: {
  sessions: PersistedSession[];
  projectRoot: string;
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
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="border-b border-mist px-6 py-3">
        <ContentWidth size="page" className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-fog"
          >
            <ArrowLeft size={13} />
            All projects
          </button>
          <div className="text-ghost h-4 w-px bg-white/[0.08]" />
          <div className="text-text min-w-0 flex-1 truncate text-sm font-semibold">
            {getProjectName(projectRoot)}
          </div>
          <button
            type="button"
            onClick={() => void createTab(projectRoot)}
            className="bg-peak text-text flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition hover:bg-white/[0.08] active:scale-[0.96]"
          >
            <SquarePen size={13} />
            New session
          </button>
        </ContentWidth>
      </div>

      <div className="border-b border-mist px-6 py-3">
        <ContentWidth size="page">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search sessions"
            density="comfortable"
          />
        </ContentWidth>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <ContentWidth size="page">
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
            <SessionDateGroups grouped={grouped} density="comfortable">
              {(s) => (
                <SessionRow
                  folderPath={s.folderPath}
                  title={s.title}
                  subtitle={formatTimeAgo(s.updatedAt)}
                  isActive={s.id === activeTab?.id}
                  showActiveBadge={s.id === activeTab?.id}
                  density="comfortable"
                  onClick={() => handleOpenSession(s.id)}
                />
              )}
            </SessionDateGroups>
          )}
        </ContentWidth>
      </div>
    </div>
  );
}

export function RookieHomeView() {
  const projects = useAgentStore((s) => s.projects);
  const sessions = useAgentStore((s) => s.sessions);
  const setOnboardingVisible = useAgentStore((s) => s.setOnboardingVisible);
  const [view, setView] = useState<ViewState>({ mode: "projects" });

  const projectData = useMemo(() => {
    const map = new Map<string, PersistedSession[]>();
    for (const session of sessions) {
      if (session.projectRoot) {
        const existing = map.get(session.projectRoot) ?? [];
        existing.push(session);
        map.set(session.projectRoot, existing);
      }
    }
    return map;
  }, [sessions]);

  const projectCards = useMemo(() => {
    return [...projects]
      .map((projectRoot) => {
        const projectSessions = projectData.get(projectRoot) ?? [];
        const lastUpdated = projectSessions.reduce((max, s) => Math.max(max, s.updatedAt), 0);
        return {
          projectRoot,
          sessionCount: projectSessions.length,
          lastUpdated,
        };
      })
      .sort((a, b) => b.lastUpdated - a.lastUpdated);
  }, [projects, projectData]);

  const handleBackToProjects = useCallback(() => {
    setView({ mode: "projects" });
  }, []);

  if (view.mode === "sessions") {
    const projectSessions = projectData.get(view.projectRoot) ?? [];
    return (
      <SessionList
        sessions={projectSessions}
        projectRoot={view.projectRoot}
        onBack={handleBackToProjects}
      />
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="border-b border-mist px-6 py-4">
        <ContentWidth size="page" className="flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-text text-lg font-semibold">Your projects</h1>
            <p className="text-ghost mt-0.5 text-xs">
              {projects.length === 0
                ? "Create your first project to get started"
                : `${projects.length} ${projects.length === 1 ? "project" : "projects"} · ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
            </p>
          </div>
          <SignalButton
            size="md"
            glow
            className="shrink-0"
            onClick={() => setOnboardingVisible(true)}
          >
            <Sparkles size={15} />
            New project
          </SignalButton>
        </ContentWidth>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <ContentWidth size="page">
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
                <SignalButton size="lg" glow onClick={() => setOnboardingVisible(true)}>
                  <Plus size={16} />
                  Create your first project
                </SignalButton>
              </motion.div>
            </div>
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <AnimatePresence>
                {projectCards.map((project, index) => (
                  <motion.div
                    key={project.projectRoot}
                    className="min-w-0 w-full"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.04, duration: 0.25 }}
                  >
                    <ProjectCard
                      projectRoot={project.projectRoot}
                      sessionCount={project.sessionCount}
                      lastUpdated={project.lastUpdated}
                      onClick={() =>
                        setView({ mode: "sessions", projectRoot: project.projectRoot })
                      }
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </ContentWidth>
      </div>
    </div>
  );
}
