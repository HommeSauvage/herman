import { cn } from "@herman/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";

export function ToolStatusTitle({
  active,
  activeText,
  doneText,
  className,
}: {
  active: boolean;
  activeText: string;
  doneText: string;
  className?: string;
}) {
  const [width, setWidth] = useState<number | "auto">("auto");
  const measureRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    el.textContent = active ? activeText : doneText;
    const w = el.getBoundingClientRect().width;
    setWidth(Math.ceil(w));
  }, [active, activeText, doneText]);

  return (
    <span
      className={cn("relative inline-grid align-baseline", className)}
      style={{
        gridTemplateColumns: "minmax(0, 1fr)",
        width,
        transition: "width 320ms cubic-bezier(0.22, 1, 0.36, 1)",
        overflow: "hidden",
        verticalAlign: "baseline",
      }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={active ? "active" : "done"}
          initial={{ opacity: 0, y: 3, filter: "blur(0.9px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0)" }}
          exit={{ opacity: 0, y: -3, filter: "blur(0.9px)" }}
          transition={{
            opacity: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
            y: { duration: 0.19, ease: [0.22, 1, 0.36, 1] },
            filter: { duration: 0.19, ease: [0.22, 1, 0.36, 1] },
          }}
          className="col-start-1 row-start-1 whitespace-nowrap"
        >
          {active ? activeText : doneText}
        </motion.span>
      </AnimatePresence>
      <span
        ref={measureRef}
        aria-hidden
        className="invisible col-start-1 row-start-1 whitespace-nowrap"
        style={{ pointerEvents: "none" }}
      />
    </span>
  );
}
