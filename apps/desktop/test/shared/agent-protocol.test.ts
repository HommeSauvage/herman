import { describe, expect, it } from "vitest";

import {
  parseAdEventFromNotify,
  parseHermanEventFromNotify,
} from "../../src/shared/agent-protocol.js";

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

describe("parseHermanEventFromNotify", () => {
  it("parses models_sync with model metadata", () => {
    const payload = JSON.stringify({
      type: "herman/models_sync",
      models: ["herman/kimi-k2.7-code"],
      currentModel: "herman/kimi-k2.7-code",
      modelMetadata: {
        "herman/kimi-k2.7-code": { contextWindow: 128000, maxTokens: 8192 },
      },
    });
    const event = parseHermanEventFromNotify(payload);
    expect(event).toEqual({
      type: "models_sync",
      models: ["herman/kimi-k2.7-code"],
      currentModel: "herman/kimi-k2.7-code",
      modelMetadata: {
        "herman/kimi-k2.7-code": { contextWindow: 128000, maxTokens: 8192 },
      },
    });
  });

  it("parses context_usage events", () => {
    const payload = JSON.stringify({
      type: "herman/context_usage",
      tokens: 1234,
      contextWindow: 128000,
      percent: 0.96,
    });
    const event = parseHermanEventFromNotify(payload);
    expect(event).toEqual({
      type: "herman/context_usage",
      tokens: 1234,
      contextWindow: 128000,
      percent: 0.96,
    });
  });

  it("ignores context_usage with invalid contextWindow", () => {
    const payload = JSON.stringify({
      type: "herman/context_usage",
      tokens: 1234,
      contextWindow: "large",
    });
    expect(parseHermanEventFromNotify(payload)).toBeUndefined();
  });

  it("ignores invalid model metadata entries", () => {
    const payload = JSON.stringify({
      type: "models_sync",
      models: ["herman/bad"],
      modelMetadata: {
        "herman/bad": { contextWindow: "lots" },
      },
    });
    const event = parseHermanEventFromNotify(payload);
    expect(event?.type === "models_sync" && event.modelMetadata).toBeUndefined();
  });

  it("parses a full context_report event", () => {
    const payload = JSON.stringify({
      type: "herman/context_report",
      schema: 1,
      modelKey: "anthropic/claude-sonnet-4.6",
      context: { tokens: 12_345, contextWindow: 200_000, percent: 6.17 },
      totals: {
        input: 1000,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
        reasoning: 30,
        cost: 0.0123,
      },
      lastUsage: {
        input: 500,
        output: 100,
        cacheRead: 25,
        cacheWrite: 0,
        reasoning: 10,
        totalTokens: 625,
        cost: { input: 0.005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.006 },
      },
      currentTurn: { output: 42, startedAt: 1700000000000, messageId: "m1" },
      isCompacted: false,
      isStreaming: true,
      updatedAt: 1700000001000,
    });
    const event = parseHermanEventFromNotify(payload);
    expect(event).toEqual({
      type: "herman/context_report",
      schema: 1,
      modelKey: "anthropic/claude-sonnet-4.6",
      context: { tokens: 12_345, contextWindow: 200_000, percent: 6.17 },
      totals: {
        input: 1000,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
        reasoning: 30,
        cost: 0.0123,
      },
      lastUsage: {
        input: 500,
        output: 100,
        cacheRead: 25,
        cacheWrite: 0,
        reasoning: 10,
        totalTokens: 625,
        cost: { input: 0.005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.006 },
      },
      currentTurn: { output: 42, startedAt: 1700000000000, messageId: "m1" },
      isCompacted: false,
      isStreaming: true,
      updatedAt: 1700000001000,
    });
  });

  it("parses a context_report with null tokens (post-compaction)", () => {
    const payload = JSON.stringify({
      type: "herman/context_report",
      schema: 1,
      modelKey: "anthropic/claude-sonnet-4.6",
      context: { tokens: null, contextWindow: 200_000, percent: null },
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
      isCompacted: true,
      isStreaming: false,
      updatedAt: 1700000001000,
    });
    const event = parseHermanEventFromNotify(payload);
    expect(event).toMatchObject({
      type: "herman/context_report",
      context: { tokens: null, percent: null },
      isCompacted: true,
    });
  });

  it("ignores context_report with wrong schema", () => {
    const payload = JSON.stringify({
      type: "herman/context_report",
      schema: 99,
      modelKey: "x",
      context: { tokens: 0, contextWindow: 100, percent: 0 },
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
      isCompacted: false,
      isStreaming: false,
      updatedAt: 0,
    });
    expect(parseHermanEventFromNotify(payload)).toBeUndefined();
  });

  it("ignores context_report missing required fields", () => {
    const payload = JSON.stringify({
      type: "herman/context_report",
      schema: 1,
      // missing modelKey
      context: { tokens: 0, contextWindow: 100, percent: 0 },
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
      isCompacted: false,
      isStreaming: false,
      updatedAt: 0,
    });
    expect(parseHermanEventFromNotify(payload)).toBeUndefined();
  });
});
