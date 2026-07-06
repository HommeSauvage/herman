import { FolderSearch } from "lucide-react";
import { useMemo, useState } from "react";

import type { Message } from "../../../shared/rpc.js";
import { getToolInfo } from "../lib/tool-info.js";
import { CollapsibleRow } from "./collapsible-row.js";
import { Spinner } from "./spinner.js";
import { TextShimmer } from "./text-shimmer.js";
import { ToolStatusTitle } from "./tool-status-title.js";

type ToolMessage = Extract<Message, { role: "tool" }>;

function pluralize(n: number, one: string, other: string) {
  return `${n} ${n === 1 ? one : other}`;
}

export function summarizeContextTools(tools: ToolMessage[]): string {
  const read = tools.filter((t) => t.toolName === "read").length;
  const search = tools.filter((t) => t.toolName === "glob" || t.toolName === "grep").length;
  const list = tools.filter((t) => t.toolName === "list").length;
  const parts: string[] = [];
  if (read > 0) parts.push(pluralize(read, "read", "reads"));
  if (search > 0) parts.push(pluralize(search, "search", "searches"));
  if (list > 0) parts.push(pluralize(list, "list", "lists"));
  return parts.join(" · ");
}

export function ContextToolGroup({ tools }: { tools: ToolMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const anyRunning = tools.some((t) => t.status === "running");
  const summary = useMemo(() => summarizeContextTools(tools), [tools]);

  return (
    <CollapsibleRow
      hasBody={tools.length > 0}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      trigger={
        <>
          <span className="text-faint shrink-0">
            {anyRunning ? (
              <Spinner className="text-signal size-3.5" />
            ) : (
              <FolderSearch size={14} strokeWidth={1.75} />
            )}
          </span>
          <span className="text-text shrink-0 text-sm font-medium">
            <ToolStatusTitle
              active={anyRunning}
              activeText="Gathering context"
              doneText="Gathered context"
            />
          </span>
          {anyRunning && (
            <TextShimmer
              text={summary || "reading"}
              active
              className="text-faint min-w-0 flex-1 truncate text-sm font-normal"
            />
          )}
          {!anyRunning && summary && (
            <span className="text-faint min-w-0 flex-1 truncate text-sm font-normal">
              {summary}
            </span>
          )}
        </>
      }
    >
      <div data-component="context-tool-group-list" className="pl-3.5">
        {tools.map((tool) => {
          const info = getToolInfo(tool.toolName, tool.args);
          const isRunning = tool.status === "running";
          const Icon = info.icon;
          return (
            <div
              key={tool.toolCallId}
              data-slot="context-tool-group-item"
              className="text-faint flex min-w-0 items-center gap-2 py-0.5 text-sm"
            >
              <span className="shrink-0">
                {isRunning ? (
                  <Spinner className="text-signal size-3" />
                ) : (
                  <Icon size={12} strokeWidth={1.75} />
                )}
              </span>
              <span className="text-text shrink-0 font-medium">
                {isRunning ? <TextShimmer text={info.title} active /> : info.title}
              </span>
              {info.subtitle && !isRunning && (
                <span className="text-faint min-w-0 flex-1 truncate" title={info.subtitle}>
                  {info.subtitle}
                </span>
              )}
              {isRunning && info.subtitle && (
                <TextShimmer
                  text={info.subtitle}
                  active
                  className="text-faint min-w-0 flex-1 truncate font-normal"
                />
              )}
            </div>
          );
        })}
      </div>
    </CollapsibleRow>
  );
}
