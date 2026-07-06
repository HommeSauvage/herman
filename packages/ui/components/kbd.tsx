import { cn } from "@herman/ui/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-md border border-current/20 bg-current/10 px-1.5 font-sans text-[10px] font-medium text-current select-none",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

export { Kbd };
