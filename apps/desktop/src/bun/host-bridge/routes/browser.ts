import {
  type BrowserActionStep,
  HOST_BRIDGE_ROUTES,
  type HostBridgeBrowserAct,
  type HostBridgeBrowserGoto,
  type HostBridgeBrowserScreenshot,
} from "@herman/rpc/host-bridge";

import type { BrowserHarness } from "../../browser-harness/index.js";
import type { PreviewContextService } from "../../preview-context/service.js";
import { HostBridgeError, type HostBridgeRoute } from "../server.js";

export function browserRoutes(
  harness: BrowserHarness,
  previewContext: PreviewContextService,
): HostBridgeRoute[] {
  return [
    {
      method: "POST",
      pattern: HOST_BRIDGE_ROUTES.browserGoto(":tabId"),
      handler: async ({ params, body }) => {
        await assertBrowserAvailable(harness);
        const tabId = params.tabId as string;
        const url = resolveGotoUrl(tabId, body, previewContext);
        const result = await harness.goto(tabId, url);
        return { available: true, ...result } satisfies HostBridgeBrowserGoto;
      },
    },
    {
      method: "GET",
      pattern: HOST_BRIDGE_ROUTES.browserScreenshot(":tabId"),
      handler: async ({ params, query }) => {
        await assertBrowserAvailable(harness);
        const tabId = params.tabId as string;
        const fullPage = query.get("fullPage") === "true";
        const shot = await harness.screenshot(tabId, { fullPage });
        return {
          available: true,
          data: shot.data,
          mediaType: shot.mediaType,
          url: harness.currentUrl(tabId),
        } satisfies HostBridgeBrowserScreenshot;
      },
    },
    {
      method: "POST",
      pattern: HOST_BRIDGE_ROUTES.browserAct(":tabId"),
      handler: async ({ params, body }) => {
        await assertBrowserAvailable(harness);
        const tabId = params.tabId as string;
        const steps = parseActSteps(body);
        const result = await harness.act(tabId, steps);
        return {
          available: true,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          url: result.url,
        } satisfies HostBridgeBrowserAct;
      },
    },
  ];
}

async function assertBrowserAvailable(harness: BrowserHarness): Promise<void> {
  if (!(await harness.isAvailable())) {
    throw new HostBridgeError(503, "browser_unavailable", "Browser harness is not available");
  }
}

function resolveGotoUrl(
  tabId: string,
  body: unknown,
  previewContext: PreviewContextService,
): string {
  const parsed = asRecord(body);
  const url = typeof parsed?.url === "string" ? parsed.url.trim() : "";
  if (url) return url;

  const path = typeof parsed?.path === "string" ? parsed.path : undefined;
  if (path == null || path === "") {
    throw new HostBridgeError(400, "bad_request", "Missing 'url' or 'path' in request body");
  }

  const state = previewContext.getPreviewState(tabId);
  const primaryUrl = state.primaryUrl;
  if (!primaryUrl) {
    throw new HostBridgeError(404, "no_preview", "No preview URL available to resolve path");
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${primaryUrl.replace(/\/$/, "")}${normalized}`;
}

function parseActSteps(body: unknown): BrowserActionStep[] {
  const parsed = asRecord(body);
  const steps = parsed?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new HostBridgeError(400, "bad_request", "Missing or empty 'steps' array in request body");
  }
  for (const step of steps) {
    if (!isBrowserActionStep(step)) {
      throw new HostBridgeError(400, "bad_request", "Invalid browser action step");
    }
  }
  return steps as BrowserActionStep[];
}

function isBrowserActionStep(value: unknown): value is BrowserActionStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Record<string, unknown>;
  switch (step.action) {
    case "click":
      return typeof step.selector === "string";
    case "fill":
      return typeof step.selector === "string" && typeof step.text === "string";
    case "press":
      return typeof step.key === "string";
    case "scroll":
      return typeof step.y === "number" && Number.isFinite(step.y);
    default:
      return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
