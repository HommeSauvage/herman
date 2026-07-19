import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";

import type { ContextStats } from "../../../shared/context-stats.js";
import { clampPercentage, formatCost, formatTokenCount } from "../../../shared/context-stats.js";

export type FuelGaugeProps = {
  stats?: ContextStats;
  onClick?: () => void;
  className?: string;
  isActive?: boolean;
  mode?: "rookie" | "normal";
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
export function FuelGauge({
  stats,
  onClick,
  className,
  isActive = false,
  mode = "normal",
}: FuelGaugeProps) {
  const percentage = percentFromStats(stats);
  // Map 0-100% to a needle angle sweeping from -60° (E, left / empty) to
  // +60° (F, right / full). High usage drives the needle clockwise toward
  // the red warning zone near F.
  const angle = -60 + (percentage / 100) * 120;

  // Gauge geometry. The pivot sits at the bottom center of the arc; the
  // needle length equals the arc radius so the tip always lands on the gauge.
  const cx = 32;
  const cy = 34;
  const radius = 18;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const fmt = (n: number) => Math.round(n * 10) / 10;

  const e = {
    x: cx - radius * Math.sin(toRad(60)),
    y: cy - radius * Math.cos(toRad(60)),
  };
  const f = {
    x: cx + radius * Math.sin(toRad(60)),
    y: cy - radius * Math.cos(toRad(60)),
  };
  const warningStart = {
    x: cx + radius * Math.sin(toRad(30)),
    y: cy - radius * Math.cos(toRad(30)),
  };

  const isHigh = percentage >= 75;
  const isCritical = percentage >= 90;

  const arcPath = `M ${fmt(e.x)} ${fmt(e.y)} A ${fmt(radius)} ${fmt(radius)} 0 0 1 ${fmt(f.x)} ${fmt(f.y)}`;
  const warningPath = `M ${fmt(warningStart.x)} ${fmt(warningStart.y)} A ${fmt(radius)} ${fmt(radius)} 0 0 1 ${fmt(f.x)} ${fmt(f.y)}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "relative flex items-center justify-center rounded-lg overflow-hidden transition",
              isActive
                ? "bg-white/[0.08] text-text shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                : "hover:bg-white/[0.06]",
              onClick ? "cursor-pointer" : "cursor-default",
              "active:scale-[0.96]",
              className,
            )}
            aria-label={`Context usage: ${percentage}%`}
          >
            <svg
              viewBox="0 0 64 40"
              className="h-full w-full"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              role="img"
              aria-label={`Context usage: ${percentage}%`}
            >
              <title>Context usage: {percentage}%</title>
              {/* Outer arc from E to F across the top of the gauge */}
              <path
                d={arcPath}
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className="text-white/[0.5]"
              />
              {/* Red warning arc near F (last ~30° of the gauge) */}
              <path
                d={warningPath}
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className="text-red-500/70"
              />
              {/* Needle pivot cap */}
              <circle cx={cx} cy={cy} r="2.5" className="text-text" fill="currentColor" />
              {/* Needle rotates around the pivot point */}
              <g
                className={cn(
                  "transition-transform duration-500 ease-out",
                  isCritical ? "text-red-400" : isHigh ? "text-amber-400" : "text-signal",
                )}
                style={{
                  transformOrigin: `${cx}px ${cy}px`,
                  transform: `rotate(${angle}deg)`,
                }}
              >
                <line
                  x1={cx}
                  y1={cy}
                  x2={cx}
                  y2={cy - radius}
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
          {mode === "rookie" ? (
            <div className="text-dim text-[10px] leading-relaxed">
              {percentage >= 75
                ? "Your conversation is getting full. The agent will soon compact the session to make room for more context, so you can keep working."
                : "As your conversation grows, the agent has more to keep in mind. When this gets too high, it may start to perform less well — starting a new session can help keep things running smoothly."}
            </div>
          ) : stats ? (
            <div className="text-dim text-[10px] leading-relaxed">
              <div>
                {formatTokenCount(stats.totalTokens)} total · {formatTokenCount(stats.inputTokens)}{" "}
                in · {formatTokenCount(stats.outputTokens)} out
              </div>
              {(stats.reasoningTokens > 0 ||
                stats.cacheReadTokens > 0 ||
                stats.cacheWriteTokens > 0) && (
                <div>
                  {stats.reasoningTokens > 0 &&
                    `${formatTokenCount(stats.reasoningTokens)} reasoning · `}
                  {stats.cacheReadTokens > 0 &&
                    `${formatTokenCount(stats.cacheReadTokens)} cache read · `}
                  {stats.cacheWriteTokens > 0 &&
                    `${formatTokenCount(stats.cacheWriteTokens)} cache write`}
                </div>
              )}
              <div>
                {stats.assistantMessageCount} assistant · {stats.userMessageCount} user ·{" "}
                {stats.toolMessageCount} tool messages
              </div>
              {stats.estimatedCost > 0 && (
                <div>Estimated cost: {formatCost(stats.estimatedCost)}</div>
              )}
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
