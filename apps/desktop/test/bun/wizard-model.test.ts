import { describe, expect, it } from "vitest";

import { parseWizardModelRef } from "../../src/bun/wizard-session.js";

describe("parseWizardModelRef", () => {
  it("splits provider/model ids", () => {
    expect(parseWizardModelRef("herman/kimi-k2.7-code")).toEqual({
      provider: "herman",
      modelId: "kimi-k2.7-code",
    });
    expect(parseWizardModelRef("openai/gpt-4o-mini")).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("defaults bare ids to the herman provider", () => {
    expect(parseWizardModelRef("kimi-k2.7-code")).toEqual({
      provider: "herman",
      modelId: "kimi-k2.7-code",
    });
  });

  it("preserves nested slashes in the model id", () => {
    expect(parseWizardModelRef("custom/org/model")).toEqual({
      provider: "custom",
      modelId: "org/model",
    });
  });
});
