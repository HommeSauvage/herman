import { describe, expect, test } from "bun:test";

import { getModelProvider, isHermanModel } from "./model-utils.js";

describe("model-utils", () => {
  test("getModelProvider extracts provider prefix", () => {
    expect(getModelProvider("herman/gpt-4o")).toBe("herman");
    expect(getModelProvider("openai/gpt-4o")).toBe("openai");
    expect(getModelProvider("anthropic/claude-3-5-sonnet-20241022")).toBe("anthropic");
  });

  test("getModelProvider treats bare model IDs as herman", () => {
    expect(getModelProvider("gpt-4o")).toBe("herman");
  });

  test("getModelProvider returns undefined for missing or empty IDs", () => {
    expect(getModelProvider(undefined)).toBeUndefined();
    expect(getModelProvider("")).toBeUndefined();
  });

  test("isHermanModel recognizes herman provider models", () => {
    expect(isHermanModel("herman/gpt-4o")).toBe(true);
    expect(isHermanModel("gpt-4o")).toBe(true);
    expect(isHermanModel("openai/gpt-4o")).toBe(false);
    expect(isHermanModel("anthropic/claude-3-5-sonnet-20241022")).toBe(false);
    expect(isHermanModel(undefined)).toBe(false);
  });
});
