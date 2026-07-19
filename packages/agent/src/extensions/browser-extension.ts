import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BrowserActionStep,
  HostBridgeBrowserGoto,
  HostBridgeBrowserScreenshot,
} from "@herman/rpc/host-bridge";

import { config } from "../env.js";
import {
  createHostBridgeClient,
  HostBridgeRequestError,
  HostBridgeUnavailableError,
} from "../host-bridge/client.js";

const BROWSER_UNAVAILABLE =
  "The preview browser is not available right now — verify via server logs and code review instead; do not claim visual verification you didn't do.";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function isBrowserUnavailable(err: unknown): boolean {
  if (err instanceof HostBridgeUnavailableError) return true;
  if (err instanceof HostBridgeRequestError && err.code === "browser_unavailable") return true;
  return false;
}

function formatBrowseText(result: HostBridgeBrowserGoto): string {
  const status = result.status ?? "?";
  const pageErrors = result.pageErrors ?? [];
  const consoleErrors = result.consoleErrors ?? [];
  let text = `Loaded ${result.url} (HTTP ${status}). ${pageErrors.length} page errors, ${consoleErrors.length} console errors.`;
  const errors = [...pageErrors, ...consoleErrors];
  if (errors.length > 0) {
    text += `\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
  }
  return text;
}

function buildResultContent(
  text: string,
  shot?: HostBridgeBrowserScreenshot,
): { content: ContentBlock[]; details: Record<string, unknown> } {
  const content: ContentBlock[] = [{ type: "text", text }];
  if (shot?.data) {
    content.push({
      type: "image",
      data: shot.data,
      mimeType: shot.mediaType ?? "image/jpeg",
    });
  }
  return {
    content,
    details: { text, hasImage: Boolean(shot?.data) },
  };
}

function unavailableResult() {
  return {
    content: [{ type: "text" as const, text: BROWSER_UNAVAILABLE }],
    details: { error: "unavailable" },
  };
}

export default function browserExtension(pi: ExtensionAPI) {
  const client = createHostBridgeClient();

  // ── Tool: herman_browse ──
  pi.registerTool({
    name: "herman_browse",
    label: "Browse Preview",
    description:
      "Navigate the Herman preview browser to a path or URL and return a screenshot plus any page/console errors. Use to visually verify pages you build or change.",
    promptSnippet: "Open a preview page and return a screenshot for visual verification",
    promptGuidelines: [
      "Use herman_browse to see any page of the running preview with your own eyes — check every page you build or change.",
      "A screenshot showing a broken layout, missing styles, or an error page means the work is NOT done.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path relative to the preview primary URL (e.g. '/about'). Prefer this over url for in-app pages.",
        },
        url: {
          type: "string",
          description: "Absolute URL to open (overrides path when both are set).",
        },
        fullPage: {
          type: "boolean",
          description: "Capture a full-page screenshot instead of the viewport (default false).",
        },
      },
      required: [],
      additionalProperties: false,
    } as never,

    async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx: ExtensionContext) {
      const params = rawParams as { path?: string; url?: string; fullPage?: boolean };

      if (!client.isAvailable()) {
        return unavailableResult();
      }

      try {
        const gotoBody: { url?: string; path?: string } = {};
        if (params.url) gotoBody.url = params.url;
        else if (params.path) gotoBody.path = params.path;

        const result = await client.browserGoto(config.tabId, gotoBody);
        if (!result.available) {
          return unavailableResult();
        }

        const shot = await client.browserScreenshot(config.tabId, {
          fullPage: params.fullPage === true,
        });

        return buildResultContent(formatBrowseText(result), shot);
      } catch (err) {
        if (isBrowserUnavailable(err)) {
          return unavailableResult();
        }
        if (err instanceof HostBridgeRequestError) {
          return {
            content: [{ type: "text", text: `${BROWSER_UNAVAILABLE} (${err.code})` }],
            details: { error: err.code },
          };
        }
        return unavailableResult();
      }
    },
  });

  // ── Tool: herman_browser_interact ──
  pi.registerTool({
    name: "herman_browser_interact",
    label: "Interact with Preview Browser",
    description:
      "Run click/fill/press/scroll actions in the Herman preview browser, then optionally capture a screenshot. Use after herman_browse to exercise forms and UI flows.",
    promptSnippet:
      "Click, fill, press keys, or scroll in the preview browser and screenshot the result",
    promptGuidelines: [
      "Use herman_browser_interact to exercise UI flows you changed — do not claim a form or button works without running it.",
      "A screenshot showing a broken layout, missing styles, or an error page means the work is NOT done.",
    ],
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered browser actions to perform",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["click", "fill", "press", "scroll"] },
              selector: { type: "string", description: "CSS selector (click/fill)" },
              text: { type: "string", description: "Text to fill (fill)" },
              key: { type: "string", description: "Key to press (press)" },
              y: { type: "number", description: "Scroll Y offset (scroll)" },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
        screenshotAfter: {
          type: "boolean",
          description: "Capture a screenshot after the actions (default true)",
        },
      },
      required: ["steps"],
      additionalProperties: false,
    } as never,

    async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx: ExtensionContext) {
      const params = rawParams as { steps: BrowserActionStep[]; screenshotAfter?: boolean };
      const screenshotAfter = params.screenshotAfter !== false;

      if (!client.isAvailable()) {
        return unavailableResult();
      }

      try {
        const result = await client.browserAct(config.tabId, { steps: params.steps });
        if (!result.available) {
          return unavailableResult();
        }

        const text =
          `Completed ${params.steps.length} browser action(s)` +
          (result.url ? ` at ${result.url}` : "") +
          (result.ok ? "." : ` — failed${result.error ? `: ${result.error}` : "."}`);

        const shot = screenshotAfter ? await client.browserScreenshot(config.tabId) : undefined;

        return buildResultContent(text, shot);
      } catch (err) {
        if (isBrowserUnavailable(err)) {
          return unavailableResult();
        }
        if (err instanceof HostBridgeRequestError) {
          return {
            content: [{ type: "text", text: `${BROWSER_UNAVAILABLE} (${err.code})` }],
            details: { error: err.code },
          };
        }
        return unavailableResult();
      }
    },
  });
}
