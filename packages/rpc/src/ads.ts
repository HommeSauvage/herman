export const ALL_AD_PLACEMENTS = ["thinking_banner", "sidebar", "native"] as const;

export type AdPlacement = (typeof ALL_AD_PLACEMENTS)[number];

// Per-placement bid floors in cents (for CPM model)
export const AD_PLACEMENT_FLOORS: Record<AdPlacement, number> = {
  thinking_banner: 100,
  sidebar: 200,
  native: 50,
};

// Block-based pricing: 1 block = 1,000 impressions.
// Price per block (in USD cents), minimum bid per block.
export const BLOCK_PRICES: Record<AdPlacement, { price: number; minBid: number }> = {
  thinking_banner: { price: 1500, minBid: 500 },
  sidebar: { price: 500, minBid: 200 },
  native: { price: 1000, minBid: 300 },
};

/** Delivery velocity estimates in impressions/hour for 100 active users. */
export const BLOCK_VELOCITY_IMPRESSIONS_PER_HOUR: Record<AdPlacement, number> = {
  thinking_banner: 408, // ~2.5h/block at 100 users
  sidebar: 960, // ~1h/block at 100 users
  native: 42, // ~24h/block at 100 users
};

export type AdCampaign = {
  id: string;
  brandName: string;
  tagline: string;
  destinationUrl: string;
  iconUrl?: string;
  // Rich creative fields used by the sidebar and native placements.
  imageUrl?: string;
  title?: string;
  body?: string;
  cta?: string;
  accentColor?: string;
};

export type AdEvent = {
  type: "herman/ad_event";
  placement: AdPlacement;
  campaign: AdCampaign;
};

export type AdImpressionReport = {
  campaignId: string;
  placement: AdPlacement;
  durationMs: number;
  wasFocused: boolean;
  wasVisible: boolean;
  thinkingDurationMs?: number;
};

export type AdClickReport = {
  campaignId: string;
  placement: AdPlacement;
};

export function isAdPlacement(value: unknown): value is AdPlacement {
  return ALL_AD_PLACEMENTS.includes(value as AdPlacement);
}
