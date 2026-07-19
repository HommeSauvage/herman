#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// In a compiled binary, import.meta.dir is the read-only virtual filesystem
// (/$bunfs/root). Fall back to dirname(process.execPath) so the standalone
// CLI path resolves to a real writable location (packages/agent/.pi-agent,
// same as dev). The desktop spawner always sets HERMAN_AGENT_DIR, so this
// fallback only matters for standalone CLI use.
const _scriptDir = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN")
  ? dirname(process.execPath)
  : import.meta.dir;

const PI_AGENT_DIR = process.env.HERMAN_AGENT_DIR
  ? resolve(process.env.HERMAN_AGENT_DIR)
  : resolve(join(_scriptDir, "..", ".pi-agent"));
mkdirSync(PI_AGENT_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
process.env.PI_CODING_AGENT_SESSION_DIR = join(PI_AGENT_DIR, "sessions");

import { getLogger } from "@logtape/logtape";
import { main } from "@earendil-works/pi-coding-agent";
import contextReporterExtension from "@herman/pi-context-reporter";

import { config } from "./env.js";
import hermanExtension from "./extensions/herman-extension.js";
import previewContextExtension from "./extensions/preview-context-extension.js";
import { configureLogging } from "./logging.js";

const logger = getLogger(["herman-agent", "cli"]);

await configureLogging();

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
    // hermanExtension replaces the system prompt in before_agent_start.
    // previewContextExtension must register after so its before_agent_start
    // appends the preview state block on top.
    extensionFactories: [hermanExtension, contextReporterExtension, previewContextExtension],
  });
  logger.info("Agent shutdown cleanly");
} catch (error) {
  logger.error("Agent startup or runtime failure", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  throw error;
}
