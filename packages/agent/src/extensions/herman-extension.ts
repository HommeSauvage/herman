import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { PROTECTED_PROVIDER_KEY_VARS } from "@herman/agent/protected-keys";
import type { AdCampaign, AdPlacement } from "@herman/rpc/ads";

import { config } from "../env.js";

// Use console.error directly in the agent subprocess. LogTape may not be
// configured for our categories or may not flush before a crash, while stderr
// is captured line-by-line by the desktop process.
function extLog(level: "info" | "error", message: string, meta?: Record<string, unknown>) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.error(`[herman-extension] ${message}${suffix}`);
}

function summarizePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
  const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
  const system = payload.system;
  const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : undefined;
  return {
    model,
    messageCount: messages?.length,
    toolCount: tools?.length,
    hasSystem: system !== undefined,
    maxTokens,
  };
}

function redactToken(value: string): string {
  if (value.length <= 16) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

const HERMAN_PROVIDER = "herman";

function assertNoLocalKeys() {
  for (const key of PROTECTED_PROVIDER_KEY_VARS) {
    if (process.env[key]) {
      throw new Error(
        `Herman refuses to run with a local ${key}. All provider keys must stay on the Herman server.`,
      );
    }
  }
}

function serverBaseUrl(): string {
  return config.serverUrl.replace(/\/$/, "");
}

function proxyUrl(): string {
  return `${serverBaseUrl()}/api/agent/proxy`;
}

function modelsUrl(): string {
  return `${serverBaseUrl()}/api/agent/models`;
}

type HermanModel = {
  id: string;
  name: string;
  api?: "openai-completions" | "anthropic-messages";
  providerId?: string;
  compat?: {
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_tokens" | "max_completion_tokens";
  };
};

async function fetchHermanModels(): Promise<HermanModel[]> {
  extLog("info", "Fetching Herman models", { url: modelsUrl(), hasToken: !!config.sessionToken });
  const response = await fetch(modelsUrl(), {
    headers: {
      Authorization: `Bearer ${config.sessionToken}`,
      "X-Herman-Client-Version": config.clientVersion,
    },
  });

  extLog("info", "Models response", { status: response.status, ok: response.ok });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Herman server returned ${response.status} when fetching models: ${body.slice(0, 200)}`,
    );
  }

  const payload = (await response.json()) as { models?: HermanModel[] };
  extLog("info", "Models received", { count: payload.models?.length });
  return payload.models ?? [];
}

function buildProviderConfig(models: HermanModel[]): ProviderConfig {
  const apis = new Set(models.map((model) => model.api ?? "openai-completions"));
  const providerApi =
    apis.size === 1
      ? (apis.values().next().value as "openai-completions" | "anthropic-messages")
      : undefined;

  extLog("info", "Registering Herman provider", {
    baseUrl: proxyUrl(),
    tokenPreview: config.sessionToken ? redactToken(config.sessionToken) : undefined,
    apiKind: providerApi ?? "mixed",
    modelCount: models.length,
  });

  return {
    name: "Herman",
    baseUrl: proxyUrl(),
    apiKey: config.sessionToken,
    authHeader: true,
    ...(providerApi ? { api: providerApi } : {}),
    headers: {
      "X-Herman-Client-Version": config.clientVersion,
      ...(config.tabId ? { "X-Herman-Tab-Id": config.tabId } : {}),
      ...(config.pinnedProviders && config.pinnedProviders !== "{}"
        ? { "X-Herman-Pinned-Providers": config.pinnedProviders }
        : {}),
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api ?? providerApi ?? "openai-completions",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: model.compat ?? {},
    })),
  };
}

function sendModelsSync(
  ui: ExtensionUIContext,
  available: { provider: string; id: string }[],
  currentModelId?: string,
) {
  ui.notify(
    JSON.stringify({
      type: "models_sync",
      models: available.map((model) => `${model.provider}/${model.id}`),
      currentModel: currentModelId,
    }),
    "info",
  );
}

async function fetchAdCampaign(placement: AdPlacement): Promise<AdCampaign | undefined> {
  const url = `${serverBaseUrl()}/api/ads/next?placement=${encodeURIComponent(placement)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.sessionToken}`,
      "X-Herman-Client-Version": config.clientVersion,
    },
  });
  if (!response.ok) return undefined;
  const data = (await response.json()) as { campaign?: AdCampaign };
  return data.campaign;
}

async function sendAdEvent(ui: ExtensionUIContext, placement: AdPlacement) {
  if (!config.serverUrl) return;
  const campaign = await fetchAdCampaign(placement);
  if (!campaign) return;
  ui.notify(
    JSON.stringify({
      type: "herman/ad_event",
      placement,
      campaign,
    }),
    "info",
  );
}

async function selectDefaultModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  hermanModels: HermanModel[],
): Promise<string | undefined> {
  const current = ctx.model;
  if (current) {
    return `${current.provider}/${current.id}`;
  }

  const available = ctx.modelRegistry.getAvailable();
  const preferred =
    hermanModels.length > 0
      ? available.find((model) => model.provider === HERMAN_PROVIDER)
      : available[0];

  if (preferred) {
    await pi.setModel(preferred);
    return `${preferred.provider}/${preferred.id}`;
  }

  return undefined;
}

function shouldRefreshModels(status: number | null): boolean {
  return status === 403 || status === 503;
}

export default async function hermanExtension(pi: ExtensionAPI) {
  let hermanModels: HermanModel[] = [];
  let fetchError: string | undefined;
  const hermanEnabled = Boolean(config.serverUrl);

  if (hermanEnabled) {
    assertNoLocalKeys();

    const registerModels = (nextModels: HermanModel[]) => {
      hermanModels = nextModels;
      pi.registerProvider(HERMAN_PROVIDER, buildProviderConfig(hermanModels));
      extLog("info", "Registered Herman provider", {
        modelCount: hermanModels.length,
        baseUrl: proxyUrl(),
      });
    };

    try {
      registerModels(await fetchHermanModels());
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
      extLog("error", "Failed to fetch models from server", { error: fetchError });
      registerModels([]);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (fetchError) {
      extLog("error", "Session start with fetch error", { fetchError });
      ctx.ui.notify(
        JSON.stringify({
          type: "herman/agent_proxy_error",
          error: `Could not reach the Herman server. Make sure it is running and accessible.`,
          code: "server_unreachable",
        }),
        "error",
      );
    }

    const available = ctx.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
    }));

    const currentModelId = await selectDefaultModel(pi, ctx, hermanModels);
    extLog("info", "models_sync", {
      modelCount: available.length,
      currentModel: currentModelId,
      activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    });
    sendModelsSync(ctx.ui, available, currentModelId);
    await sendAdEvent(ctx.ui, "sidebar");
  });

  pi.on("agent_start", async (_event, ctx) => {
    await sendAdEvent(ctx.ui, "thinking_banner");
  });

  pi.on("agent_end", async (event, ctx) => {
    // Only deliver a native ad after a successful turn. Failed, aborted, or
    // errored turns should not append sponsored content to the conversation.
    const messages = event.messages as unknown[] | undefined;
    if (!messages || messages.length === 0) return;

    const hasError = messages.some((rawMessage) => {
      const message = rawMessage as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") return false;
      const stopReason = message.stopReason;
      const errorMessage = message.errorMessage;
      const role = message.role;
      return (
        stopReason === "error" ||
        stopReason === "aborted" ||
        typeof errorMessage === "string" ||
        role === "error"
      );
    });

    if (hasError) return;

    await sendAdEvent(ctx.ui, "native");
  });

  pi.on("model_select", async (_event, ctx) => {
    const available = ctx.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
    }));
    sendModelsSync(
      ctx.ui,
      available,
      ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    );
  });

  pi.on("message_end", async (event) => {
    const message = event.message as unknown as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") return;

    const stopReason = message.stopReason;
    const errorMessage = message.errorMessage;
    const hasError =
      stopReason === "error" || stopReason === "aborted" || typeof errorMessage === "string";

    extLog(hasError ? "error" : "info", "Assistant message ended", {
      stopReason,
      errorMessage,
      model: message.model,
      provider: message.provider,
      contentLength: Array.isArray(message.content) ? message.content.length : undefined,
    });
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!hermanEnabled) return event.payload;

    const payload = event.payload as Record<string, unknown> | undefined;

    let auth:
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
      | undefined;
    if (ctx.model) {
      try {
        auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      } catch (error) {
        auth = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    extLog("info", "Proxying request to Herman server", {
      url: proxyUrl(),
      ...summarizePayload(payload),
      authOk: auth?.ok,
      authError: auth && !auth.ok ? auth.error : undefined,
      hasAuthHeaders: auth?.ok ? !!auth.headers : undefined,
      hasApiKey: auth?.ok ? !!auth.apiKey : undefined,
    });

    return event.payload;
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (!hermanEnabled) return;

    extLog("info", "Herman server response", {
      status: event.status,
      url: proxyUrl(),
    });

    if (event.status >= 200 && event.status < 300) {
      const providerId = event.headers?.["x-herman-provider-id"];
      if (providerId) {
        ctx.ui.notify(
          JSON.stringify({
            type: "herman/provider_pinned",
            modelName: ctx.model?.id,
            providerId,
          }),
          "info",
        );
      }
      return;
    }

    const error =
      event.status === 0 || event.status === null
        ? "Could not reach the Herman server. Make sure the server is running."
        : event.status === 401
          ? "Your session is not authorized. Sign in again to continue."
          : event.status === 503
            ? "This model is not available right now. Choose a different model and try again."
            : `Herman server returned ${event.status}`;

    const code =
      event.status === 0 || event.status === null
        ? "server_unreachable"
        : event.status === 401
          ? "unauthorized"
          : event.status === 503
            ? "no_provider"
            : "proxy_error";

    extLog("error", "Herman server proxy error", { status: event.status, code });

    // Notify immediately so the error event arrives before the agent emits
    // agent_end for the failed attempt.  Delaying the notify behind an async
    // model refresh causes the error to land after a retry agent_start, which
    // confuses the desktop into showing Idle while the agent keeps working.
    ctx.ui.notify(
      JSON.stringify({
        type: "herman/agent_proxy_error",
        error,
        code,
      }),
      "error",
    );

    // Model refresh happens after the notify — it's informational and must not
    // block the error delivery.
    if (shouldRefreshModels(event.status)) {
      try {
        const refreshed = await fetchHermanModels();
        hermanModels = refreshed;
        pi.registerProvider(HERMAN_PROVIDER, buildProviderConfig(hermanModels));
        const available = ctx.modelRegistry.getAvailable().map((model) => ({
          provider: model.provider,
          id: model.id,
        }));
        sendModelsSync(
          ctx.ui,
          available,
          ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        );
        extLog("info", "Refreshed Herman models after proxy failure", {
          status: event.status,
          modelCount: refreshed.length,
        });
      } catch (refreshError) {
        extLog("error", "Failed to refresh models after proxy failure", {
          status: event.status,
          error: refreshError instanceof Error ? refreshError.message : String(refreshError),
        });
      }
    }
  });
}
