import { Badge } from "@herman/ui/components/badge";
import { Separator } from "@herman/ui/components/separator";
import { cn } from "@herman/ui/lib/utils";
import { useShallow } from "zustand/react/shallow";

import { ContextPanelCard } from "./context-panel-card.js";

import {
  formatCost,
  formatTokenCount,
} from "../../../shared/context-stats.js";
import { useAgentStore } from "../lib/agent-store.js";

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-dim">{label}</span>
      <span className="text-text font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function ContextPanel() {
  const { stats, modelId, providerId } = useAgentStore(
    useShallow((s) => {
      const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
      const stats = tab?.contextStats;
      const currentModel = tab?.currentModel;
      const [providerId, modelId] = currentModel ? currentModel.split("/", 2) : [undefined, undefined];
      return {
        stats,
        modelId: modelId ?? currentModel,
        providerId,
      };
    }),
  );

  if (!stats) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="text-dim text-xs">No context data yet.</div>
        <div className="text-faint text-[10px]">
          Send a message to see token and context usage stats.
        </div>
      </div>
    );
  }

  const percentage =
    stats.contextLimit > 0
      ? Math.min(100, Math.round((stats.totalTokens / stats.contextLimit) * 100))
      : 0;
  const isHigh = percentage >= 75;
  const isCritical = percentage >= 90;

  return (
    <div className="flex h-full flex-col overflow-hidden" data-component="context-panel">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <h3 className="text-ghost text-[10px] font-bold tracking-[0.12em] uppercase">
          Context
        </h3>
        <Badge
          variant="outline"
          className={
            isCritical
              ? "border-red-500/30 text-red-400"
              : isHigh
                ? "border-amber-500/30 text-amber-400"
                : "border-signal/30 text-signal"
          }
        >
          {percentage}%
        </Badge>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <ContextPanelCard>
          <div className="text-text text-xs font-medium">
            {formatTokenCount(stats.totalTokens)} / {formatTokenCount(stats.contextLimit)} tokens
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/[0.12]">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                isCritical
                  ? "bg-red-500"
                  : isHigh
                    ? "bg-amber-500"
                    : "bg-signal",
              )}
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
          <div className="mt-2 text-faint text-[10px]">
            Estimated from the latest assistant message usage plus character-count
            heuristics for newer messages.
          </div>
        </ContextPanelCard>

        <Separator className="my-3 bg-white/[0.06]" />

        <ContextPanelCard>
          <StatRow label="Input tokens" value={formatTokenCount(stats.inputTokens)} />
          <StatRow label="Output tokens" value={formatTokenCount(stats.outputTokens)} />
          {stats.reasoningTokens > 0 && (
            <StatRow label="Reasoning" value={formatTokenCount(stats.reasoningTokens)} />
          )}
          {stats.cacheReadTokens > 0 && (
            <StatRow label="Cache read" value={formatTokenCount(stats.cacheReadTokens)} />
          )}
          {stats.cacheWriteTokens > 0 && (
            <StatRow label="Cache write" value={formatTokenCount(stats.cacheWriteTokens)} />
          )}
          <Separator className="my-1 bg-white/[0.05]" />
          <StatRow label="Estimated cost" value={formatCost(stats.estimatedCost)} />
        </ContextPanelCard>

        <Separator className="my-3 bg-white/[0.06]" />

        <ContextPanelCard>
          <StatRow label="Total messages" value={stats.messageCount} />
          <StatRow label="User messages" value={stats.userMessageCount} />
          <StatRow label="Assistant messages" value={stats.assistantMessageCount} />
          <StatRow label="Tool messages" value={stats.toolMessageCount} />
        </ContextPanelCard>

        {(modelId || providerId) && (
          <>
            <Separator className="my-3 bg-white/[0.06]" />
            <ContextPanelCard>
              {providerId && <StatRow label="Provider" value={providerId} />}
              {modelId && <StatRow label="Model" value={modelId} />}
            </ContextPanelCard>
          </>
        )}
      </div>
    </div>
  );
}
