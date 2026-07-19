import { useCallback, useEffect, useRef } from "react";

import type { AdCampaign } from "../../../shared/agent-protocol.js";
import { reportAdClick, reportImpression } from "../lib/agent-actions.js";
import { useAgentStore } from "../lib/agent-store.js";

const reportedImpressions = new Set<string>();

const IMPRESSION_GATE_MS = 1000;

/**
 * NativeAdMessage renders an in-stream sponsored message.
 *
 * Counting: uses IntersectionObserver with a 1s continuous visibility gate
 * (matching the per-appearance model). The impression is reported only once
 * per session (module-level dedup Set).
 */
export function NativeAdMessage({ campaign }: { campaign: AdCampaign }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reportedRef = useRef(false);
  const visibleStartRef = useRef<number | null>(null);
  const gateRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { focused, visible } = useAgentStore((s) => s.ads);

  const reportOnce = useCallback(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    void reportImpression({
      campaignId: campaign.id,
      placement: "native",
      durationMs: IMPRESSION_GATE_MS,
      wasFocused: focused,
      wasVisible: visible,
    });
  }, [campaign.id, focused, visible]);

  useEffect(() => {
    const key = `${campaign.id}:native`;
    if (reportedImpressions.has(key)) return;
    reportedImpressions.add(key);

    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && focused && visible) {
          if (visibleStartRef.current === null) {
            visibleStartRef.current = Date.now();
            gateRef.current = setTimeout(() => {
              reportOnce();
            }, IMPRESSION_GATE_MS);
          }
        } else {
          visibleStartRef.current = null;
          if (gateRef.current) {
            clearTimeout(gateRef.current);
            gateRef.current = undefined;
          }
        }
      },
      { threshold: 0.5 },
    );

    observer.observe(element);
    return () => {
      observer.disconnect();
      if (gateRef.current) clearTimeout(gateRef.current);
    };
  }, [campaign.id, focused, visible, reportOnce]);

  return (
    <div
      ref={containerRef}
      className="mt-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 py-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-ghost text-[10px] font-bold tracking-[0.12em] uppercase">
          Sponsored
        </span>
        {campaign.brandName && (
          <span className="text-text text-xs font-semibold">{campaign.brandName}</span>
        )}
      </div>
      <p className="text-dim text-sm leading-relaxed">
        {campaign.body ?? campaign.tagline}{" "}
        <button
          type="button"
          onClick={() => void reportAdClick(campaign.id, "native")}
          className="text-signal hover:text-signal/80 inline underline underline-offset-2"
        >
          {campaign.cta ?? campaign.destinationUrl}
        </button>
      </p>
    </div>
  );
}
