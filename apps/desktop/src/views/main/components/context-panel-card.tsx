import { cn } from "@herman/ui/lib/utils";

export type ContextPanelCardProps = {
  children: React.ReactNode;
  className?: string;
};

export function ContextPanelCard({ children, className }: ContextPanelCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
