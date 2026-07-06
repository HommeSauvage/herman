import { Kbd } from "@herman/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { ArrowUp, Clock, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";

import type { TabId } from "../../../shared/rpc.js";
import { abortAgent } from "../lib/agent-actions.js";
import { useIsActiveTabWorking } from "../lib/agent-store.js";

type ComposerActionsProps = {
  tabId: TabId | undefined;
  hasText: boolean;
  queuedCount: number;
  isWorkingRef: { current: boolean };
  onQueue: () => void;
  onSteer: () => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
  onQueueFlush: (tabId: TabId) => void;
};

export function ComposerActions({
  tabId,
  hasText,
  queuedCount,
  isWorkingRef,
  onQueue,
  onSteer,
  onSubmit,
  onQueueFlush,
}: ComposerActionsProps) {
  const isWorking = useIsActiveTabWorking();
  const prevWorkingRef = useRef(isWorking);

  // Keep the parent's isWorkingRef in sync so it can be read from
  // keyboard handlers without subscribing to the store there.
  useEffect(() => {
    isWorkingRef.current = isWorking;
  }, [isWorking, isWorkingRef]);

  // Auto-flush queued messages when the agent becomes idle.
  useEffect(() => {
    if (prevWorkingRef.current && !isWorking && tabId) {
      onQueueFlush(tabId);
    }
    prevWorkingRef.current = isWorking;
  }, [isWorking, tabId, onQueueFlush]);

  // Stop button — shown when working and no text typed.
  if (isWorking && !hasText) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label="Stop"
              onClick={() => tabId && abortAgent(tabId).catch(() => {})}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/20 bg-red-500/10 text-red-400 transition hover:bg-red-500/20 active:scale-[0.96]"
            />
          }
        >
          <Square size={14} fill="currentColor" />
        </TooltipTrigger>
        <TooltipContent side="top">Stop</TooltipContent>
      </Tooltip>
    );
  }

  const showSteerMode = isWorking && hasText;

  return (
    <div className="relative flex shrink-0">
      <AnimatePresence>
        {showSteerMode && (
          <motion.div
            key="queue-button"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1, x: -48 }}
            exit={{ scale: 0.6, opacity: 0, x: 0 }}
            transition={{ type: "spring", stiffness: 450, damping: 28 }}
            className="absolute top-0 right-0"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="Queue"
                    onClick={onQueue}
                    className="text-text/60 hover:text-text relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] transition hover:border-white/[0.14] hover:bg-white/[0.08] active:scale-[0.96]"
                  />
                }
              >
                <Clock size={16} />
                {queuedCount > 0 && (
                  <span className="bg-signal absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold text-primary-foreground">
                    {queuedCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="flex items-center gap-1.5">
                  <Kbd>⌥</Kbd>
                  <Kbd>↵</Kbd> Queue after current run
                </span>
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={showSteerMode ? "Steer" : "Send"}
              onClick={() => void (showSteerMode ? onSteer() : onSubmit())}
              disabled={!hasText}
              className={cn(
                "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary-foreground transition active:scale-[0.96] disabled:opacity-40 disabled:shadow-none",
                showSteerMode
                  ? "border-signal/30 bg-signal/10 text-signal hover:bg-signal/20 border shadow-[0_0_12px_rgba(34,197,94,0.12)] hover:shadow-[0_0_20px_rgba(34,197,94,0.2)]"
                  : "bg-signal hover:bg-signal-dim shadow-[0_0_16px_rgba(34,197,94,0.22)] hover:shadow-[0_0_24px_rgba(34,197,94,0.32)]",
              )}
            />
          }
        >
          <ArrowUp size={16} />
        </TooltipTrigger>
        <TooltipContent side="top">
          {showSteerMode ? (
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> Steer conversation
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> Send prompt
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
