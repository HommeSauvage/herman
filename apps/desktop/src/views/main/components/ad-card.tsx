import { useState } from "react";

import type { AdCampaign } from "../../../shared/agent-protocol.js";

export function AdCard({ campaign, onClick }: { campaign: AdCampaign; onClick?: () => void }) {
  const [imageError, setImageError] = useState(false);
  const [iconError, setIconError] = useState(false);

  const accentStyle = campaign.accentColor
    ? ({ ["--ad-accent"]: campaign.accentColor } as React.CSSProperties)
    : undefined;

  return (
    <button
      onClick={onClick}
      style={accentStyle}
      className="group bg-surface w-full overflow-hidden rounded-2xl border border-white/[0.06] text-left transition hover:border-[var(--ad-accent,var(--color-signal))]/25 hover:bg-[var(--ad-accent,var(--color-signal))]/5 hover:shadow-[0_0_20px_rgba(34,197,94,0.08)] active:scale-[0.98]"
    >
      {campaign.imageUrl && !imageError && (
        <div className="w-full">
          <img
            src={campaign.imageUrl}
            alt={campaign.brandName}
            className="h-40 w-full object-cover"
            onError={() => setImageError(true)}
          />
        </div>
      )}
      <div className="flex flex-col p-4">
        <div className="mb-2 flex items-center gap-2.5">
          {campaign.iconUrl && !iconError ? (
            <img
              src={campaign.iconUrl}
              alt={campaign.brandName}
              className="h-7 w-7 rounded-lg object-cover outline outline-1 outline-black/10"
              onError={() => setIconError(true)}
            />
          ) : (
            <div className="bg-signal/10 text-signal flex h-7 w-7 items-center justify-center rounded-lg text-[10px] font-bold">
              {campaign.brandName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="text-text text-sm font-semibold">{campaign.brandName}</span>
        </div>
        <h3 className="text-text mb-1 text-sm font-semibold">
          {campaign.title ?? campaign.brandName}
        </h3>
        <p className="text-dim mb-3 text-xs leading-relaxed">{campaign.body ?? campaign.tagline}</p>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="rounded-full bg-[var(--ad-accent,var(--color-signal))]/10 px-2.5 py-1 text-[10px] font-semibold text-[var(--ad-accent,var(--color-signal))]">
            {campaign.cta ?? "Learn more"}
          </span>
          <span className="text-ghost group-hover:text-faint truncate text-[10px] transition">
            {campaign.destinationUrl}
          </span>
        </div>
      </div>
    </button>
  );
}
