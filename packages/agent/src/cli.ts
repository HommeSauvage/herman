#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PI_AGENT_DIR = process.env.HERMAN_AGENT_DIR
  ? resolve(process.env.HERMAN_AGENT_DIR)
  : resolve(join(import.meta.dir, "..", ".pi-agent"));
mkdirSync(PI_AGENT_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = join(PI_AGENT_DIR, "sessions");

import { getLogger } from "@logtape/logtape";
import { main } from "@earendil-works/pi-coding-agent";
import contextReporterExtension from "@herman/pi-context-reporter";

import { config } from "./env.js";
import hermanExtension from "./extensions/herman-extension.js";
import { configureLogging } from "./logging.js";

const logger = getLogger(["herman-agent", "cli"]);

/**
 * Extensions that herman bundles as packages. Pi auto-discovers and auto-installs
 * them from the agent settings, giving each its own node_modules so native
 * dependencies (e.g. fff's native binary) resolve correctly.
 */
const BUNDLED_EXTENSIONS = [
  "@bacnh85/pi-fff",
];

/**
 * Ensure bundled extension sources are registered in the agent settings.
 * Pi's PackageManager auto-installs missing packages on startup, so extensions
 * are available on the first run without manual `pi install` steps.
 */
function ensureBundledExtensions(agentDir: string, sources: string[]): void {
  const settingsPath = join(agentDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      logger.warning("Failed to parse settings.json, overwriting");
    }
  }

  const existing = (Array.isArray(settings.packages) ? settings.packages : []) as string[];
  const toAdd = sources.filter((s) => !existing.includes(s));

  // Older versions of this CLI registered `@herman/pi-context-reporter`
  // as a bundled extension. Pi's PackageManager would then run
  // `bun install` to fetch it, but that install emits ANSI-colored
  // progress to stdout — which the desktop's JSONL parser cannot
  // read. We now load the reporter via `extensionFactories` instead,
  // so strip the stale entry from `settings.json` to keep Pi quiet.
  const stale = "@herman/pi-context-reporter";
  const filtered = existing.filter((p) => p !== stale);

  if (toAdd.length === 0 && filtered.length === existing.length) return;

  settings.packages = [...filtered, ...toAdd];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  if (filtered.length !== existing.length) {
    logger.info("Removed stale bundled extension", { extension: stale });
  }
  if (toAdd.length > 0) {
    logger.info("Registered bundled extensions", { extensions: toAdd });
  }
}

await configureLogging();

ensureBundledExtensions(PI_AGENT_DIR, BUNDLED_EXTENSIONS);

logger.info("Starting agent", {
  serverUrl: config.serverUrl,
  hasSessionToken: !!config.sessionToken,
  clientVersion: config.clientVersion,
  piAgentDir: PI_AGENT_DIR,
});

function ensureRpcMode(args: string[]): string[] {
  const modeIdx = args.indexOf("--mode");
  if (modeIdx === -1) {
    return [...args, "--mode", "rpc"];
  }
  const next = [...args];
  next[modeIdx + 1] = "rpc";
  return next;
}

const args = ensureRpcMode(process.argv.slice(2));

try {
  await main(args, {
    // The Herman extensions should be loaded as inline factories. 
    // Other bundled extensions are auto-discovered from the agent settings,
    // Which pi will install when it starts.
    extensionFactories: [hermanExtension, contextReporterExtension],
  });
  logger.info("Agent shutdown cleanly");
} catch (error) {
  logger.error("Agent startup or runtime failure", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  throw error;
}
