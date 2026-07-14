import { cn } from "@herman/ui/lib/utils";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type SignalButtonSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<SignalButtonSize, string> = {
  sm: "px-4 py-2 text-sm",
  md: "px-4 py-2.5 text-sm",
  lg: "px-6 py-3 text-sm",
};

/** Primary green CTA for Rookie / wizard. Glow uses theme CSS vars. */
export function SignalButton({
  children,
  size = "md",
  glow = false,
  fullWidth = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  size?: SignalButtonSize;
  glow?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "bg-signal hover:bg-signal-dim flex items-center justify-center gap-2 rounded-xl font-semibold text-primary-foreground transition active:scale-[0.97] disabled:opacity-40",
        SIZE_CLASS[size],
        fullWidth && "w-full",
        glow &&
          "shadow-[0_0_20px_var(--color-signal-glow-soft)] hover:shadow-[0_0_28px_var(--color-signal-glow)]",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
