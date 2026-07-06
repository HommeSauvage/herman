import { cn } from "@herman/ui/lib/utils";
import { useState } from "react";

import { getToolInfo } from "../lib/tool-info.js";
import { CollapsibleRow } from "./collapsible-row.js";
import { Spinner } from "./spinner.js";
import { TextShimmer } from "./text-shimmer.js";

export function ToolRow({
  toolName,
  args,
  status,
  output,
}: {
  toolName: string;
  args?: unknown;
  status: "running" | "done" | "error";
  output?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const info = getToolInfo(toolName, args);
  const isRunning = status === "running";
  const isError = status === "error";
  const Icon = info.icon;
  const hasOutput = !!output && output.trim().length > 0;

  return (
    <CollapsibleRow
      hasBody={hasOutput}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      trigger={
        <>
          <span className="text-faint shrink-0">
            {isRunning ? (
              <Spinner className="text-signal size-3.5" />
            ) : (
              <Icon size={14} strokeWidth={1.75} className={isError ? "text-red-400" : undefined} />
            )}
          </span>
          <span
            className={cn("shrink-0 text-sm font-medium", isError ? "text-red-400" : "text-text")}
          >
            {isRunning ? <TextShimmer text={info.title} active /> : info.title}
          </span>
          {info.subtitle && !isRunning && (
            <span className="text-faint min-w-0 flex-1 truncate text-sm" title={info.subtitle}>
              {info.subtitle}
            </span>
          )}
          {isError && (
            <span className="text-[10px] font-medium tracking-wider text-red-400/80 uppercase">
              error
            </span>
          )}
        </>
      }
    >
      <pre
        data-slot="tool-output"
        className="bg-fog border-mist text-dim mt-1 max-h-60 [scrollbar-width:none] overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap [&::-webkit-scrollbar]:hidden"
      >
        {output}
      </pre>
    </CollapsibleRow>
  );
}
