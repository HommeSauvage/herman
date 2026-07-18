import { describe, expect, it } from "vitest";

import {
  mergeCatalogModels,
  modelApplyFingerprint,
  normalizeModelId,
  parseModelRef,
  resolveSeedModel,
  shortModelId,
  shouldApplyDesiredModel,
  sortModelsHermanFirst,
} from "../../src/shared/model-selection.js";

describe("parseModelRef", () => {
  it("splits provider/model ids", () => {
    expect(parseModelRef("herman/kimi-k2.7-code")).toEqual({
      provider: "herman",
      modelId: "kimi-k2.7-code",
    });
    expect(parseModelRef("openai/gpt-4o-mini")).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("defaults bare ids to the herman provider", () => {
    expect(parseModelRef("kimi-k2.7-code")).toEqual({
      provider: "herman",
      modelId: "kimi-k2.7-code",
    });
  });

  it("preserves nested slashes in the model id", () => {
    expect(parseModelRef("custom/org/model")).toEqual({
      provider: "custom",
      modelId: "org/model",
    });
  });

  it("rejects empty and dangling ids", () => {
    expect(parseModelRef("")).toBeUndefined();
    expect(parseModelRef("   ")).toBeUndefined();
    expect(parseModelRef("openai/")).toBeUndefined();
    expect(parseModelRef("/model")).toBeUndefined();
  });
});

describe("normalizeModelId", () => {
  it("adds the herman prefix to bare ids", () => {
    expect(normalizeModelId("kimi")).toBe("herman/kimi");
  });

  it("keeps already-prefixed ids", () => {
    expect(normalizeModelId("openai/gpt-4o")).toBe("openai/gpt-4o");
  });

  it("returns undefined for missing or malformed ids", () => {
    expect(normalizeModelId(undefined)).toBeUndefined();
    expect(normalizeModelId("")).toBeUndefined();
    expect(normalizeModelId("openai/")).toBeUndefined();
  });
});

describe("shortModelId", () => {
  it("strips the provider prefix", () => {
    expect(shortModelId("herman/kimi")).toBe("kimi");
    expect(shortModelId("custom/org/model")).toBe("org/model");
  });
});

describe("sortModelsHermanFirst", () => {
  it("orders herman first, then provider, then id", () => {
    expect(
      sortModelsHermanFirst(["openai/b", "anthropic/x", "herman/b", "herman/a", "openai/a"]),
    ).toEqual(["herman/a", "herman/b", "anthropic/x", "openai/a", "openai/b"]);
  });

  it("treats bare ids as herman", () => {
    expect(sortModelsHermanFirst(["openai/a", "kimi"])).toEqual(["kimi", "openai/a"]);
  });
});

describe("mergeCatalogModels", () => {
  it("merges herman and custom models, deduped and sorted", () => {
    const merged = mergeCatalogModels({
      herman: ["kimi", "glm"],
      custom: { openai: ["gpt-4o"], anthropic: ["claude"] },
      hermanEnabled: true,
    });
    expect(merged).toEqual([
      "herman/glm",
      "herman/kimi",
      "anthropic/claude",
      "openai/gpt-4o",
    ]);
  });

  it("drops herman models entirely when the provider is disabled", () => {
    const merged = mergeCatalogModels({
      herman: ["kimi"],
      custom: { openai: ["gpt-4o"] },
      hermanEnabled: false,
    });
    expect(merged).toEqual(["openai/gpt-4o"]);
  });

  it("ignores herman entries in the custom map (server list wins)", () => {
    const merged = mergeCatalogModels({
      herman: ["kimi"],
      custom: { herman: ["stale-model"] },
      hermanEnabled: true,
    });
    expect(merged).toEqual(["herman/kimi"]);
  });

  it("skips malformed entries", () => {
    const merged = mergeCatalogModels({
      herman: ["", "kimi"],
      custom: { openai: ["gpt-4o", ""] },
      hermanEnabled: true,
    });
    expect(merged).toEqual(["herman/kimi", "openai/gpt-4o"]);
  });
});

describe("shouldApplyDesiredModel", () => {
  const available = ["herman/kimi", "openai/gpt-4o"];

  it("applies when the desired model is listed and not current", () => {
    expect(
      shouldApplyDesiredModel({ desired: "herman/kimi", actual: "openai/gpt-4o", available }),
    ).toBe(true);
  });

  it("does not apply when the agent already has the desired model", () => {
    expect(
      shouldApplyDesiredModel({ desired: "herman/kimi", actual: "herman/kimi", available }),
    ).toBe(false);
  });

  it("does not apply when the registry does not list the model", () => {
    expect(
      shouldApplyDesiredModel({ desired: "herman/removed", actual: "herman/kimi", available }),
    ).toBe(false);
  });

  it("does not apply without a desired model or without a registry list", () => {
    expect(shouldApplyDesiredModel({ desired: undefined, actual: "herman/kimi", available })).toBe(
      false,
    );
    expect(
      shouldApplyDesiredModel({ desired: "herman/kimi", actual: undefined, available: [] }),
    ).toBe(false);
  });

  it("normalizes bare desired ids before comparing", () => {
    expect(shouldApplyDesiredModel({ desired: "kimi", actual: "openai/gpt-4o", available })).toBe(
      true,
    );
    expect(shouldApplyDesiredModel({ desired: "kimi", actual: "herman/kimi", available })).toBe(
      false,
    );
  });
});

describe("modelApplyFingerprint", () => {
  it("is stable regardless of registry order", () => {
    const a = modelApplyFingerprint("herman/kimi", ["openai/gpt-4o", "herman/kimi"]);
    const b = modelApplyFingerprint("herman/kimi", ["herman/kimi", "openai/gpt-4o"]);
    expect(a).toBe(b);
  });

  it("changes when the desired model or the registry changes", () => {
    const base = modelApplyFingerprint("herman/kimi", ["herman/kimi"]);
    expect(modelApplyFingerprint("herman/other", ["herman/kimi"])).not.toBe(base);
    expect(modelApplyFingerprint("herman/kimi", ["herman/kimi", "openai/x"])).not.toBe(base);
  });
});

describe("resolveSeedModel", () => {
  it("prefers the last-used model when the catalog lists it", () => {
    expect(
      resolveSeedModel({ lastUsed: "herman/kimi", available: ["herman/kimi", "openai/gpt-4o"] }),
    ).toBe("herman/kimi");
  });

  it("returns undefined when the last-used model is gone from a known catalog", () => {
    expect(resolveSeedModel({ lastUsed: "herman/removed", available: ["herman/kimi"] })).toBe(
      undefined,
    );
  });

  it("seeds optimistically when the catalog is unknown (empty)", () => {
    expect(resolveSeedModel({ lastUsed: "herman/kimi", available: [] })).toBe("herman/kimi");
  });

  it("normalizes bare last-used ids and ignores missing values", () => {
    expect(resolveSeedModel({ lastUsed: "kimi", available: [] })).toBe("herman/kimi");
    expect(resolveSeedModel({ lastUsed: undefined, available: [] })).toBeUndefined();
  });
});
