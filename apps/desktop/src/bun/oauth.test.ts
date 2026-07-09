import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OAuthCredential } from "../shared/rpc.js";
import {
  cancelOAuthLogin,
  getOAuthProvider,
  pollOAuthLogin,
  refreshOAuthToken,
  registerOAuthProvider,
  startOAuthLogin,
} from "./oauth.js";

describe("oauth", () => {
  beforeEach(async () => {
    await cancelOAuthLogin("test");
  });

  afterEach(async () => {
    await cancelOAuthLogin("test");
  });

  it("returns the built-in Anthropic provider", () => {
    expect(getOAuthProvider("anthropic")?.id).toBe("anthropic");
  });

  it("returns undefined for an unknown provider", () => {
    expect(getOAuthProvider("unknown")).toBeUndefined();
  });

  it("registers a custom provider", async () => {
    let refreshed = false;
    const provider = {
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async () => {
        refreshed = true;
        return { type: "oauth" as const, accessToken: "refreshed" };
      },
    };

    registerOAuthProvider(provider);
    const credential: OAuthCredential = { type: "oauth", accessToken: "access" };
    await refreshOAuthToken("test", credential);

    expect(refreshed).toBe(true);
  });

  it("throws when starting an unknown provider", async () => {
    await expect(startOAuthLogin("unknown")).rejects.toThrow("Unknown OAuth provider");
  });

  it("starts an OAuth login and returns an auth URL and state", async () => {
    const provider = {
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async (credential: OAuthCredential) => credential,
    };

    registerOAuthProvider(provider);
    const { authUrl, state } = await startOAuthLogin("test");

    expect(authUrl).toContain("http://example.com/auth?state=");
    expect(state.length).toBeGreaterThan(0);
    expect(authUrl).toContain(state);
  });

  it("returns pending while waiting for authorization", async () => {
    const provider = {
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async (credential: OAuthCredential) => credential,
    };

    registerOAuthProvider(provider);
    const { state } = await startOAuthLogin("test");
    const status = await pollOAuthLogin("test", state);

    expect(status).toEqual({ status: "pending" });
  });

  it("handles an error from the provider's refresh", async () => {
    const provider = {
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async () => {
        throw new Error("refresh failed");
      },
    };

    registerOAuthProvider(provider);
    await expect(
      refreshOAuthToken("test", { type: "oauth", accessToken: "access", refreshToken: "refresh" }),
    ).rejects.toThrow("refresh failed");
  });

  it("returns error after cancellation", async () => {
    const provider = {
      id: "test",
      name: "Test provider",
      redirectUri: "http://localhost:9999/callback",
      buildAuthUrl: ({ verifier }: { verifier: string; challenge: string }) =>
        `http://example.com/auth?state=${verifier}`,
      exchangeCode: async () => ({ type: "oauth" as const, accessToken: "access" }),
      refresh: async (credential: OAuthCredential) => credential,
    };

    registerOAuthProvider(provider);
    const { state } = await startOAuthLogin("test");
    await cancelOAuthLogin("test");
    const status = await pollOAuthLogin("test", state);

    expect(status.status).toBe("error");
  });
});
