import { useEffect, useLayoutEffect, useRef } from "react";

import { cn } from "@herman/ui/lib/utils";

import { useAutoScroll } from "../hooks/use-auto-scroll.js";

interface ProgressLogProps {
  lines: string[];
  className?: string;
}

export function ProgressLog({ lines, className }: ProgressLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useAutoScroll({ scrollRef });
  const didMountRef = useRef(false);
  const prevScrollHeightRef = useRef(0);

  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const prevScrollHeight = prevScrollHeightRef.current;
    const nextScrollHeight = el.scrollHeight;
    prevScrollHeightRef.current = nextScrollHeight;

    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    const delta = nextScrollHeight - prevScrollHeight;
    const isNearBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 2;

    if (delta > 0 && !isNearBottom) {
      el.scrollTop += delta;
    }
  }, [lines]);

  return (
    <div className={cn(lines.length === 0 && "hidden", className)}>
      <div className="bg-void w-full rounded-xl border border-white/[0.06] px-4 py-3">
        <div ref={scrollRef} className="max-h-32 space-y-1 overflow-y-auto">
          {lines.map((line, i) => (
            <div key={i} className="text-ghost text-[11px] leading-relaxed">
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
