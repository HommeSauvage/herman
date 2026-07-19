import { useCallback, useMemo, useRef, useState } from "react";

import type { AdCampaign } from "../../../shared/agent-protocol.js";
import { type ImpressionState, useImpression } from "../hooks/use-impression.js";
import { reportAdClick, reportImpression } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useIsHermanProvider } from "../lib/model-utils.js";
import { AdCard } from "./ad-card.js";

const MAX_IMPRESSIONS_PER_HOUR = 60;

const FALLBACK_ADS: AdCampaign[] = [
  {
    id: "herman-fallback-1",
    brandName: "Herman",
    tagline: "Ads keep the agent free for developers.",
    destinationUrl: "https://herman.dev",
  },
];

function useCampaigns(serverSidebarAd?: AdCampaign) {
  return useMemo(
    () => (serverSidebarAd ? [serverSidebarAd, ...FALLBACK_ADS] : FALLBACK_ADS),
    [serverSidebarAd],
  );
}

/**
 * AdSidebar shows a persistent sponsored panel when the sidebar is open.
 *
 * Counting: 1s continuous visibility gate (via useImpression).
 * Rotation: advances to the next campaign when an impression is recorded
 * (not on a timer), so each impression corresponds to a real view.
 * App-level: does NOT reset on tab switch — sidebar position persists across tabs.
 */
export function AdSidebar() {
  const sidebarOpen = useAgentStore((s) => s.ui.sidebarOpen);
  const focused = useAgentStore((s) => s.ads.focused);
  const visible = useAgentStore((s) => s.ads.visible);
  const serverSidebarAd = useAgentStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.sidebarAd : undefined,
  );
  const isHermanProvider = useIsHermanProvider();
  const campaigns = useCampaigns(serverSidebarAd);
  const [index, setIndex] = useState(0);

  const impressionsThisHour = useRef(0);
  const lastHourReset = useRef<number | null>(null);
  const canRecordImpression = useCallback(() => {
    const now = Date.now();
    if (lastHourReset.current === null || now - lastHourReset.current > 60 * 60 * 1000) {
      impressionsThisHour.current = 0;
      lastHourReset.current = now;
    }
    if (impressionsThisHour.current >= MAX_IMPRESSIONS_PER_HOUR) return false;
    impressionsThisHour.current += 1;
    return true;
  }, []);

  const campaign = campaigns[index] ?? FALLBACK_ADS[0];

  const onImpression = useCallback(
    (state: ImpressionState) => {
      if (!canRecordImpression()) return;
      void reportImpression({
        campaignId: campaign.id,
        placement: "sidebar",
        durationMs: state.visibleMs,
        wasFocused: focused,
        wasVisible: visible,
      });
      // Rotate to next campaign on successful impression
      if (campaigns.length > 1) {
        setIndex((i) => (i + 1) % campaigns.length);
      }
    },
    [campaign, focused, visible, canRecordImpression, campaigns.length],
  );

  const { ref } = useImpression({
    enabled: sidebarOpen && focused && visible && isHermanProvider,
    onImpression,
  });

  if (!isHermanProvider) return null;

  return (
    <div ref={ref} className="flex flex-col gap-2 border-b border-white/[0.06] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-ghost text-[10px] font-bold tracking-[0.12em] uppercase">
          Sponsored
        </span>
        <span className="text-ghost text-[10px]">Ads keep Herman free</span>
      </div>

      <AdCard campaign={campaign} onClick={() => void reportAdClick(campaign.id, "sidebar")} />
    </div>
  );
}
