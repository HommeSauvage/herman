#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
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
import piRewindExtension from "pi-rewind/src/index";
import piFffExtension from "@bacnh85/pi-fff/extensions/index";

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

const args = ensureRpcMode([...process.argv.slice(2), "--no-extensions"]);

await main(args, {
  extensionFactories: [hermanExtension, piRewindExtension, piFffExtension],
});
