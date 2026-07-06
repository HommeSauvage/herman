import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  const token = await createSession();
  mkdirSync(join(STATE_PATH, ".."), { recursive: true });
  await Bun.write(STATE_PATH, JSON.stringify({ session: { token } }, null, 2));
  console.log(`Injected dev session into ${STATE_PATH}`);
  console.log(`Token: ${token.slice(0, 16)}...`);
}

injectSession().catch((err) => {
  console.error(err);
  process.exit(1);
});
