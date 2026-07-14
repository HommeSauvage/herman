import { cn } from "@herman/ui/lib/utils";
import { Search } from "lucide-react";
import type { ChangeEvent } from "react";

/** Peak-backed search strip used on session lists. */
export function SearchField({
  value,
  onChange,
  placeholder = "Search",
  density = "compact",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  density?: "compact" | "comfortable";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-peak/50 flex items-center gap-2 rounded-lg px-3",
        density === "compact" ? "py-2" : "py-1.5",
        className,
      )}
    >
      <Search size={14} className="text-ghost shrink-0" />
      <input
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        placeholder={placeholder}
        className="text-text placeholder:text-ghost w-full bg-transparent text-sm focus:outline-none"
      />
    </div>
  );
}
