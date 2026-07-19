import { getProjectName } from "../../../shared/tab-utils.js";

/** Minimal shape needed for session filtering/grouping (open tabs + native sessions). */
export type SessionLike = {
  id: string;
  title: string;
  folderPath: string;
  projectRoot: string;
  updatedAt: number;
};

export function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

export function startOfYesterday() {
  const today = startOfToday();
  return today - 24 * 60 * 60 * 1000;
}

export function groupSessionsByDate<T extends SessionLike>(sessions: T[]) {
  const todayThreshold = startOfToday();
  const yesterdayThreshold = startOfYesterday();
  return {
    today: sessions.filter((session) => session.updatedAt >= todayThreshold),
    yesterday: sessions.filter(
      (session) => session.updatedAt >= yesterdayThreshold && session.updatedAt < todayThreshold,
    ),
    older: sessions.filter((session) => session.updatedAt < yesterdayThreshold),
  };
}

export function filterSessions<T extends SessionLike>(sessions: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  return sessions.filter(
    (session) =>
      session.title.toLowerCase().includes(normalized) ||
      getProjectName(session.projectRoot ?? session.folderPath)
        .toLowerCase()
        .includes(normalized),
  );
}

export function filterSessionsByProject<T extends SessionLike>(
  sessions: T[],
  projectRoot: string | null,
): T[] {
  if (!projectRoot) return sessions;
  return sessions.filter((session) => session.projectRoot === projectRoot);
}
