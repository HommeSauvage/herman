import { dispose, getLogger } from "@logtape/logtape";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { configureLogging } from "../src/logging.js";

const logger = getLogger(["herman-desktop", "inject-dev-session"]);

const ENV_FILE = "apps/herman-server/.env.development.local";
const CREATE_SESSION_SCRIPT = "apps/herman-server/scripts/create-test-session.ts";

function hermanDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "herman");
  }
  return join(homedir(), ".herman");
}

const STATE_PATH = join(hermanDir(), "state.json");

async function createSession(): Promise<string> {
  const output = await Bun.$`bun run --env-file=${ENV_FILE} ${CREATE_SESSION_SCRIPT}`.text();
  const token = output.trim().split("\n").pop() ?? "";
  if (!token) throw new Error("Failed to create Herman session");
  return token;
}

async function injectSession() {
  await configureLogging();
  try {
    const token = await createSession();
    mkdirSync(join(STATE_PATH, ".."), { recursive: true });
    await Bun.write(STATE_PATH, JSON.stringify({ session: { token } }, null, 2));
    logger.info("Injected dev session", { statePath: STATE_PATH });
    logger.info("Session token prefix", { tokenPrefix: `${token.slice(0, 16)}...` });
  } finally {
    await dispose();
  }
}

injectSession().catch((err) => {
  logger.error("Failed to inject dev session", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
