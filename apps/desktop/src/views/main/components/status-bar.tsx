import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { useShallow } from "zustand/react/shallow";

import { useAgentStore } from "../lib/agent-store.js";
import { getToolInfo } from "../lib/tool-info.js";

type StatusInfo =
  | { kind: "tool"; toolName: string; args?: unknown }
  | { kind: "writing" }
  | { kind: "thinking" }
  | { kind: "retrying"; attempt: number }
  | { kind: "crashed" }
  | { kind: "idle" };

function formatStatusLabel(status: StatusInfo): string {
  if (status.kind === "tool") {
    return getToolInfo(status.toolName, status.args).gerund;
  }
  if (status.kind === "writing") return "Working";
  if (status.kind === "thinking") return "Thinking";
  if (status.kind === "retrying") return `Retrying (attempt ${status.attempt})`;
  if (status.kind === "crashed") return "Crashed";
  return "Idle";
}

/**
 * Derive the visible status from a snapshot of the active tab.
 * Walks the last few messages for tool/streaming state — O(1) in practice.
 */
export function deriveStatus(
  messages: {
    role: string;
    isStreaming?: boolean;
    status?: string;
    toolName?: string;
    args?: unknown;
  }[],
  isThinking: boolean,
  connectionState: string,
  connectionError?: string,
  retryState?: { attempt: number; message: string; next: number },
): StatusInfo {
  let foundStreamingAssistant = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "tool") {
      if (message.status === "running") {
        return { kind: "tool", toolName: message.toolName ?? "unknown", args: message.args };
      }
      continue;
    }
    if (message.role === "assistant" && message.isStreaming) {
      foundStreamingAssistant = true;
      continue;
    }
    if (message.role === "user") {
      break;
    }
  }

  if (foundStreamingAssistant) return { kind: "writing" };
  if (retryState) return { kind: "retrying", attempt: retryState.attempt };
  if (connectionState === "crashed" || connectionError) return { kind: "crashed" };
  if (isThinking) return { kind: "thinking" };
  return { kind: "idle" };
}

export function StatusBar() {
  const { label, isActive, isCrashed, isRetrying, currentModel, folderPath, projectRoot } =
    useAgentStore(
      useShallow((s) => {
        const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
        if (!tab) {
          return {
            label: "Idle",
            isActive: false,
            isCrashed: false,
            isRetrying: false,
            currentModel: undefined as string | undefined,
            folderPath: undefined as string | undefined,
            projectRoot: undefined as string | undefined,
          };
        }
        const status = deriveStatus(
          tab.messages,
          tab.isThinking,
          tab.connectionState,
          tab.connectionError,
          tab.retryState,
        );
        return {
          label: formatStatusLabel(status),
          isActive:
            status.kind === "tool" || status.kind === "writing" || status.kind === "thinking",
          isCrashed: status.kind === "crashed",
          isRetrying: status.kind === "retrying",
          currentModel: tab.currentModel,
          folderPath: tab.folderPath,
          projectRoot: tab.projectRoot,
        };
      }),
    );
  const setModelSelectorOpen = useAgentStore((s) => s.setModelSelectorOpen);

  const colorClass = isCrashed
    ? "text-red-400"
    : isRetrying
      ? "text-amber-400"
      : isActive
        ? "text-signal"
        : "text-faint";

  return (
    <div className="bg-void flex h-7 shrink-0 items-center justify-between border-t border-white/[0.06] px-4 text-[11px]">
      <div className={`flex min-w-0 items-center gap-1.5 font-medium ${colorClass}`}>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            isActive
              ? "bg-signal animate-pulse"
              : isCrashed
                ? "bg-red-400"
                : isRetrying
                  ? "bg-amber-400 animate-pulse"
                  : "bg-ghost"
          }`}
        />
        <span className="truncate" title={label}>
          {label}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="text-ghost truncate cursor-default">
                {projectRoot ?? "No project folder"}
              </span>
            }
          />
          <TooltipContent side="top">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{projectRoot ?? "No project folder"}</span>
              {folderPath && folderPath !== projectRoot ? (
                <span className="text-[10px] opacity-70">{folderPath}</span>
              ) : null}
            </div>
          </TooltipContent>
        </Tooltip>
        <span className="text-ghost">·</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Change model"
                onClick={() => setModelSelectorOpen(true)}
                className="text-ghost hover:text-text truncate transition"
              />
            }
          >
            {currentModel ? currentModel : "No model selected"}
          </TooltipTrigger>
          <TooltipContent side="top">Change model</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

if (import.meta.env.DEV) (StatusBar as unknown as Record<string, unknown>).whyDidYouRender = true;
