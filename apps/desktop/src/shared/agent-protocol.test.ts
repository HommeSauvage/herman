import { describe, expect, it } from "vitest";

import { parseAdEventFromNotify } from "./agent-protocol.js";

describe("parseAdEventFromNotify", () => {
  const validCampaign = {
    id: "camp-1",
    brandName: "Acme",
    tagline: "Build faster",
    destinationUrl: "https://acme.dev",
    iconUrl: "https://acme.dev/icon.png",
    imageUrl: "https://acme.dev/card.png",
    title: "Acme Pro",
    body: "Ship 10x faster with Acme.",
    cta: "Try free",
    accentColor: "#22c55e",
  };

  it("parses raw extension_ui_request payload", () => {
    const payload = JSON.stringify({
      type: "herman/ad_event",
      placement: "thinking_banner",
      campaign: validCampaign,
    });
    const event = parseAdEventFromNotify(payload);
    expect(event).toEqual({
      type: "herman/ad_event",
      placement: "thinking_banner",
      campaign: validCampaign,
    });
  });

  it("parses JSONL-RPC notification envelope", () => {
    const payload = {
      jsonrpc: "2.0",
      method: "notify",
      params: {
        type: "herman/ad_event",
        placement: "sidebar",
        campaign: validCampaign,
      },
    };
    const event = parseAdEventFromNotify(payload);
    expect(event?.placement).toBe("sidebar");
  });

  it("parses native placement events", () => {
    const payload = JSON.stringify({
      type: "herman/ad_event",
      placement: "native",
      campaign: { ...validCampaign, body: "Try Acme today." },
    });
    const event = parseAdEventFromNotify(payload);
    expect(event?.placement).toBe("native");
    expect(event?.campaign.body).toBe("Try Acme today.");
  });

  it("returns undefined for invalid placement", () => {
    const payload = JSON.stringify({
      type: "herman/ad_event",
      placement: "header",
      campaign: validCampaign,
    });
    expect(parseAdEventFromNotify(payload)).toBeUndefined();
  });

  it("returns undefined for missing campaign fields", () => {
    const payload = JSON.stringify({
      type: "herman/ad_event",
      placement: "thinking_banner",
      campaign: { id: "camp-1" },
    });
    expect(parseAdEventFromNotify(payload)).toBeUndefined();
  });

  it("returns undefined for non-object payload", () => {
    expect(parseAdEventFromNotify(123)).toBeUndefined();
    expect(parseAdEventFromNotify("not json")).toBeUndefined();
  });

  it("strips unknown campaign fields", () => {
    const payload = JSON.stringify({
      type: "herman/ad_event",
      placement: "thinking_banner",
      campaign: { ...validCampaign, extra: "ignored" },
    });
    const event = parseAdEventFromNotify(payload);
    expect(event?.campaign).not.toHaveProperty("extra");
  });
});
