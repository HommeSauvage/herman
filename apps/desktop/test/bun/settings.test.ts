import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-settings-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

async function importSettings() {
  return import("../../src/bun/settings.js");
}

describe("loadSettings", () => {
  it("returns defaults when the settings file is missing", async () => {
    const { loadSettings } = await importSettings();

    const settings = await loadSettings();

    expect(settings.providers.custom).toEqual({});
    expect(settings.models).toEqual({});
  });

  it("loads the new split provider shape", async () => {
    const { loadSettings } = await importSettings();
    writeFileSync(
      join(tempDir, "settings.json"),
      JSON.stringify({
        providers: {
          herman: { enabled: true, serverUrl: "https://herman.example" },
          custom: {
            openai: { enabled: true, authMethod: "apiKey", options: { baseUrl: "..." } },
          },
        },
      }),
    );

    const settings = await loadSettings();

    expect(settings.providers.herman.enabled).toBe(true);
    expect(settings.providers.herman.serverUrl).toBe("https://herman.example");
    expect(settings.providers.custom.openai).toEqual({
      enabled: true,
      authMethod: "apiKey",
      options: { baseUrl: "..." },
    });
  });

  it("migrates custom providers from the old flat providers shape", async () => {
    const { loadSettings } = await importSettings();
    writeFileSync(
      join(tempDir, "settings.json"),
      JSON.stringify({
        providers: {
          herman: { enabled: true, serverUrl: "https://herman.example" },
          openai: { enabled: true, authMethod: "apiKey", options: { baseUrl: "..." } },
          anthropic: { enabled: false },
        },
      }),
    );

    const settings = await loadSettings();

    expect(settings.providers.herman.enabled).toBe(true);
    expect(settings.providers.custom.openai).toEqual({
      enabled: true,
      authMethod: "apiKey",
      options: { baseUrl: "..." },
    });
    expect(settings.providers.custom.anthropic).toEqual({ enabled: false });
  });

  it("strips a persisted credentialStoreError", async () => {
    const { loadSettings } = await importSettings();
    writeFileSync(
      join(tempDir, "settings.json"),
      JSON.stringify({
        credentialStoreError: "some old error",
        providers: { herman: { enabled: true } },
      }),
    );

    const settings = await loadSettings();

    expect(settings.credentialStoreError).toBeUndefined();
  });
});

describe("saveSettings", () => {
  it("does not persist credentialStoreError", async () => {
    const { saveSettings } = await importSettings();
    await saveSettings({
      credentialStoreError: "should not be saved",
      providers: { herman: { enabled: true }, custom: {} },
      models: {},
    });

    const raw = JSON.parse(await Bun.file(join(tempDir, "settings.json")).text());
    expect(raw.credentialStoreError).toBeUndefined();
    expect(raw.providers.herman.enabled).toBe(true);
  });
});

describe("models.lastUsedModel", () => {
  it("migrates a legacy defaultModel to lastUsedModel", async () => {
    const { loadSettings } = await importSettings();
    writeFileSync(
      join(tempDir, "settings.json"),
      JSON.stringify({
        providers: { herman: { enabled: true } },
        models: { defaultModel: "herman/kimi", hiddenModels: ["openai/gpt-4o"] },
      }),
    );

    const settings = await loadSettings();

    expect(settings.models.lastUsedModel).toBe("herman/kimi");
    expect(settings.models.defaultModel).toBeUndefined();
    expect(settings.models.hiddenModels).toEqual(["openai/gpt-4o"]);
  });

  it("prefers lastUsedModel when both fields exist", async () => {
    const { loadSettings } = await importSettings();
    writeFileSync(
      join(tempDir, "settings.json"),
      JSON.stringify({
        providers: { herman: { enabled: true } },
        models: { defaultModel: "herman/old", lastUsedModel: "herman/new" },
      }),
    );

    const settings = await loadSettings();

    expect(settings.models.lastUsedModel).toBe("herman/new");
    expect(settings.models.defaultModel).toBeUndefined();
  });
});

describe("updateSettings", () => {
  it("read-modify-writes without clobbering unrelated fields", async () => {
    const { saveSettings, updateSettings, loadSettings } = await importSettings();
    await saveSettings({
      providers: { herman: { enabled: true }, custom: {} },
      models: { hiddenModels: ["openai/gpt-4o"] },
      mode: "normal",
    });

    await updateSettings((current) => ({
      ...current,
      models: { ...current.models, lastUsedModel: "herman/kimi" },
    }));

    const settings = await loadSettings();
    expect(settings.models.lastUsedModel).toBe("herman/kimi");
    expect(settings.models.hiddenModels).toEqual(["openai/gpt-4o"]);
    expect(settings.mode).toBe("normal");
  });

  it("supports clearing the last-used model", async () => {
    const { saveSettings, updateSettings, loadSettings } = await importSettings();
    await saveSettings({
      providers: { herman: { enabled: true }, custom: {} },
      models: { lastUsedModel: "herman/kimi" },
    });

    await updateSettings((current) => ({
      ...current,
      models: { ...current.models, lastUsedModel: undefined },
    }));

    const settings = await loadSettings();
    expect(settings.models.lastUsedModel).toBeUndefined();
  });
});
