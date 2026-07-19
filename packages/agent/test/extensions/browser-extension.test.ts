import { HOST_BRIDGE_ROUTES } from "@herman/rpc/host-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set before any dynamic import of env/config (arkenv reads once at module load).
process.env.HERMAN_HOST_BRIDGE_URL = "http://127.0.0.1:9876";
process.env.HERMAN_HOST_BRIDGE_TOKEN = "bridge-token";
process.env.HERMAN_TAB_ID = "tab-abc";

describe("browserExtension", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.HERMAN_HOST_BRIDGE_URL = "http://127.0.0.1:9876";
    process.env.HERMAN_HOST_BRIDGE_TOKEN = "bridge-token";
    process.env.HERMAN_TAB_ID = "tab-abc";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  function createMockApi() {
    const registeredTools: { name: string; description: string }[] = [];
    const toolExecutors = new Map<
      string,
      (
        toolCallId: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<unknown>
    >();

    const mockApi = {
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
      on: () => {},
      _registeredTools: registeredTools,
      _toolExecutors: toolExecutors,
    };

    return mockApi;
  }

  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }

  async function loadExtension() {
    const { default: browserExtension } = await import("../../src/extensions/browser-extension.js");
    const mockApi = createMockApi();
    await browserExtension(mockApi as never);
    return mockApi;
  }

  it("registers herman_browse and herman_browser_interact", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const mockApi = await loadExtension();
    expect(mockApi._registeredTools.map((t) => t.name)).toEqual([
      "herman_browse",
      "herman_browser_interact",
    ]);
  });

  it("herman_browse returns text + image when screenshot data is present", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/browser/goto") && init?.method === "POST") {
        return jsonResponse({
          available: true,
          ok: true,
          status: 200,
          url: "http://127.0.0.1:3000/about",
          pageErrors: ["boom"],
          consoleErrors: ["TypeError: x is not a function"],
        });
      }
      if (url.includes("/browser/screenshot")) {
        return jsonResponse({
          available: true,
          data: "abc123",
          mediaType: "image/jpeg",
          url: "http://127.0.0.1:3000/about",
        });
      }
      return jsonResponse({ error: "unexpected", code: "internal" }, false, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const execute = mockApi._toolExecutors.get("herman_browse");
    if (!execute) throw new Error("test precondition: expected executor");
    const result = (await execute("call-1", { path: "/about" }, undefined, undefined, {})) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };

    const text = result.content[0]?.text ?? "";
    expect(result.content[0]?.type).toBe("text");
    expect(
      text.includes(
        "Loaded http://127.0.0.1:3000/about (HTTP 200). 1 page errors, 1 console errors.",
      ),
    ).toBe(true);
    expect(text.includes("1. boom")).toBe(true);
    expect(text.includes("2. TypeError: x is not a function")).toBe(true);
    expect(result.content[1]).toEqual({
      type: "image",
      data: "abc123",
      mimeType: "image/jpeg",
    });
  });

  it("herman_browse omits the image block when screenshot data is missing", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/browser/goto") && init?.method === "POST") {
        return jsonResponse({
          available: true,
          ok: true,
          status: 200,
          url: "http://127.0.0.1:3000/",
          pageErrors: [],
          consoleErrors: [],
        });
      }
      if (url.includes("/browser/screenshot")) {
        return jsonResponse({ available: true, mediaType: "image/jpeg" });
      }
      return jsonResponse({ error: "unexpected", code: "internal" }, false, 500);
    }) as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const result = (await mockApi._toolExecutors.get("herman_browse")?.(
      "call-1",
      { path: "/" },
      undefined,
      undefined,
      {},
    )) as { content: Array<{ type: string }> };

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("passes path vs url through to browserGoto", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/browser/goto") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({
          available: true,
          ok: true,
          status: 200,
          url: "http://example.test/",
          pageErrors: [],
          consoleErrors: [],
        });
      }
      if (url.includes("/browser/screenshot")) {
        return jsonResponse({ available: true, data: "x", mediaType: "image/jpeg" });
      }
      return jsonResponse({ error: "unexpected", code: "internal" }, false, 500);
    }) as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const execute = mockApi._toolExecutors.get("herman_browse");
    if (!execute) throw new Error("test precondition: expected executor");

    await execute("c1", { path: "/pricing" }, undefined, undefined, {});
    await execute("c2", { url: "http://example.test/external" }, undefined, undefined, {});

    expect(bodies).toEqual([{ path: "/pricing" }, { url: "http://example.test/external" }]);

    const gotoUrl = HOST_BRIDGE_ROUTES.browserGoto("tab-abc");
    expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
      gotoUrl,
    );
  });

  it("returns unavailable guidance when the host reports browser_unavailable", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        { error: "Browser harness is not available", code: "browser_unavailable" },
        false,
        503,
      ),
    ) as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const result = (await mockApi._toolExecutors.get("herman_browse")?.(
      "call-1",
      { path: "/" },
      undefined,
      undefined,
      {},
    )) as { content: Array<{ type: string; text: string }>; details: { error: string } };

    expect(result.content[0].text).toContain("preview browser is not available");
    expect(result.content[0].text).toContain("do not claim visual verification");
    expect(result.details.error).toBe("unavailable");
  });

  it("returns unavailable guidance when the host bridge is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const result = (await mockApi._toolExecutors.get("herman_browse")?.(
      "call-1",
      { path: "/" },
      undefined,
      undefined,
      {},
    )) as { content: Array<{ type: string; text: string }>; details: { error: string } };

    expect(result.content[0].text).toContain("preview browser is not available");
    expect(result.details.error).toBe("unavailable");
  });

  it("herman_browser_interact runs act then optional screenshot", async () => {
    const methods: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(
        `${init?.method ?? "GET"} ${url.includes("/browser/act") ? "act" : url.includes("/browser/screenshot") ? "screenshot" : "other"}`,
      );
      if (url.includes("/browser/act")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          steps: [{ action: "click", selector: "#submit" }],
        });
        return jsonResponse({
          available: true,
          ok: true,
          url: "http://127.0.0.1:3000/done",
        });
      }
      if (url.includes("/browser/screenshot")) {
        return jsonResponse({
          available: true,
          data: "shot",
          mediaType: "image/jpeg",
        });
      }
      return jsonResponse({ error: "unexpected", code: "internal" }, false, 500);
    }) as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const result = (await mockApi._toolExecutors.get("herman_browser_interact")?.(
      "call-1",
      { steps: [{ action: "click", selector: "#submit" }] },
      undefined,
      undefined,
      {},
    )) as { content: Array<{ type: string; text?: string; data?: string }> };

    expect(methods).toEqual(["POST act", "GET screenshot"]);
    expect(
      (result.content[0]?.text ?? "").includes(
        "Completed 1 browser action(s) at http://127.0.0.1:3000/done.",
      ),
    ).toBe(true);
    expect(result.content[1]).toEqual({ type: "image", data: "shot", mimeType: "image/jpeg" });
  });

  it("herman_browser_interact skips screenshot when screenshotAfter is false", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/browser/act")) {
        return jsonResponse({ available: true, ok: true, url: "http://127.0.0.1:3000/" });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    }) as unknown as typeof fetch;

    const mockApi = await loadExtension();
    const result = (await mockApi._toolExecutors.get("herman_browser_interact")?.(
      "call-1",
      { steps: [{ action: "press", key: "Enter" }], screenshotAfter: false },
      undefined,
      undefined,
      {},
    )) as { content: Array<{ type: string }> };

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });
});
