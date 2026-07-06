import { getLogger } from "@logtape/logtape";
import type { Server } from "bun";

import type { OAuthCredential } from "../shared/rpc.js";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";

const logger = getLogger(["herman-desktop", "oauth"]);

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const ANTHROPIC_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export type OAuthFlowResult =
  | { status: "authorized"; credential: OAuthCredential }
  | { status: "error"; error: string };

export type OAuthFlow = {
  providerId: string;
  state: string;
  verifier: string;
  authUrl: string;
  server: Server<unknown>;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  result?: OAuthFlowResult;
  resolve: (value: OAuthFlowResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

const activeFlows = new Map<string, OAuthFlow>();

export type OAuthLoginStatus =
  | { status: "pending" }
  | { status: "authorized"; credential: OAuthCredential }
  | { status: "error"; error: string };

export interface OAuthProvider {
  readonly id: string;
  readonly name: string;
  readonly redirectUri: string;
  buildAuthUrl(state: { verifier: string; challenge: string }): Promise<string> | string;
  exchangeCode(
    code: string,
    state: string,
    verifier: string,
    redirectUri: string,
  ): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
}

async function postJson(url: string, body: Record<string, string | number>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseBody}`);
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    throw new Error(`Invalid JSON response: ${responseBody}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function tokenResponseToCredential(data: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): OAuthCredential {
  return {
    type: "oauth",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function exchangeAnthropicCode(
  code: string,
  _state: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthCredential> {
  const data = await postJson(ANTHROPIC_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: ANTHROPIC_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (
    typeof data !== "object" ||
    data === null ||
    !("access_token" in data) ||
    !("refresh_token" in data) ||
    !("expires_in" in data) ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new Error(`Unexpected token response: ${JSON.stringify(data)}`);
  }
  return tokenResponseToCredential(
    data as { access_token: string; refresh_token: string; expires_in: number },
  );
}

async function refreshAnthropicToken(credential: OAuthCredential): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("Missing refresh token for Anthropic OAuth");
  }
  const data = await postJson(ANTHROPIC_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: ANTHROPIC_CLIENT_ID,
    refresh_token: credential.refreshToken,
  });
  if (
    typeof data !== "object" ||
    data === null ||
    !("access_token" in data) ||
    !("refresh_token" in data) ||
    !("expires_in" in data) ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new Error(`Unexpected refresh response: ${JSON.stringify(data)}`);
  }
  return tokenResponseToCredential(
    data as { access_token: string; refresh_token: string; expires_in: number },
  );
}

const anthropicProvider: OAuthProvider = {
  id: "anthropic",
  name: "Anthropic (Claude Pro/Max)",
  redirectUri: REDIRECT_URI,
  buildAuthUrl({ verifier, challenge }) {
    const params = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: ANTHROPIC_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });
    return `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`;
  },
  exchangeCode: exchangeAnthropicCode,
  refresh: refreshAnthropicToken,
};

const providers = new Map<string, OAuthProvider>([[anthropicProvider.id, anthropicProvider]]);

export function getOAuthProvider(providerId: string): OAuthProvider | undefined {
  return providers.get(providerId);
}

export function registerOAuthProvider(provider: OAuthProvider): void {
  providers.set(provider.id, provider);
}

export async function refreshOAuthToken(
  providerId: string,
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  return provider.refresh(credential);
}

async function cleanupFlow(flow: OAuthFlow) {
  activeFlows.delete(flow.providerId);
  clearTimeout(flow.timeout);
  try {
    await flow.server.stop(true);
  } catch (error) {
    logger.debug("Error stopping OAuth callback server", { error: formatError(error) });
  }
}

function scheduleCleanup(flow: OAuthFlow, delayMs: number) {
  clearTimeout(flow.timeout);
  flow.timeout = setTimeout(() => cleanupFlow(flow), delayMs);
}

function settleFlow(flow: OAuthFlow, result: OAuthFlowResult) {
  if (flow.settled) return;
  flow.settled = true;
  flow.result = result;
  clearTimeout(flow.timeout);
  if (result.status === "error") {
    flow.reject(new Error(result.error));
  } else {
    flow.resolve(result);
  }
}

export async function startOAuthLogin(
  providerId: string,
): Promise<{ authUrl: string; state: string }> {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  const existing = activeFlows.get(providerId);
  if (existing) {
    return { authUrl: existing.authUrl, state: existing.state };
  }

  await cancelOAuthLogin(providerId);

  const { verifier, challenge } = await generatePKCE();
  const state = verifier;
  const authUrl = await provider.buildAuthUrl({ verifier, challenge });

  const server = Bun.serve({
    port: CALLBACK_PORT,
    hostname: CALLBACK_HOST,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== CALLBACK_PATH) {
        return new Response(oauthErrorHtml("Not found."), {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const flow = activeFlows.get(providerId);

      if (!flow) {
        return new Response(oauthErrorHtml("No active OAuth flow."), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (error) {
        settleFlow(flow, { status: "error", error: `Provider error: ${error}` });
        scheduleCleanup(flow, 30_000);
        return new Response(oauthErrorHtml("Authentication did not complete.", `Error: ${error}`), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (!code || !returnedState) {
        settleFlow(flow, { status: "error", error: "Missing authorization code or state." });
        scheduleCleanup(flow, 30_000);
        return new Response(oauthErrorHtml("Missing authorization code or state."), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (returnedState !== flow.state) {
        settleFlow(flow, { status: "error", error: "OAuth state mismatch." });
        scheduleCleanup(flow, 30_000);
        return new Response(oauthErrorHtml("State mismatch."), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      try {
        const credential = await provider.exchangeCode(
          code,
          returnedState,
          flow.verifier,
          provider.redirectUri,
        );
        settleFlow(flow, { status: "authorized", credential });
        scheduleCleanup(flow, 30_000);
        return new Response(
          oauthSuccessHtml("Authentication completed. You can close this window."),
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      } catch (error) {
        settleFlow(flow, { status: "error", error: formatError(error) });
        scheduleCleanup(flow, 30_000);
        return new Response(
          oauthErrorHtml("Failed to exchange authorization code.", formatError(error)),
          {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
    },
  });

  const { promise, resolve, reject } = Promise.withResolvers<OAuthFlowResult>();
  const timeout = setTimeout(() => {
    const flow = activeFlows.get(providerId);
    if (flow) {
      settleFlow(flow, { status: "error", error: "OAuth flow timed out." });
      scheduleCleanup(flow, 30_000);
    }
  }, OAUTH_TIMEOUT_MS);

  const flow: OAuthFlow = {
    providerId,
    state,
    verifier,
    authUrl,
    server,
    startedAt: Date.now(),
    timeout,
    resolve,
    reject,
    settled: false,
  };

  activeFlows.set(providerId, flow);

  promise.catch((error: Error) => {
    logger.debug("OAuth flow finished with error", { error: error.message });
  });

  logger.info("Started OAuth callback server", { providerId, redirectUri: provider.redirectUri });
  return { authUrl, state };
}

export async function pollOAuthLogin(providerId: string, state: string): Promise<OAuthLoginStatus> {
  const flow = activeFlows.get(providerId);
  if (!flow) {
    return { status: "error", error: "OAuth flow was cancelled or expired." };
  }
  if (flow.state !== state) {
    return { status: "error", error: "OAuth state mismatch." };
  }
  if (!flow.settled) {
    return { status: "pending" };
  }
  const result = flow.result;
  await cleanupFlow(flow);
  return result ?? { status: "error", error: "OAuth flow result is missing." };
}

export async function cancelOAuthLogin(providerId: string): Promise<void> {
  const flow = activeFlows.get(providerId);
  if (!flow) return;
  settleFlow(flow, { status: "error", error: "OAuth flow was cancelled." });
  await cleanupFlow(flow);
}

process.on("exit", async () => {
  for (const flow of activeFlows.values()) {
    try {
      await flow.server.stop(true);
    } catch {
      // Ignore during process exit.
    }
  }
  activeFlows.clear();
});
