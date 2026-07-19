import {
  type BrowserActionStep,
  HOST_BRIDGE_AUTH_SCHEME,
  HOST_BRIDGE_ROUTES,
  type HostBridgeBrowserAct,
  type HostBridgeBrowserGoto,
  type HostBridgeBrowserScreenshot,
  type HostBridgeErrorBody,
  type HostBridgeErrorCode,
  type HostBridgePreviewLogs,
  type HostBridgePreviewState,
  type HostBridgePublishingConfig,
  type HostBridgePublishingUpdate,
  type HostBridgeSessionInfo,
  type PreviewLogsQuery,
} from "@herman/rpc/host-bridge";

import { config } from "../env.js";

export class HostBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostBridgeUnavailableError";
  }
}

export class HostBridgeRequestError extends Error {
  constructor(
    message: string,
    public code: HostBridgeErrorCode,
    public status: number,
  ) {
    super(message);
    this.name = "HostBridgeRequestError";
  }
}

export type HostBridgeClient = {
  isAvailable(): boolean;
  getSessionInfo(tabId: string): Promise<HostBridgeSessionInfo>;
  getPreviewState(tabId: string): Promise<HostBridgePreviewState>;
  getPreviewLogs(tabId: string, query: PreviewLogsQuery): Promise<HostBridgePreviewLogs>;
  browserGoto(tabId: string, body: { url?: string; path?: string }): Promise<HostBridgeBrowserGoto>;
  browserScreenshot(
    tabId: string,
    opts?: { fullPage?: boolean },
  ): Promise<HostBridgeBrowserScreenshot>;
  browserAct(tabId: string, body: { steps: BrowserActionStep[] }): Promise<HostBridgeBrowserAct>;
  getPublishingConfig(tabId: string): Promise<HostBridgePublishingConfig>;
  updatePublishingConfig(
    tabId: string,
    update: HostBridgePublishingUpdate,
  ): Promise<HostBridgePublishingConfig>;
};

const DEFAULT_TIMEOUT_MS = 1500;
const LOGS_TIMEOUT_MS = 3000;
const BROWSER_GOTO_TIMEOUT_MS = 20_000;
const BROWSER_SCREENSHOT_TIMEOUT_MS = 10_000;
const BROWSER_ACT_TIMEOUT_MS = 20_000;
const STATE_MEMO_TTL_MS = 2000;

export function createHostBridgeClient(opts?: {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): HostBridgeClient {
  const baseUrl = opts?.baseUrl ?? config.hostBridgeUrl;
  const token = opts?.token ?? config.hostBridgeToken;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cachedState: { state: HostBridgePreviewState; at: number } | undefined;

  function isAvailable(): boolean {
    return Boolean(baseUrl && token);
  }

  function mapFetchError(err: unknown): never {
    if (err instanceof HostBridgeRequestError) throw err;
    if (err instanceof HostBridgeUnavailableError) throw err;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new HostBridgeUnavailableError("Host bridge request timed out");
    }
    throw new HostBridgeUnavailableError(
      `Host bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  async function throwForFailedResponse(response: Response): Promise<never> {
    let body: HostBridgeErrorBody | undefined;
    try {
      body = (await response.json()) as HostBridgeErrorBody;
    } catch {
      // ignore parse errors
    }
    throw new HostBridgeRequestError(
      body?.error ?? `Host bridge returned ${response.status}`,
      body?.code ?? "internal",
      response.status,
    );
  }

  async function request<T>(path: string, timeoutOverride?: number): Promise<T> {
    if (!isAvailable()) {
      throw new HostBridgeUnavailableError("Host bridge not available (missing env vars)");
    }
    const url = `${baseUrl}${path}`;

    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `${HOST_BRIDGE_AUTH_SCHEME} ${token}`,
        },
        signal: AbortSignal.timeout(timeoutOverride ?? timeoutMs),
      });

      if (!response.ok) {
        await throwForFailedResponse(response);
      }

      return (await response.json()) as T;
    } catch (err) {
      mapFetchError(err);
    }
  }

  async function postJson<T>(path: string, body: unknown, timeoutOverride?: number): Promise<T> {
    if (!isAvailable()) {
      throw new HostBridgeUnavailableError("Host bridge not available (missing env vars)");
    }
    const url = `${baseUrl}${path}`;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `${HOST_BRIDGE_AUTH_SCHEME} ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutOverride ?? timeoutMs),
      });

      if (!response.ok) {
        await throwForFailedResponse(response);
      }

      return (await response.json()) as T;
    } catch (err) {
      mapFetchError(err);
    }
  }

  return {
    isAvailable,

    async getSessionInfo(tabId: string): Promise<HostBridgeSessionInfo> {
      return request(HOST_BRIDGE_ROUTES.sessionInfo(tabId));
    },

    async getPreviewState(tabId: string): Promise<HostBridgePreviewState> {
      const now = Date.now();
      if (cachedState && now - cachedState.at < STATE_MEMO_TTL_MS) {
        return cachedState.state;
      }
      const state = await request<HostBridgePreviewState>(HOST_BRIDGE_ROUTES.previewState(tabId));
      cachedState = { state, at: now };
      return state;
    },

    async getPreviewLogs(tabId: string, query: PreviewLogsQuery): Promise<HostBridgePreviewLogs> {
      const params = new URLSearchParams();
      params.set("environment", query.environment);
      if (query.serverId) params.set("serverId", query.serverId);
      if (query.maxEntries != null) params.set("maxEntries", String(query.maxEntries));
      if (query.maxLinesBeforeAfter != null)
        params.set("maxLinesBeforeAfter", String(query.maxLinesBeforeAfter));
      return request(
        `${HOST_BRIDGE_ROUTES.previewLogs(tabId)}?${params.toString()}`,
        LOGS_TIMEOUT_MS,
      );
    },

    async browserGoto(
      tabId: string,
      body: { url?: string; path?: string },
    ): Promise<HostBridgeBrowserGoto> {
      return postJson(HOST_BRIDGE_ROUTES.browserGoto(tabId), body, BROWSER_GOTO_TIMEOUT_MS);
    },

    async browserScreenshot(
      tabId: string,
      opts?: { fullPage?: boolean },
    ): Promise<HostBridgeBrowserScreenshot> {
      const path = HOST_BRIDGE_ROUTES.browserScreenshot(tabId);
      const qs = opts?.fullPage ? "?fullPage=true" : "";
      return request(`${path}${qs}`, BROWSER_SCREENSHOT_TIMEOUT_MS);
    },

    async browserAct(
      tabId: string,
      body: { steps: BrowserActionStep[] },
    ): Promise<HostBridgeBrowserAct> {
      return postJson(HOST_BRIDGE_ROUTES.browserAct(tabId), body, BROWSER_ACT_TIMEOUT_MS);
    },

    async getPublishingConfig(tabId: string): Promise<HostBridgePublishingConfig> {
      return request(HOST_BRIDGE_ROUTES.publishingConfig(tabId));
    },

    async updatePublishingConfig(
      tabId: string,
      update: HostBridgePublishingUpdate,
    ): Promise<HostBridgePublishingConfig> {
      return postJson(HOST_BRIDGE_ROUTES.publishingConfig(tabId), update);
    },
  };
}
