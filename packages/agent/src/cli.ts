#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PI_AGENT_DIR = process.env.HERMAN_AGENT_DIR
  ? resolve(process.env.HERMAN_AGENT_DIR)
  : resolve(join(import.meta.dir, "..", ".pi-agent"));
mkdirSync(PI_AGENT_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = join(PI_AGENT_DIR, "sessions");

import { main } from "@earendil-works/pi-coding-agent";

import { config } from "./env.js";
import hermanExtension from "./extensions/herman-extension.js";

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
      console.error("[herman-agent] Failed to parse settings.json, overwriting");
    }
  }

  const existing = (Array.isArray(settings.packages) ? settings.packages : []) as string[];
  const toAdd = sources.filter((s) => !existing.includes(s));

  if (toAdd.length === 0) return;

  settings.packages = [...existing, ...toAdd];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  console.error("[herman-agent] Registered bundled extensions:", toAdd);
}

ensureBundledExtensions(PI_AGENT_DIR, BUNDLED_EXTENSIONS);

console.error("[herman-agent] Starting agent", {
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

await main(args, {
  // Only herman-internal extension stays as an inline factory.
  // pi-rewind and pi-fff are auto-discovered from the agent settings.
  extensionFactories: [hermanExtension],
});
