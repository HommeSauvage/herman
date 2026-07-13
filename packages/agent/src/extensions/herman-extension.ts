import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { PROTECTED_PROVIDER_KEY_VARS } from "@herman/agent/protected-keys";
import { HERMAN_REFRESH_MODELS_MESSAGE } from "@herman/rpc/agent";
import type { AdCampaign, AdPlacement } from "@herman/rpc/ads";
import { getLogger } from "@logtape/logtape";

import { config } from "../env.js";

const logger = getLogger(["herman-agent", "extension"]);

function extLog(level: "info" | "error" | "debug", message: string, meta?: Record<string, unknown>) {
  if (level === "error") {
    logger.error(message, meta ?? {});
    return;
  }
  if (level === "debug") {
    logger.debug(message, meta ?? {});
    return;
  }
  logger.debug(message, meta ?? {});
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

function hermanAppDir(): string {
  if (process.env.HERMAN_APP_DIR) return process.env.HERMAN_APP_DIR;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "herman");
  }
  return join(homedir(), ".herman");
}

function modelsCachePath(): string {
  return join(hermanAppDir(), "herman-models-cache.json");
}

type HermanModel = {
  id: string;
  name: string;
  api?: "openai-completions" | "anthropic-messages";
  providerId?: string;
  contextWindow?: number;
  maxTokens?: number;
  compat?: {
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_tokens" | "max_completion_tokens";
  };
};

type ModelsCache = {
  serverUrl: string;
  fetchedAt: string;
  models: HermanModel[];
};

function loadCachedModels(serverUrl: string): HermanModel[] | undefined {
  try {
    const path = modelsCachePath();
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf-8");
    const cache = JSON.parse(raw) as ModelsCache;
    if (cache.serverUrl !== serverUrl) return undefined;
    if (!Array.isArray(cache.models)) return undefined;
    return cache.models;
  } catch (error) {
    extLog("debug", "Failed to load cached Herman models", { error: String(error) });
    return undefined;
  }
}

function saveCachedModels(serverUrl: string, models: HermanModel[]): void {
  try {
    const dir = hermanAppDir();
    mkdirSync(dir, { recursive: true });
    const cache: ModelsCache = { serverUrl, fetchedAt: new Date().toISOString(), models };
    writeFileSync(modelsCachePath(), JSON.stringify(cache, null, 2));
  } catch (error) {
    extLog("debug", "Failed to save cached Herman models", { error: String(error) });
  }
}

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

async function loadModelsWithCache(): Promise<{ models: HermanModel[]; fromCache: boolean }> {
  try {
    const models = await fetchHermanModels();
    saveCachedModels(config.serverUrl, models);
    return { models, fromCache: false };
  } catch (error) {
    const cached = loadCachedModels(config.serverUrl);
    if (cached && cached.length > 0) {
      extLog("info", "Loaded Herman models from cache", { modelCount: cached.length });
      return { models: cached, fromCache: true };
    }
    throw error;
  }
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
      contextWindow: model.contextWindow ?? 1_000_000,
      maxTokens: model.maxTokens ?? 128_000,
      compat: model.compat ?? {},
    })),
  };
}

