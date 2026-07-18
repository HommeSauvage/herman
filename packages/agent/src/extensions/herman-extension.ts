import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { PROTECTED_PROVIDER_KEY_VARS } from "@herman/agent/protected-keys";
import {
  HERMAN_REFRESH_MODELS_MESSAGE,
  LEGACY_HERMAN_MODELS_CACHE_FILENAME,
  MODEL_CATALOG_FILENAME,
  type HermanModelEntry,
  type LegacyHermanModelsCacheFile,
  type ModelCatalogFile,
} from "@herman/rpc/agent";
import type { AdCampaign, AdPlacement } from "@herman/rpc/ads";
import { getLogger } from "@logtape/logtape";

import { config } from "../env.js";
import { buildPrompt } from "../prompts/index.js";

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

function modelCatalogPath(): string {
  return join(hermanAppDir(), MODEL_CATALOG_FILENAME);
}

function legacyModelsCachePath(): string {
  return join(hermanAppDir(), LEGACY_HERMAN_MODELS_CACHE_FILENAME);
}

type HermanModel = HermanModelEntry;

/**
 * Read the desktop-owned model catalog synchronously for cache-first provider
 * registration. Falls back to the legacy cache file (older extensions) and
 * migrates it. Returns undefined when nothing usable is on disk. Never
 * throws — a corrupt cache just means a slow (network) start.
 */
function readCatalogFromDisk(serverUrl: string): HermanModel[] | undefined {
  try {
    const path = modelCatalogPath();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelCatalogFile>;
      if (parsed.serverUrl === serverUrl && Array.isArray(parsed.herman)) {
        return parsed.herman;
      }
      return undefined;
    }
  } catch (error) {
    extLog("debug", "Failed to read model catalog cache", { error: String(error) });
    return undefined;
  }

  // Legacy migration: adopt the old extension-owned cache if present.
  try {
    const legacyPath = legacyModelsCachePath();
    if (!existsSync(legacyPath)) return undefined;
    const legacy = JSON.parse(readFileSync(legacyPath, "utf-8")) as LegacyHermanModelsCacheFile;
    if (legacy.serverUrl !== serverUrl || !Array.isArray(legacy.models)) return undefined;
    extLog("info", "Adopted legacy Herman models cache", { modelCount: legacy.models.length });
    return legacy.models;
  } catch (error) {
    extLog("debug", "Failed to read legacy models cache", { error: String(error) });
    return undefined;
  }
}

/**
 * Write fresh models to the shared catalog file, preserving the `custom`
 * section owned by the desktop. Called ONLY after a successful fetch — a
 * failed refresh must never remove previously cached models. Atomic via
 * tmp+rename so a concurrent desktop read never sees a torn file.
 */
