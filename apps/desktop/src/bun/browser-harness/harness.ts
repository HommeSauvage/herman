import { join } from "node:path";
import type {
  BrowserActionStep,
  BrowserGotoResult,
  PreviewConsoleEntry,
} from "@herman/rpc/host-bridge";
import { getLogger } from "@logtape/logtape";
import {
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  chromium,
  type Page,
} from "playwright-core";

import { hermanDir } from "../app-paths.js";

export type { BrowserActionStep, BrowserGotoResult, PreviewConsoleEntry };

const logger = getLogger(["herman-desktop", "browser-harness"]);

const DEFAULT_SETTLE_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 15_000;
const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 60;
const MAX_TEXT_CHARS = 2_000;

type OwnerSession = {
  context: BrowserContext;
  page: Page;
};

export type BrowserHarnessDeps = {
  onConsole?: (ownerId: string, entry: PreviewConsoleEntry) => void;
};

export class BrowserHarness {
  private browser: Browser | undefined;
  private launchFailed = false;
  private readonly owners = new Map<string, OwnerSession>();
  private deps: BrowserHarnessDeps;

  constructor(deps?: BrowserHarnessDeps) {
    this.deps = deps ?? {};
  }

  /** Update deps on an existing singleton (e.g. wire console forwarding after construction). */
  setDeps(deps: BrowserHarnessDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  async isAvailable(): Promise<boolean> {
    const browser = await this.ensureBrowser();
    return browser != null;
  }

  async goto(
    ownerId: string,
    url: string,
    opts?: { settleMs?: number; timeoutMs?: number },
  ): Promise<BrowserGotoResult> {
    if (!isAllowedLocalUrl(url)) {
      return {
        ok: false,
        url,
        pageErrors: [
          "Navigation blocked: only http://127.0.0.1 and http://localhost URLs are allowed",
        ],
        consoleErrors: [],
      };
    }

    const session = await this.ensureOwner(ownerId);
    if (!session) {
      return unavailableGoto(url);
    }

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        consoleErrors.push(truncate(msg.text()));
      }
    };
    const onPageError = (err: Error) => {
      pageErrors.push(truncate(err.message));
    };

    session.page.on("console", onConsole);
    session.page.on("pageerror", onPageError);