function sortAvailableHermanFirst(
  available: { provider: string; id: string; contextWindow?: number; maxTokens?: number }[],
) {
  return [...available].sort((a, b) => {
    const aHerman = a.provider === HERMAN_PROVIDER ? -1 : 1;
    const bHerman = b.provider === HERMAN_PROVIDER ? -1 : 1;
    if (aHerman !== bHerman) return aHerman - bHerman;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

function sendModelsSync(
  ui: ExtensionUIContext,
  available: { provider: string; id: string; contextWindow: number; maxTokens?: number }[],
  currentModelId?: string,
) {
  const sorted = sortAvailableHermanFirst(available);
  const modelMetadata: Record<string, { contextWindow: number; maxTokens?: number }> = {};
  for (const model of sorted) {
    if (typeof model.contextWindow !== "number" || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      continue;
    }
    modelMetadata[`${model.provider}/${model.id}`] = {
      contextWindow: model.contextWindow,
      ...(typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    };
  }
  const payload: Record<string, unknown> = {
    type: "models_sync",
    models: sorted.map((model) => `${model.provider}/${model.id}`),
    currentModel: currentModelId,
  };
  if (Object.keys(modelMetadata).length > 0) {
    payload.modelMetadata = modelMetadata;
  }
  ui.notify(JSON.stringify(payload), "info");
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
) : Promise<string | undefined> {
  const current = ctx.model;
  const available = ctx.modelRegistry.getAvailable();

  // When Herman is enabled and has models, prefer the first Herman model
  // over whatever pi defaulted to (e.g. anthropic).  But never override an
  // already-active herman model — the user may have selected it explicitly.
  if (hermanModels.length > 0) {
    const alreadyHerman = current?.provider === HERMAN_PROVIDER;
    if (!alreadyHerman) {
      const preferred = available.find(
        (model) =>
          model.provider === HERMAN_PROVIDER &&
          model.id === hermanModels[0]!.id,
      );
      if (preferred) {
        await pi.setModel(preferred);
        return `${preferred.provider}/${preferred.id}`;
      }
    }
  }

  // Fall back to whatever pi already set (e.g. from a custom configured provider).
  if (current) {
    return `${current.provider}/${current.id}`;
  }

  // Last resort: pick the first available model.
  if (available[0]) {
    await pi.setModel(available[0]);
    return `${available[0].provider}/${available[0].id}`;
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

  const registerModels = (nextModels: HermanModel[]) => {
    hermanModels = nextModels;
    pi.registerProvider(HERMAN_PROVIDER, buildProviderConfig(hermanModels));
    extLog("info", "Registered Herman provider", {
      modelCount: hermanModels.length,
      baseUrl: proxyUrl(),
    });
  };

  async function refreshModelsAndNotify(ctx: ExtensionContext) {
    if (!hermanEnabled) return;
    extLog("info", "Refreshing Herman models");
    try {
      const { models, fromCache } = await loadModelsWithCache();
      hermanModels = models;
      pi.registerProvider(HERMAN_PROVIDER, buildProviderConfig(hermanModels));
      const available = ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
      sendModelsSync(
        ctx.ui,
        available,
        ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      );
      extLog("info", "Herman models refreshed", {
        modelCount: hermanModels.length,
        fromCache,
      });
    } catch (error) {
      extLog("error", "Failed to refresh Herman models", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hermanEnabled) {
    assertNoLocalKeys();

    try {
      const { models } = await loadModelsWithCache();
      registerModels(models);
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
      extLog("error", "Failed to fetch Herman models and no cache available", { error: fetchError });
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
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
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

  // ── Rookie mode system prompt injection ──────────────────────────
  // In rookie mode, the user is non-technical. We prepend behavioral
  // instructions and append any template-specific systemPromptHint
  // from the project's herman.json.

  const ROOKIE_INSTRUCTIONS = `
<rookie_mode>
You are speaking to a non-technical user who may not understand code,
programming concepts, frameworks, or development terminology (unless they state otherwise).

CRITICAL RULES:
- NEVER ask the user to choose between technical implementation
  alternatives (e.g. "should I refactor X or rewrite Y?", "do you
  prefer CSS modules or styled-components?"). You MUST make ALL
  technical decisions yourself and pick the best approach.
- NEVER ask "what do you prefer?" or "which approach?" about
  implementation details. Just pick the simplest, most reliable
  solution and do it.
- When you need to clarify requirements, ask plain, non-technical
  questions about WHAT they want the site to do or look like, not
  HOW to build it. Use everyday language.
- Explain what you're doing in simple terms. Avoid jargon like
  "component", "refactor", "state management", "bundler", etc.
  Say "I'll add a section for customer reviews" instead of
  "I'll create a Testimonials component with a data fetch hook."
- If something goes wrong, fix it without burdening the user with
  debugging details or error messages.
- When multiple valid approaches exist, pick the SIMPLEST and most
  maintainable one. Optimize for the user's experience, not for
  technical elegance.
- The user's time and confidence are more important than technical
  perfection. Ship something good and iterate.
- If a db migration is needed, you can run it, to undo, just change 
  the files needed to migrate and run the migration again.
</rookie_mode>
`;

  pi.on("before_agent_start", async (event, ctx) => {
    if (config.mode !== "rookie") return;

    let systemPrompt = ROOKIE_INSTRUCTIONS + event.systemPrompt;

    // Load template-specific hint from herman.json, if present
    try {
      const hermanJsonPath = join(ctx.cwd, "herman.json");
      if (existsSync(hermanJsonPath)) {
        const raw = readFileSync(hermanJsonPath, "utf-8");
        const herman = JSON.parse(raw) as { systemPromptHint?: string };
        if (herman.systemPromptHint) {
          systemPrompt += `\n\n<template_instructions>\n${herman.systemPromptHint}\n</template_instructions>`;
        }
      }
    } catch {
      // herman.json may not exist or be invalid — skip template hint
    }

    return { systemPrompt };
  });

  pi.on("input", async (event, _ctx) => {
    if (event.text === HERMAN_REFRESH_MODELS_MESSAGE) {
      await refreshModelsAndNotify(_ctx);
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("model_select", async (_event, ctx) => {
    const available = ctx.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
    sendModelsSync(
      ctx.ui,
      available,
      ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    );
  });

  // Note: the `herman/context_usage` event used to be emitted from this
  // `context` event. It's been superseded by `herman/context_report`,
  // which is published by the dedicated `@herman/pi-context-reporter`
  // extension (bundled alongside this one). The reporter streams
  // cumulative totals + a live per-turn output estimate, and uses
  // `getContextUsage()` itself for the gauge anchor — so the legacy
  // payload adds no signal that the reporter doesn't already provide.
  pi.on("context", async (event) => {
    // The context event allows message mutation; we only observe.
    return { messages: event.messages };
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
        const { models, fromCache } = await loadModelsWithCache();
        hermanModels = models;
        pi.registerProvider(HERMAN_PROVIDER, buildProviderConfig(hermanModels));
        const available = ctx.modelRegistry.getAvailable().map((model) => ({
          provider: model.provider,
          id: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }));
        sendModelsSync(
          ctx.ui,
          available,
          ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        );
        extLog("info", "Refreshed Herman models after proxy failure", {
          status: event.status,
          modelCount: hermanModels.length,
          fromCache,
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
