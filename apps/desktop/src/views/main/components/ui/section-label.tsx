import { cn } from "@herman/ui/lib/utils";
import type { ReactNode } from "react";

/** Uppercase section eyebrow (Today / Yesterday / Project / …). */
export function SectionLabel({
  children,
  density = "compact",
  className,
}: {
  children: ReactNode;
  density?: "compact" | "comfortable";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-ghost text-[10px] font-bold tracking-[0.12em] uppercase",
        density === "compact" ? "mb-2 px-2" : "mb-1 px-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