    try {
      const response = await session.page.goto(url, {
        waitUntil: "load",
        timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      await sleep(opts?.settleMs ?? DEFAULT_SETTLE_MS);
      return {
        ok: true,
        ...(response ? { status: response.status() } : {}),
        url: session.page.url(),
        pageErrors,
        consoleErrors,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      pageErrors.push(truncate(detail));
      return {
        ok: false,
        url: session.page.url() || url,
        pageErrors,
        consoleErrors,
      };
    } finally {
      session.page.off("console", onConsole);
      session.page.off("pageerror", onPageError);
    }
  }

  async screenshot(
    ownerId: string,
    opts?: { fullPage?: boolean },
  ): Promise<{ data: string; mediaType: "image/jpeg" }> {
    const session = await this.ensureOwner(ownerId);
    if (!session) {
      return { data: "", mediaType: "image/jpeg" };
    }

    const buffer = await session.page.screenshot({
      type: "jpeg",
      quality: JPEG_QUALITY,
      fullPage: opts?.fullPage ?? false,
    });
    return { data: buffer.toString("base64"), mediaType: "image/jpeg" };
  }

  async act(
    ownerId: string,
    steps: BrowserActionStep[],
  ): Promise<{ ok: boolean; error?: string; url: string }> {
    const session = await this.ensureOwner(ownerId);
    if (!session) {
      return { ok: false, error: "Browser unavailable", url: "" };
    }

    try {
      for (const step of steps) {
        await runStep(session.page, step);
      }
      return { ok: true, url: session.page.url() };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: detail, url: session.page.url() };
    }
  }

  currentUrl(ownerId: string): string | undefined {
    const session = this.owners.get(ownerId);
    if (!session) return undefined;
    const url = session.page.url();
    return url && url !== "about:blank" ? url : undefined;
  }

  async dispose(ownerId: string): Promise<void> {
    const session = this.owners.get(ownerId);
    if (!session) return;
    this.owners.delete(ownerId);
    await session.context.close().catch((error) => {
      logger.debug("Failed to close browser context", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async disposeAll(): Promise<void> {
    const ownerIds = [...this.owners.keys()];
    await Promise.all(ownerIds.map((id) => this.dispose(id)));
    if (this.browser) {
      await this.browser.close().catch((error) => {
        logger.debug("Failed to close browser", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.browser = undefined;
    }
    this.launchFailed = false;
  }

  private async ensureOwner(ownerId: string): Promise<OwnerSession | undefined> {
    const existing = this.owners.get(ownerId);
    if (existing) return existing;

    const browser = await this.ensureBrowser();
    if (!browser) return undefined;

    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    this.wirePageEvents(ownerId, page);

    const session: OwnerSession = { context, page };
    this.owners.set(ownerId, session);
    return session;
  }

  private wirePageEvents(ownerId: string, page: Page): void {
    page.on("console", (msg) => {
      const entry = consoleMessageToEntry(msg, page.url());
      this.deps.onConsole?.(ownerId, entry);
    });
    page.on("pageerror", (err) => {
      const entry: PreviewConsoleEntry = {
        level: "error",
        message: truncate(err.message),
        ...(err.stack ? { stack: truncate(err.stack) } : {}),
        url: page.url(),
        ts: Date.now(),
      };
      this.deps.onConsole?.(ownerId, entry);
    });
  }

  private async ensureBrowser(): Promise<Browser | undefined> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = undefined;
    if (this.launchFailed) return undefined;

    const managed = await this.tryLaunchManaged();
    if (managed) {
      this.browser = managed;
      return managed;
    }

    const system = await this.tryLaunchSystemChrome();
    if (system) {
      this.browser = system;
      return system;
    }

    this.launchFailed = true;
    logger.warning("Browser harness unavailable: no managed Chromium or system Chrome");
    return undefined;
  }

  private async tryLaunchManaged(): Promise<Browser | undefined> {
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(hermanDir(), "browsers");
    const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    try {
      const browser = await chromium.launch({ headless: true });
      logger.info("Launched managed Chromium", { browsersPath });
      return browser;
    } catch (error) {
      logger.debug("Managed Chromium launch failed", {
        browsersPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      if (previous === undefined) {
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      } else {
        process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
      }
    }
  }

  private async tryLaunchSystemChrome(): Promise<Browser | undefined> {
    try {
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      logger.info("Launched system Chrome via Playwright channel");
      return browser;
    } catch (error) {
      logger.debug("System Chrome launch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

let singleton: BrowserHarness | undefined;

/**
 * Module singleton — lazy on first call.
 * When deps are passed, they are merged onto the singleton (safe if something
 * already constructed it without console wiring).
 */
export function getBrowserHarness(deps?: BrowserHarnessDeps): BrowserHarness {
  if (!singleton) {
    singleton = new BrowserHarness(deps);
  } else if (deps) {
    singleton.setDeps(deps);
  }
  return singleton;
}

function unavailableGoto(url: string): BrowserGotoResult {
  return {
    ok: false,
    url,
    pageErrors: ["Browser unavailable"],
    consoleErrors: [],
  };
}

function isAllowedLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

async function runStep(page: Page, step: BrowserActionStep): Promise<void> {
  switch (step.action) {
    case "click":
      await page.click(step.selector);
      return;
    case "fill":
      await page.fill(step.selector, step.text);
      return;
    case "press":
      await page.keyboard.press(step.key);
      return;
    case "scroll":
      await page.evaluate((y) => {
        window.scrollBy(0, y);
      }, step.y);
      return;
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown browser action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function consoleMessageToEntry(msg: ConsoleMessage, url: string): PreviewConsoleEntry {
  return {
    level: mapConsoleLevel(msg.type()),
    message: truncate(msg.text()),
    url,
    ts: Date.now(),
  };
}

function mapConsoleLevel(type: string): PreviewConsoleEntry["level"] {
  switch (type) {
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "debug":
      return "debug";
    default:
      return "log";
  }
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : text.slice(0, MAX_TEXT_CHARS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