function writeCatalogToDisk(serverUrl: string, models: HermanModel[]): void {
  try {
    const dir = hermanAppDir();
    mkdirSync(dir, { recursive: true });

    let custom: Record<string, string[]> = {};
    try {
      const path = modelCatalogPath();
      if (existsSync(path)) {
        const existing = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelCatalogFile>;
        if (existing.custom && typeof existing.custom === "object") {
          custom = existing.custom;
        }
      }
    } catch {
      // Corrupt existing file — overwrite with just our section.
    }

    const file: ModelCatalogFile = {
      version: 1,
      serverUrl,
      fetchedAt: new Date().toISOString(),
      herman: models,
      custom,
    };
    const path = modelCatalogPath();
    const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-model-catalog.json`);
    writeFileSync(tmpPath, JSON.stringify(file, null, 2));
    renameSync(tmpPath, path);

    // Migration cleanup: the shared catalog supersedes the legacy cache.
    try {
      rmSync(legacyModelsCachePath(), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  } catch (error) {
    extLog("debug", "Failed to persist model catalog", { error: String(error) });
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
  const models = payload.models ?? [];
  if (models.length === 0) {
    // The Herman proxy always serves at least one model — an empty list is a
    // misconfiguration, not a reason to wipe the on-disk cache.
    throw new Error("Herman server returned an empty model list");
  }
  return models;
}

/**
 * Fetch fresh models and persist them; fall back to the on-disk cache when
 * the fetch fails. Throws only when there is no cache to fall back to.
 */
async function loadModelsWithCache(): Promise<{ models: HermanModel[]; fromCache: boolean }> {
  try {
    const models = await fetchHermanModels();
    writeCatalogToDisk(serverBaseUrl(), models);
    return { models, fromCache: false };
  } catch (error) {
    const cached = readCatalogFromDisk(serverBaseUrl());
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
      name: model.name ?? model.id,
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
  /** Captured at session_start so background refreshes can push models_sync. */
  let sessionCtx: ExtensionContext | undefined;

  // ── Session info tool (live preview URL / project / worktree from host) ──
  // Round-trips via ctx.ui.editor with a sentinel envelope. Herman Desktop
  // intercepts silently and replies with JSON — no editor UI is shown.
  // Shapes MUST stay in sync with apps/desktop/src/shared/session-info-protocol.ts.

  const SESSION_INFO_SENTINEL = "__herman_session_info__";
  const SESSION_INFO_PROTOCOL_VERSION = 1;
  const SESSION_INFO_UNAVAILABLE =
    "Session info is only available inside Herman Desktop. Do not invent a localhost port or URL — tell the user you cannot see the live preview right now.";

  pi.registerTool({
    name: "herman_get_session_info",
    label: "Get Session Info",
    description:
      "Fetch the current Herman session's live project path, worktree, and preview URL/port from the desktop host. Call this before answering how to open or visit the site, or whenever you need the real localhost URL — preferred ports in herman.yaml/README may differ at runtime.",
    promptSnippet: "Get live preview URL, port, and project/worktree details for this Herman session",
    promptGuidelines: [
      "Call herman_get_session_info before giving the user any localhost link or telling them how to open the preview.",
      "Use the returned preview.primaryUrl (or a ready server url) — never invent ports from the manifest or docs.",
      "If preview is not ready or the tool returns an error, say so plainly; do not guess a URL.",
    ],
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    } as never,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      if (ctx.mode !== "rpc" || !ctx.hasUI) {
        return {
          content: [{ type: "text", text: SESSION_INFO_UNAVAILABLE }],
          details: { error: "unavailable" },
        };
      }

      const envelope = {
        [SESSION_INFO_SENTINEL]: true,
        version: SESSION_INFO_PROTOCOL_VERSION,
      };

      const responseText = await ctx.ui.editor(
        "Herman session info",
        JSON.stringify(envelope),
      );

      if (responseText === undefined || responseText === null) {
        return {
          content: [
            {
              type: "text",
              text: "Could not fetch session info from Herman Desktop. Do not invent a localhost URL — tell the user you cannot see the live preview right now.",
            },
          ],
          details: { error: "cancelled" },
        };
      }

      let parsed: Record<string, unknown> | undefined;
      try {
        const obj = JSON.parse(responseText) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          parsed = obj as Record<string, unknown>;
        }
      } catch {
        parsed = undefined;
      }

      if (!parsed || parsed[SESSION_INFO_SENTINEL] !== true) {
        return {
          content: [
            {
              type: "text",
              text: "Could not parse session info from Herman Desktop. Do not invent a localhost URL — tell the user you cannot see the live preview right now.",
            },
          ],
          details: { error: "parse_failed" },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        details: parsed,
      };
    },
  });

  const registerModels = (nextModels: HermanModel[]) => {
    hermanModels = nextModels;
    pi.registerProvider(HERMAN_PROVIDER, buildProviderConfig(hermanModels));
    extLog("info", "Registered Herman provider", {
      modelCount: hermanModels.length,
      baseUrl: proxyUrl(),
    });
  };

  function notifyModelsSync(ctx: ExtensionContext) {
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
  }

  /**
   * Silent background refresh after a cache-first startup. On success the
   * provider is re-registered and the shared cache file updated; on failure
   * the cached registration stays in place (the cache is never wiped).
   */
  async function refreshModelsInBackground() {
    try {
      const models = await fetchHermanModels();
      writeCatalogToDisk(serverBaseUrl(), models);
      registerModels(models);
      fetchError = undefined;
      extLog("info", "Refreshed Herman models in background", { modelCount: models.length });
      // The session may already have started with cached models — push the
      // fresh list so the UI and the model apply logic see it.
      if (sessionCtx) {
        notifyModelsSync(sessionCtx);
      }
    } catch (error) {
      extLog("info", "Background Herman models refresh failed; keeping cache", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function refreshModelsAndNotify(ctx: ExtensionContext) {
    if (!hermanEnabled) return;
    extLog("info", "Refreshing Herman models");
    try {
      const { models, fromCache } = await loadModelsWithCache();
      registerModels(models);
      notifyModelsSync(ctx);
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

    const cached = readCatalogFromDisk(serverBaseUrl());
    if (cached && cached.length > 0) {
      // Cache-first: register instantly (no network wait at spawn), then
      // refresh from the server in the background. The cache also feeds the
      // desktop catalog, so both processes agree on the model list.
      registerModels(cached);
      void refreshModelsInBackground();
    } else {
      try {
        const { models } = await loadModelsWithCache();
        registerModels(models);
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error);
        extLog("error", "Failed to fetch Herman models and no cache available", { error: fetchError });
        registerModels([]);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
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

  // ── System prompt injection (replaces pi default for both modes) ──
  // In rookie mode, the user is non-technical — we use a simplified prompt.
  // In normal mode, we use an OpenCode-inspired developer prompt.
  // Template-specific guidance from herman.yaml or HERMAN.md is appended
  // in both modes.

  pi.on("before_agent_start", async (event, ctx) => {
    const mode = config.mode === "rookie" ? "rookie" : "normal";
    const systemPrompt = buildPrompt({ mode, cwd: ctx.cwd, originalPrompt: event.systemPrompt });
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
    notifyModelsSync(ctx);
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
        registerModels(models);
        notifyModelsSync(ctx);
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
