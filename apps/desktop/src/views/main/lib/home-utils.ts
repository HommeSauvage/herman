import type { PersistedSession } from "../../../shared/rpc.js";
import { getProjectName } from "../../../shared/tab-utils.js";

export function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

export function startOfYesterday() {
  const today = startOfToday();
  return today - 24 * 60 * 60 * 1000;
}

export function groupSessionsByDate(sessions: PersistedSession[]) {
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

export function filterSessions(sessions: PersistedSession[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  return sessions.filter(
    (session) =>
      session.title.toLowerCase().includes(normalized) ||
      getProjectName(session.folderPath).toLowerCase().includes(normalized),
  );
}

export function filterSessionsByProject(sessions: PersistedSession[], folderPath: string | null) {
  if (!folderPath) return sessions;
  return sessions.filter((session) => session.folderPath === folderPath);
}
