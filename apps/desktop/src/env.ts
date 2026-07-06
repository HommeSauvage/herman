import arkenv from "arkenv";
import { type } from "arktype";

const env = arkenv({
  HERMAN_SERVER_URL: "string = 'http://localhost:4000'",
  BETTER_AUTH_URL: "string = 'http://localhost:3000'",
  HERMAN_DESKTOP_DEV_URL: "string = ''",
  HERMAN_DESKTOP_LOG_LEVEL: "'info' | 'debug' | 'trace' | 'warning' | 'error' | 'fatal' = 'info'",
  HERMAN_DESKTOP_LOG_FILE: type("string").or(type("boolean")).default(false),
  HERMAN_DESKTOP_VERBOSE_AGENT_RPC: type("boolean").default(false),
  HERMAN_DESKTOP_UPDATE_BASE_URL: "string = ''",
  HERMAN_AGENT_PATH: "string = ''",
  ENABLE_EMAIL_AUTH: type("'true' | 'false' | '1' | '0'").default("false"),
});

export const config = {
  serverUrl: env.HERMAN_SERVER_URL,
  authUrl: env.BETTER_AUTH_URL.replace(/\/$/, ""),
  devUrl: env.HERMAN_DESKTOP_DEV_URL,
  updateBaseUrl: env.HERMAN_DESKTOP_UPDATE_BASE_URL,
  agentPath: env.HERMAN_AGENT_PATH,
  logLevel: env.HERMAN_DESKTOP_LOG_LEVEL,
  logFile: env.HERMAN_DESKTOP_LOG_FILE,
  verboseAgentRpc: env.HERMAN_DESKTOP_VERBOSE_AGENT_RPC,
  enableEmailAuth: env.ENABLE_EMAIL_AUTH === "true" || env.ENABLE_EMAIL_AUTH === "1",
} as const;
