import { cn } from "@herman/ui/lib/utils";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { getProjectName } from "../../../../shared/tab-utils.js";
import type { SessionLike } from "../../lib/home-utils.js";
import { ProjectIcon } from "../project-icon.js";
import { SectionLabel } from "./section-label.js";

export type SessionRowDensity = "compact" | "comfortable";

export type SessionRowProps = {
  folderPath: string;
  title: string;
  /** Optional subtitle under the title (project name, relative time, etc.). */
  subtitle?: string | null;
  isActive?: boolean;
  showActiveBadge?: boolean;
  density?: SessionRowDensity;
  onClick: () => void;
};

export function SessionRow({
  folderPath,
  title,
  subtitle,
  isActive = false,
  showActiveBadge = false,
  density = "compact",
  onClick,
}: SessionRowProps) {
  const className = cn(
    "flex w-full items-center gap-3 text-left transition",
    density === "compact" ? "rounded-lg px-2 py-2.5" : "rounded-xl px-3 py-3",
    isActive ? "text-text bg-mist" : "text-dim hover:text-text hover:bg-fog",
  );

  const body = (
    <>
      <ProjectIcon folderPath={folderPath} size="sm" />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", density === "comfortable" && "font-medium")}>
          {title}
        </div>
        {subtitle ? (
          <div
            className={cn(
              "text-ghost truncate text-[11px]",
              density === "comfortable" && "mt-0.5",
            )}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {showActiveBadge ? (
        <span
          className={cn(
            "text-signal shrink-0 text-[10px]",
            density === "comfortable" && "font-medium",
          )}
        >
          Active
        </span>
      ) : null}
    </>
  );

  if (density === "comfortable") {
    return (
      <motion.button type="button" whileTap={{ scale: 0.98 }} onClick={onClick} className={className}>
        {body}
      </motion.button>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  );
}

type DateGroupedSessions<T extends SessionLike> = {
  today: T[];
  yesterday: T[];
  older: T[];
};

/** Renders Today / Yesterday / Older sections with shared SectionLabel + rows. */
export function SessionDateGroups<T extends SessionLike>({
  grouped,
  density = "compact",
  children,
}: {
  grouped: DateGroupedSessions<T>;
  density?: SessionRowDensity;
  children: (session: T) => ReactNode;
}) {
  const sections: { title: string; items: T[] }[] = [
    { title: "Today", items: grouped.today },
    { title: "Yesterday", items: grouped.yesterday },
    { title: "Older", items: grouped.older },
  ];

  return (
    <>
      {sections.map(({ title, items }) =>
        items.length > 0 ? (
          <div key={title} className={density === "compact" ? "mb-6" : "mb-4"}>
            <SectionLabel density={density}>{title}</SectionLabel>
            {items.map((session) => (
              <div key={session.id}>{children(session)}</div>
            ))}
          </div>
        ) : null,
      )}
    </>
  );
}

/** Subtitle helpers for SessionRow call sites. */
export function sessionProjectSubtitle(folderPath: string): string {
  return getProjectName(folderPath);
}

export function formatTimeAgo(timestamp: number): string {
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
