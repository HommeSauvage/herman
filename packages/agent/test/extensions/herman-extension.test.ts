import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMAN_REFRESH_MODELS_MESSAGE } from "@herman/rpc/agent";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

describe("hermanExtension", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let cacheDir: string;

  beforeEach(() => {
    process.env.HERMAN_SERVER_URL = "http://localhost:4000";
    process.env.HERMAN_SESSION_TOKEN = "session-token";
    cacheDir = mkdtempSync(join(tmpdir(), "herman-extension-test-"));
    process.env.HERMAN_APP_DIR = cacheDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function createMockApi() {
    const registered: {
      provider: string;
      config: {
        baseUrl?: string;
        apiKey?: string;
        authHeader?: boolean;
        api?: string;
        models?: { id: string; name: string; api?: string }[];
      };
    }[] = [];
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const notifications: unknown[] = [];
    const setModelCalls: unknown[] = [];
    const registeredTools: { name: string; description: string }[] = [];
    const toolExecutors = new Map<
      string,
      (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>
    >();

    const mockUi = {
      notify: (message: unknown) => {
        notifications.push(message);
      },
      editor: async (_title?: string, _prefill?: string): Promise<string | undefined> => undefined,
    };

    const mockApi = {
      registerProvider: (
        provider: string,
        config: {
          baseUrl?: string;
          apiKey?: string;
          authHeader?: boolean;
          api?: string;
          models?: { id: string; name: string; api?: string }[];
        },
      ) => {
        registered.push({ provider, config });
      },
      registerTool: (tool: {
        name: string;
        description: string;
        execute: (
          toolCallId: string,
          params: unknown,
          signal: unknown,
          onUpdate: unknown,
          ctx: unknown,
        ) => Promise<unknown>;
      }) => {
        registeredTools.push({ name: tool.name, description: tool.description });
        toolExecutors.set(tool.name, tool.execute);
      },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      setModel: (model: unknown) => {
        setModelCalls.push(model);
        return Promise.resolve(true);
      },
      _registered: registered,
      _registeredTools: registeredTools,
      _toolExecutors: toolExecutors,
      _handlers: handlers,
      _notifications: notifications,
      _setModelCalls: setModelCalls,
      _ui: mockUi,
    };

    return { mockApi, mockUi };
  }

  function mockFetch(models: { id: string; name: string; api?: string; contextWindow?: number; maxTokens?: number }[], ok = true) {
    return vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ models }),
      text: async () => (ok ? "" : "server error"),
    } as Response);
  }

  it("registers a single herman provider using the server proxy", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].provider).toBe("herman");
    expect(mockApi._registered[0].config.baseUrl).toBe("http://localhost:4000/api/agent/proxy");
    expect(mockApi._registered[0].config.apiKey).toBe("session-token");
    expect(mockApi._registered[0].config.authHeader).toBe(true);
    expect(mockApi._registered[0].config.api).toBe("openai-completions");
  });

  // herman_get_session_info was moved to preview-context-extension.ts;
  // herman-extension no longer registers session/preview tools.
  it("no longer registers herman_get_session_info", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registeredTools.map((t) => t.name)).not.toContain("herman_get_session_info");
  });

  it("registers models returned by the server", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions" },
      { id: "glm-4.5", name: "GLM 4.5", api: "openai-completions" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const models = mockApi._registered[0].config.models;
    expect(models).toHaveLength(2);
    expect(models?.[0].id).toBe("kimi-k2.7-code");
    expect(models?.[1].id).toBe("glm-4.5");
  });

  it("sets per-model api and omits provider-level api when models have mixed APIs", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "anthropic-messages" },
      { id: "glm-4.5", name: "GLM 4.5", api: "openai-completions" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const config = mockApi._registered[0].config;
    expect(config.api).toBeUndefined();
    expect(config.models?.[0].api).toBe("anthropic-messages");
    expect(config.models?.[1].api).toBe("openai-completions");
  });

  it("defaults model api to openai-completions when the server omits it", async () => {
    globalThis.fetch = mockFetch([{ id: "glm-4.5", name: "GLM 4.5" }]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const config = mockApi._registered[0].config;
    expect(config.api).toBe("openai-completions");
    expect(config.models?.[0].api).toBe("openai-completions");
  });

  it("falls back to cached models when the server is unreachable on startup", async () => {
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");

    // First run: server is reachable, populate the cache.
    globalThis.fetch = mockFetch([{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code" }]) as unknown as typeof fetch;
    await hermanExtension(createMockApi().mockApi as never);

    // Second run: server is down, but the cache should still be used.
    globalThis.fetch = mockFetch([], false) as unknown as typeof fetch;
    const { mockApi } = createMockApi();
    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models).toHaveLength(1);
    expect(mockApi._registered[0].config.models?.[0].id).toBe("kimi-k2.7-code");
  });

  it("ignores the cache when it belongs to a different server URL", async () => {
    const cachePath = join(cacheDir, "herman-models-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        serverUrl: "http://old-server:4000",
        fetchedAt: new Date().toISOString(),
        models: [{ id: "old-model", name: "Old Model" }],
      }),
    );

    globalThis.fetch = mockFetch([], false) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi } = createMockApi();
    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models).toHaveLength(0);
  });

  it("handles the refresh message and refreshes the model list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ id: "kimi-k2.7-code", name: "Kimi" }] }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ id: "glm-4.5", name: "GLM 4.5" }] }),
        text: async () => "",
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const inputHandlers = mockApi._handlers.get("input") ?? [];
    expect(inputHandlers).toHaveLength(1);

    const ctx = {
      model: undefined,
      ui: mockUi,
      modelRegistry: {
        find: vi.fn(),
        getAvailable: () => [{ id: "glm-4.5", provider: "herman" }],
      },
    };

    const result = await inputHandlers[0]({ text: HERMAN_REFRESH_MODELS_MESSAGE }, ctx);
    expect(result).toEqual({ action: "handled" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const notifications = mockApi._notifications
      .filter((n): n is string => typeof n === "string")
      .map((n) => JSON.parse(n));
    expect(notifications).toContainEqual({
      type: "models_sync",
      models: ["herman/glm-4.5"],
      currentModel: undefined,
    });
  });

  it("registers an empty provider when the server returns no models", async () => {
    globalThis.fetch = mockFetch([]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models).toHaveLength(0);
  });

  it("registers an empty provider when fetching models fails", async () => {
    globalThis.fetch = mockFetch([], false) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models).toHaveLength(0);
  });

  it("throws when a local provider key is present", async () => {
    process.env.OPENAI_API_KEY = "sk-local";
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();
    await expect(hermanExtension(mockApi as never)).rejects.toThrow("OPENAI_API_KEY");
    delete process.env.OPENAI_API_KEY;
  });

  it("selects the first available model on session_start when none is active", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const model = { id: "kimi-k2.7-code", provider: "herman" };
    const ctx = {
      model: undefined,
      ui: mockUi,
      modelRegistry: {
        find: (_provider: string, id: string) => (id === "kimi-k2.7-code" ? model : undefined),
        getAvailable: () => [model],
      },
    };

    const handlers = mockApi._handlers.get("session_start") ?? [];
    expect(handlers).toHaveLength(1);
    await handlers[0]({}, ctx);

    expect(mockApi._setModelCalls).toContainEqual(model);
    const notifications = mockApi._notifications
      .filter((n): n is string => typeof n === "string")
      .map((n) => JSON.parse(n));
    expect(notifications).toContainEqual({
      type: "models_sync",
      models: ["herman/kimi-k2.7-code"],
      currentModel: "herman/kimi-k2.7-code",
    });
  });

  it("selects the first herman model as default regardless of registry order", async () => {
    // The Herman server returns glm-4.5 first, then kimi-k2.7-code.
    // selectDefaultModel should pick glm-4.5 (the first in hermanModels).
    globalThis.fetch = mockFetch([
      { id: "glm-4.5", name: "GLM 4.5" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    // getAvailable() returns kimi first to prove we follow hermanModels order, not registry order
    const kimiModel = { id: "kimi-k2.7-code", provider: "herman" };
    const glmModel = { id: "glm-4.5", provider: "herman" };
    const ctx = {
      model: undefined,
      ui: mockUi,
      modelRegistry: {
        find: (_provider: string, id: string) => (id === "kimi-k2.7-code" ? kimiModel : id === "glm-4.5" ? glmModel : undefined),
        getAvailable: () => [kimiModel, glmModel],
      },
    };

    const handlers = mockApi._handlers.get("session_start") ?? [];
    expect(handlers).toHaveLength(1);
    await handlers[0]({}, ctx);

    // Should choose glm-4.5 (first in hermanModels) even though kimi comes first in getAvailable()
    expect(mockApi._setModelCalls).toContainEqual(glmModel);
    expect(mockApi._setModelCalls).not.toContainEqual(kimiModel);
  });

  it("does not change model on session_start when a herman model is already active", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const ctx = {
      model: { id: "glm-4.5", provider: "herman" },
      ui: mockUi,
      modelRegistry: {
        find: vi.fn(),
        getAvailable: () => [{ id: "kimi-k2.7-code", provider: "herman" }],
      },
    };

    const handlers = mockApi._handlers.get("session_start") ?? [];
    await handlers[0]({}, ctx);

    expect(mockApi._setModelCalls).toHaveLength(0);
    const notifications = mockApi._notifications
      .filter((n): n is string => typeof n === "string")
      .map((n) => JSON.parse(n));
    expect(notifications).toContainEqual({
      type: "models_sync",
      models: ["herman/kimi-k2.7-code"],
      currentModel: "herman/glm-4.5",
    });
  });

  it("refetches and re-registers models after a quota proxy failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ id: "kimi-k2.7-code", name: "Kimi", api: "anthropic-messages" }],
        }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ id: "kimi-k2.7-code", name: "Kimi", api: "openai-completions" }],
        }),
        text: async () => "",
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);
    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models?.[0].api).toBe("anthropic-messages");

    const handlers = mockApi._handlers.get("after_provider_response") ?? [];
    await handlers[0](
      { status: 403 },
      {
        model: { id: "kimi-k2.7-code", provider: "herman" },
        ui: mockUi,
        modelRegistry: {
          find: vi.fn(),
          getAvailable: () => [{ id: "kimi-k2.7-code", provider: "herman" }],
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockApi._registered).toHaveLength(2);
    expect(mockApi._registered[1].config.models?.[0].api).toBe("openai-completions");
  });

  it("includes model metadata in models_sync when contextWindow is available", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions", contextWindow: 128000, maxTokens: 8192 },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const ctx = {
      model: undefined,
      ui: mockUi,
      modelRegistry: {
        find: vi.fn(),
        getAvailable: () => [
          { id: "kimi-k2.7-code", provider: "herman", contextWindow: 128000, maxTokens: 8192 },
        ],
      },
    };

    const handlers = mockApi._handlers.get("session_start") ?? [];
    await handlers[0]({}, ctx);

    const notifications = mockApi._notifications
      .filter((n): n is string => typeof n === "string")
      .map((n) => JSON.parse(n));
    expect(notifications).toContainEqual({
      type: "models_sync",
      models: ["herman/kimi-k2.7-code"],
      currentModel: "herman/kimi-k2.7-code",
      modelMetadata: {
        "herman/kimi-k2.7-code": { contextWindow: 128000, maxTokens: 8192 },
      },
    });
  });

  // ── Cache-first startup (shared desktop catalog) ─────────────────────────

  async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function writeSharedCatalog(models: { id: string; name?: string }[], custom: Record<string, string[]> = {}) {
    writeFileSync(
      join(cacheDir, "model-catalog.json"),
      JSON.stringify({
        version: 1,
        serverUrl: "http://localhost:4000",
        fetchedAt: "2024-01-01T00:00:00.000Z",
        herman: models,
        custom,
      }),
    );
  }

  it("registers instantly from the shared catalog and refreshes in the background", async () => {
    writeSharedCatalog([{ id: "cached-model", name: "Cached" }], { openai: ["gpt-4o"] });

    // Background refresh stays pending until we resolve it manually.
    let resolveFetch: ((value: unknown) => void) | undefined;
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    ) as unknown as typeof fetch;

    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi } = createMockApi();
    await hermanExtension(mockApi as never);

    // Registration happened synchronously from the cache — no network wait.
    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models?.map((m) => m.id)).toEqual(["cached-model"]);

    // Let the background refresh land with a fresh list.
    resolveFetch!({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ id: "fresh-model", name: "Fresh" }] }),
      text: async () => "",
    });
    await waitFor(() => mockApi._registered.length > 1);

    const last = mockApi._registered[mockApi._registered.length - 1];
    expect(last.config.models?.map((m) => m.id)).toEqual(["fresh-model"]);

    // The shared catalog file got the fresh herman list; the desktop-owned
    // custom section was preserved.
    const file = JSON.parse(readFileSync(join(cacheDir, "model-catalog.json"), "utf-8"));
    expect(file.herman.map((m: { id: string }) => m.id)).toEqual(["fresh-model"]);
    expect(file.custom).toEqual({ openai: ["gpt-4o"] });
  });

  it("keeps the cached registration and disk cache when the background refresh fails", async () => {
    writeSharedCatalog([{ id: "cached-model", name: "Cached" }]);
    const before = readFileSync(join(cacheDir, "model-catalog.json"), "utf-8");

    globalThis.fetch = mockFetch([], false) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi } = createMockApi();
    await hermanExtension(mockApi as never);

    // Let the background refresh settle (it fails silently).
    await new Promise((resolve) => setTimeout(resolve, 25));

    // No re-registration, cached models still active, cache file untouched.
    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models?.[0].id).toBe("cached-model");
    expect(readFileSync(join(cacheDir, "model-catalog.json"), "utf-8")).toBe(before);
  });

  it("pushes a fresh models_sync after session_start when the background refresh lands", async () => {
    writeSharedCatalog([{ id: "cached-model", name: "Cached" }]);

    let resolveFetch: ((value: unknown) => void) | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: unknown) => {
      // Ad fetches resolve immediately; the models fetch stays pending until
      // we resolve it manually below.
      if (String(url).includes("/api/ads/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "",
        });
      }
      return new Promise((resolve) => { resolveFetch = resolve; });
    }) as unknown as typeof fetch;

    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi, mockUi } = createMockApi();
    await hermanExtension(mockApi as never);

    const ctx = {
      model: { id: "cached-model", provider: "herman" },
      ui: mockUi,
      modelRegistry: {
        find: vi.fn(),
        // Simulate pi's registry following (re)registration.
        getAvailable: () => {
          const last = mockApi._registered[mockApi._registered.length - 1];
          return (last?.config.models ?? []).map((m) => ({ id: m.id, provider: "herman" }));
        },
      },
    };
    const handlers = mockApi._handlers.get("session_start") ?? [];
    await handlers[0]({}, ctx);

    // Now the background refresh completes with a new model list.
    resolveFetch!({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ id: "fresh-model", name: "Fresh" }] }),
      text: async () => "",
    });
    await waitFor(() =>
      mockApi._notifications
        .filter((n): n is string => typeof n === "string")
        .map((n) => JSON.parse(n) as { type?: string; models?: string[] })
        .some((n) => n.type === "models_sync" && n.models?.includes("herman/fresh-model")),
    );
  });

  it("migrates the legacy cache on read and removes it after a successful refresh", async () => {
    const legacyPath = join(cacheDir, "herman-models-cache.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        serverUrl: "http://localhost:4000",
        fetchedAt: "2024-01-01T00:00:00.000Z",
        models: [{ id: "legacy-model", name: "Legacy" }],
      }),
    );

    globalThis.fetch = mockFetch([{ id: "fresh-model", name: "Fresh" }]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("../../src/extensions/herman-extension.js");
    const { mockApi } = createMockApi();
    await hermanExtension(mockApi as never);

    // Instant registration from the legacy cache.
    expect(mockApi._registered[0].config.models?.[0].id).toBe("legacy-model");

    // Background refresh writes the new catalog file and removes the legacy one.
    await waitFor(() => mockApi._registered.length > 1);
    await waitFor(() => {
      try {
        readFileSync(join(cacheDir, "model-catalog.json"), "utf-8");
        return true;
      } catch {
        return false;
      }
    });
    expect(() => readFileSync(legacyPath, "utf-8")).toThrow();
  });
});
