import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { type ImpressionState, useImpression } from "../hooks/use-impression.js";
import { reportAdClick, reportImpression } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsHermanProvider } from "../lib/model-utils.js";

/**
 * ThinkingBanner shows an ad while the agent is thinking.
 *
 * Counting: 1s continuous visibility gate (via useImpression).
 * Rotation: the displayed campaign is driven by the agent process, which can
 * swap the banner during long thinking sessions. The React layer just renders
 * whatever campaign the store holds for the active tab.
 * Tab-aware: only tracks impressions when the app window is focused and visible.
 */
export function ThinkingBanner() {
  const { isThinking, campaign, thinkingStartedAt } = useAgentStore(
    useShallow((s) => {
      const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
      return {
        isThinking: tab?.isThinking ?? false,
        campaign: tab?.thinkingBanner,
        thinkingStartedAt: tab?.thinkingStartedAt,
      };
    }),
  );
  const isHermanProvider = useIsHermanProvider();
  const { focused, visible } = useAgentStore(useShallow((s) => s.ads));
  const [iconError, setIconError] = useState(false);

  const campaignId = campaign?.id;
  const onImpression = useCallback(
    (state: ImpressionState) => {
      if (!campaignId) return;
      void reportImpression({
        campaignId,
        placement: "thinking_banner",
        durationMs: state.elapsedMs,
        wasFocused: focused,
        wasVisible: visible,
        thinkingDurationMs: thinkingStartedAt ? Date.now() - thinkingStartedAt : undefined,
      });
    },
    [campaignId, focused, visible, thinkingStartedAt],
  );

  const { ref } = useImpression({
    enabled: isThinking && !!campaignId && focused && visible && isHermanProvider,
    onImpression,
  });

  if (!isHermanProvider) return null;

  return (
    <AnimatePresence initial={false}>
      {isThinking && campaign && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          className="border-signal/15 from-signal/8 hover:border-signal/25 hover:from-signal/12 cursor-pointer overflow-hidden rounded-2xl border bg-gradient-to-r to-transparent px-4 py-2.5 transition"
          onClick={() => void reportAdClick(campaign.id, "thinking_banner")}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {campaign.iconUrl && !iconError ? (
                <img
                  src={campaign.iconUrl}
                  alt={campaign.brandName}
                  className="h-5 w-5 rounded-md object-cover outline outline-1 outline-black/10"
                  onError={() => setIconError(true)}
                />
              ) : (
                <div className="bg-signal/10 text-signal flex h-5 w-5 items-center justify-center rounded-md text-[10px] font-bold">
                  {campaign.brandName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <span className="text-signal text-xs font-semibold">{campaign.brandName}</span>
                <span className="text-ghost mx-2">·</span>
                <span className="text-dim text-xs">{campaign.tagline}</span>
              </div>
            </div>
            <span className="text-ghost shrink-0 text-[10px]">
              {campaign.cta ?? campaign.destinationUrl}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
