import arkenv from "arkenv";

const env = arkenv({
  HERMAN_SERVER_URL: "string = ''",
  HERMAN_SESSION_TOKEN: "string = ''",
  HERMAN_CLIENT_VERSION: "string = '0.0.1'",
  HERMAN_TAB_ID: "string = ''",
  HERMAN_PINNED_PROVIDERS: "string = '{}'",
});

export const config = {
  serverUrl: env.HERMAN_SERVER_URL,
  sessionToken: env.HERMAN_SESSION_TOKEN,
  clientVersion: env.HERMAN_CLIENT_VERSION,
  tabId: env.HERMAN_TAB_ID,
  pinnedProviders: env.HERMAN_PINNED_PROVIDERS,
} as const;

export function requireServerUrl(): string {
  if (!config.serverUrl) {
    throw new Error("HERMAN_SERVER_URL is required");
  }
  return config.serverUrl;
}
