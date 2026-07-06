import { cn } from "@herman/ui/lib/utils";

import { getProjectColor, getProjectInitial } from "../../../shared/tab-utils.js";

type Size = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-4 w-4 text-[10px] rounded",
  md: "h-6 w-6 text-xs rounded-md",
  lg: "h-9 w-9 text-sm rounded-lg",
};

export function ProjectIcon({
  folderPath,
  size = "md",
  active,
  className,
}: {
  folderPath: string;
  size?: Size;
  active?: boolean;
  className?: string;
}) {
  const color = getProjectColor(folderPath);
  const initial = getProjectInitial(folderPath);

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center leading-none font-semibold text-white",
        SIZE_CLASSES[size],
        className,
      )}
      style={{
        backgroundColor: color,
        boxShadow: active ? "0 0 0 2px rgba(255,255,255,0.3)" : undefined,
      }}
      aria-hidden="true"
    >
      {initial || "?"}
    </span>
  );
}
