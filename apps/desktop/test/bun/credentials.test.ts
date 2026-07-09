import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "herman-credentials-"));
  process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN = "1";
  process.env.HERMAN_APP_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.HERMAN_APP_DIR;
});

async function importCredentials() {
  return import("../../src/bun/credentials.js");
}

async function importOAuth() {
  return import("../../src/bun/oauth.js");
}

describe("credentials", () => {
  it("round-trips provider credentials", async () => {
    const { setCredential, getCredential } = await importCredentials();

    await setCredential("openai", { type: "apiKey", key: "sk-test" });
    const loaded = await getCredential("openai");

    expect(loaded).toEqual({ type: "apiKey", key: "sk-test" });
  });

  it("returns undefined for a missing provider", async () => {
    const { getCredential } = await importCredentials();

    const loaded = await getCredential("missing");

    expect(loaded).toBeUndefined();
  });

  it("removes provider credentials", async () => {
    const { setCredential, getCredential, removeCredential } = await importCredentials();

    await setCredential("openai", { type: "apiKey", key: "sk-test" });
    await removeCredential("openai");
    const loaded = await getCredential("openai");

    expect(loaded).toBeUndefined();
  });

  it("returns an empty object and records an error when the store is corrupted", async () => {
    const { loadCredentials, getCredentialStoreError } = await importCredentials();
    const credentialsPath = join(tempDir, "credentials.enc.json");
    writeFileSync(credentialsPath, "not-valid-json");

    const loaded = await loadCredentials();

    expect(loaded).toEqual({});
    expect(getCredentialStoreError()).toBeDefined();
  });

  it("clears the store error after a successful save", async () => {
    const { setCredential, getCredentialStoreError } = await importCredentials();

    await setCredential("openai", { type: "apiKey", key: "sk-test" });

    expect(getCredentialStoreError()).toBeUndefined();
  });

  it("does not record an error when the store file is missing", async () => {
    const { loadCredentials, getCredentialStoreError } = await importCredentials();

    const loaded = await loadCredentials();

    expect(loaded).toEqual({});
    expect(getCredentialStoreError()).toBeUndefined();
  });

  it("serializes concurrent writes so the last one wins", async () => {
    const { setCredential, getCredential } = await importCredentials();

    await Promise.all([
      setCredential("openai", { type: "apiKey", key: "sk-a" }),
      setCredential("anthropic", { type: "apiKey", key: "sk-b" }),
      setCredential("google", { type: "apiKey", key: "sk-c" }),
    ]);

    expect(await getCredential("openai")).toEqual({ type: "apiKey", key: "sk-a" });
    expect(await getCredential("anthropic")).toEqual({ type: "apiKey", key: "sk-b" });
    expect(await getCredential("google")).toEqual({ type: "apiKey", key: "sk-c" });
  });

  it("refreshes an expired OAuth credential", async () => {
    const { registerOAuthProvider } = await importOAuth();
    registerOAuthProvider({
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async () => ({ type: "oauth" as const, accessToken: "refreshed" }),
    });

    const { setCredential, getRefreshedCredential } = await importCredentials();

    await setCredential("test", {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
    });

    const refreshed = await getRefreshedCredential("test");

    expect(refreshed).toEqual({ type: "oauth", accessToken: "refreshed" });
  });

  it("returns an unexpired OAuth credential without refreshing", async () => {
    const { setCredential, getRefreshedCredential } = await importCredentials();

    await setCredential("test", {
      type: "oauth",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    const refreshed = await getRefreshedCredential("test");

    expect(refreshed).toEqual({
      type: "oauth",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: expect.any(Number),
    });
  });

  it("refreshes all expired OAuth credentials in one pass", async () => {
    const { registerOAuthProvider } = await importOAuth();
    let refreshCount = 0;
    registerOAuthProvider({
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async () => {
        refreshCount++;
        return { type: "oauth" as const, accessToken: "refreshed" };
      },
    });

    const { setCredential, refreshAllOAuthCredentials } = await importCredentials();

    await setCredential("test", {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
    });

    await refreshAllOAuthCredentials();

    expect(refreshCount).toBe(1);
  });

  it("recovers from a failed write and allows subsequent writes", async () => {
    const { setCredential, getCredential } = await importCredentials();

    await setCredential("openai", { type: "apiKey", key: "sk-a" });

    writeFileSync(join(tempDir, "credentials.enc.json"), "bad-data");

    await setCredential("anthropic", { type: "apiKey", key: "sk-b" });
    expect(await getCredential("anthropic")).toEqual({ type: "apiKey", key: "sk-b" });
    expect(await getCredential("openai")).toBeUndefined();
  });
});
