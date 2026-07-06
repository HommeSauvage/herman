import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "herman-settings-"));
  process.env.HERMAN_APP_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.HERMAN_APP_DIR;
});

async function importSettings() {
  return import("./settings.js");
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
