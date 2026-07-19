import arkenv from "arkenv";

const schema = {
  HERMAN_SERVER_URL: "string = ''",
  HERMAN_SESSION_TOKEN: "string = ''",
  HERMAN_CLIENT_VERSION: "string = '0.0.1'",
  HERMAN_TAB_ID: "string = ''",
  HERMAN_PINNED_PROVIDERS: "string = '{}'",
  HERMAN_MODE: "'rookie' | 'normal' | '' = ''",
  HERMAN_AGENT_LOG_LEVEL: "'info' | 'debug' | 'trace' | 'warning' | 'error' | 'fatal' = 'info'",
  HERMAN_HOST_BRIDGE_URL: "string = ''",
  HERMAN_HOST_BRIDGE_TOKEN: "string = ''",
} as const;

/**
 * Read the current environment. Evaluated on every access (not frozen at
 * module load) so test files that set HERMAN_* vars before dynamically
 * importing modules see their own values regardless of import order.
 * In production the env is static per process, so repeated reads agree.
 */
function readEnv() {
  return arkenv(schema);
}

export const config = {
  get serverUrl() {
    return readEnv().HERMAN_SERVER_URL;
  },
  get sessionToken() {
    return readEnv().HERMAN_SESSION_TOKEN;
  },
  get clientVersion() {
    return readEnv().HERMAN_CLIENT_VERSION;
  },
  get tabId() {
    return readEnv().HERMAN_TAB_ID;
  },
  get pinnedProviders() {
    return readEnv().HERMAN_PINNED_PROVIDERS;
  },
  get mode(): "rookie" | "normal" | undefined {
    return (readEnv().HERMAN_MODE || undefined) as "rookie" | "normal" | undefined;
  },
  get logLevel() {
    return readEnv().HERMAN_AGENT_LOG_LEVEL;
  },
  get hostBridgeUrl() {
    return readEnv().HERMAN_HOST_BRIDGE_URL;
  },
  get hostBridgeToken() {
    return readEnv().HERMAN_HOST_BRIDGE_TOKEN;
  },
} as const;

export function requireServerUrl(): string {
  if (!config.serverUrl) {
    throw new Error("HERMAN_SERVER_URL is required");
  }
  return config.serverUrl;
}
