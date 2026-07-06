import { useEffect, useState } from "react";

const SWAP_MS = 220;

export function TextShimmer({
  text,
  active = true,
  offset = 0,
  className,
}: {
  text: string;
  active?: boolean;
  offset?: number;
  className?: string;
}) {
  const [run, setRun] = useState(active);

  useEffect(() => {
    if (active) {
      setRun(true);
      return;
    }
    const t = setTimeout(() => setRun(false), SWAP_MS);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <span
      data-component="text-shimmer"
      data-active={active ? "true" : "false"}
      className={className}
      aria-label={text}
      style={
        {
          ["--text-shimmer-swap" as string]: `${SWAP_MS}ms`,
          ["--text-shimmer-index" as string]: `${offset}`,
        } as React.CSSProperties
      }
    >
      <span data-slot="text-shimmer-char">
        <span data-slot="text-shimmer-char-base" aria-hidden>
          {text}
        </span>
        <span data-slot="text-shimmer-char-shimmer" data-run={run ? "true" : "false"} aria-hidden>
          {text}
        </span>
      </span>
    </span>
  );
}
