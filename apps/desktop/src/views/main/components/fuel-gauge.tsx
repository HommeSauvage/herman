import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";

import type { ContextStats } from "../../../shared/context-stats.js";
import {
  clampPercentage,
  formatCost,
  formatTokenCount,
} from "../../../shared/context-stats.js";

export type FuelGaugeProps = {
  stats?: ContextStats;
  onClick?: () => void;
  className?: string;
};

function percentFromStats(stats?: ContextStats): number {
  if (!stats || stats.contextLimit <= 0) return 0;
  return clampPercentage(stats.totalTokens / stats.contextLimit);
}

/**
 * A car fuel-gauge inspired token/context indicator.
 * E = empty/new session, F = full context window. The needle rises as the
 * conversation grows, and the zone near F is tinted red.
 */
export function FuelGauge({ stats, onClick, className }: FuelGaugeProps) {
  const percentage = percentFromStats(stats);
  // Map 0-100% to a needle angle sweeping from -120° (E) to +120° (F).
  const angle = -120 + (percentage / 100) * 240;
  const isHigh = percentage >= 75;
  const isCritical = percentage >= 90;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "relative flex items-center justify-center rounded-lg p-1 transition",
              "hover:bg-white/[0.06] active:scale-[0.96]",
              onClick ? "cursor-pointer" : "cursor-default",
              className,
            )}
            aria-label={`Context usage: ${percentage}%`}
          >
            <svg
              viewBox="0 0 64 44"
              className="h-7 w-10"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Outer arc: E to F, spans 240° around the pivot at (32,38) */}
              <path
                d="M 13 27 A 22 22 0 1 1 51 27"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className="text-white/[0.08]"
              />
              {/* Red warning arc near F (last ~30° of the gauge) */}
              <path
                d="M 44 25.5 A 22 22 0 0 1 51 27"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className="text-red-500/70"
              />
              {/* Tick marks at E and F */}
              <line x1="11" y1="27" x2="14" y2="27" className="text-dim" stroke="currentColor" strokeWidth="2" />
              <line x1="50" y1="27" x2="53" y2="27" className="text-dim" stroke="currentColor" strokeWidth="2" />
              {/* Needle pivot cap */}
              <circle cx="32" cy="38" r="3" className="text-text" fill="currentColor" />
              {/* Needle rotates around the pivot point */}
              <g
                className={cn(
                  "transition-transform duration-500 ease-out",
                  isCritical ? "text-red-400" : isHigh ? "text-amber-400" : "text-signal",
                )}
                style={{ transformOrigin: "32px 38px", transform: `rotate(${angle}deg)` }}
              >
                <line
                  x1="32"
                  y1="38"
                  x2="32"
                  y2="16"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </g>
            </svg>
            <span className="absolute bottom-[2px] left-1 text-[7px] font-medium text-dim">E</span>
            <span className="absolute bottom-[2px] right-1 text-[7px] font-medium text-dim">F</span>
          </button>
        }
      />
      <TooltipContent side="bottom" align="end" className="max-w-56">
        <div className="flex flex-col gap-1">
          <div className="text-text text-xs font-medium">
            Context: {percentage}% of {formatTokenCount(stats?.contextLimit ?? 0)} tokens
          </div>
          {stats ? (
            <div className="text-dim text-[10px] leading-relaxed">
              <div>
                {formatTokenCount(stats.totalTokens)} total ·{" "}
                {formatTokenCount(stats.inputTokens)} in ·{" "}
                {formatTokenCount(stats.outputTokens)} out
              </div>
              {(stats.reasoningTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) && (
                <div>
                  {stats.reasoningTokens > 0 && `${formatTokenCount(stats.reasoningTokens)} reasoning · `}
                  {stats.cacheReadTokens > 0 && `${formatTokenCount(stats.cacheReadTokens)} cache read · `}
                  {stats.cacheWriteTokens > 0 && `${formatTokenCount(stats.cacheWriteTokens)} cache write`}
                </div>
              )}
              <div>
                {stats.assistantMessageCount} assistant · {stats.userMessageCount} user ·{" "}
                {stats.toolMessageCount} tool messages
              </div>
              {stats.estimatedCost > 0 && <div>Estimated cost: {formatCost(stats.estimatedCost)}</div>}
              {stats.modelId && <div className="text-faint">Model: {stats.modelId}</div>}
            </div>
          ) : (
            <div className="text-dim text-[10px]">No context data yet.</div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
