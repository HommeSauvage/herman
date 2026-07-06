import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

describe("hermanExtension", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.HERMAN_SERVER_URL = "http://localhost:4000";
    process.env.HERMAN_SESSION_TOKEN = "session-token";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
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

    const mockUi = {
      notify: (message: unknown) => {
        notifications.push(message);
      },
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
      _handlers: handlers,
      _notifications: notifications,
      _setModelCalls: setModelCalls,
      _ui: mockUi,
    };

    return { mockApi, mockUi };
  }

  function mockFetch(models: { id: string; name: string; api?: string }[], ok = true) {
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
    const { default: hermanExtension } = await import("./herman-extension.js");
    const { mockApi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].provider).toBe("herman");
    expect(mockApi._registered[0].config.baseUrl).toBe("http://localhost:4000/api/agent/proxy");
    expect(mockApi._registered[0].config.apiKey).toBe("session-token");
    expect(mockApi._registered[0].config.authHeader).toBe(true);
    expect(mockApi._registered[0].config.api).toBe("openai-completions");
  });

  it("registers models returned by the server", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions" },
      { id: "glm-4.5", name: "GLM 4.5", api: "openai-completions" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("./herman-extension.js");
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
    const { default: hermanExtension } = await import("./herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const config = mockApi._registered[0].config;
    expect(config.api).toBeUndefined();
    expect(config.models?.[0].api).toBe("anthropic-messages");
    expect(config.models?.[1].api).toBe("openai-completions");
  });

  it("defaults model api to openai-completions when the server omits it", async () => {
    globalThis.fetch = mockFetch([{ id: "glm-4.5", name: "GLM 4.5" }]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("./herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    const config = mockApi._registered[0].config;
    expect(config.api).toBe("openai-completions");
    expect(config.models?.[0].api).toBe("openai-completions");
  });

  it("registers an empty provider when the server returns no models", async () => {
    globalThis.fetch = mockFetch([]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("./herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models).toHaveLength(0);
  });

  it("registers an empty provider when fetching models fails", async () => {
    globalThis.fetch = mockFetch([], false) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("./herman-extension.js");
    const { mockApi, mockUi } = createMockApi();

    await hermanExtension(mockApi as never);

    expect(mockApi._registered).toHaveLength(1);
    expect(mockApi._registered[0].config.models).toHaveLength(0);
  });

  it("throws when a local provider key is present", async () => {
    process.env.OPENAI_API_KEY = "sk-local";
    const { default: hermanExtension } = await import("./herman-extension.js");
    const { mockApi, mockUi } = createMockApi();
    await expect(hermanExtension(mockApi as never)).rejects.toThrow("OPENAI_API_KEY");
    delete process.env.OPENAI_API_KEY;
  });

  it("selects the first available model on session_start when none is active", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("./herman-extension.js");
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

  it("does not change model on session_start when a herman model is already active", async () => {
    globalThis.fetch = mockFetch([
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ]) as unknown as typeof fetch;
    const { default: hermanExtension } = await import("./herman-extension.js");
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

    const { default: hermanExtension } = await import("./herman-extension.js");
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
});
