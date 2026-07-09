import { getLogger } from "@logtape/logtape";
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

import { config } from "../env.js";
import { exchangeDeviceToken } from "./herman-api.js";
import type { DeviceCodeResponse, DeviceTokenResponse } from "../shared/rpc.js";

const logger = getLogger(["herman-desktop", "activation"]);

const authClient = createAuthClient({
  baseURL: config.authUrl,
  plugins: [deviceAuthorizationClient()],
});

const CLIENT_ID = "herman-desktop";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export async function startDeviceActivation(): Promise<DeviceCodeResponse> {
  logger.info("Requesting device code from auth server", { authUrl: config.authUrl });
  const { data, error } = await authClient.device.code({
    client_id: CLIENT_ID,
  });

  if (error || !data) {
    const message = error?.error_description ?? "Device code request failed";
    logger.error("Device code request failed", { error: error?.error, message });
    throw new Error(message);
  }

  logger.info("Device code received", { verificationUri: data.verification_uri });
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

export async function checkDeviceActivation(
  deviceCode: string,
): Promise<DeviceTokenResponse> {
  logger.debug("Polling device token endpoint");
  const { data, error } = await authClient.device.token({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: CLIENT_ID,
  });

  if (data?.access_token) {
    logger.info("Device authorized; exchanging for Herman session");
    const response = await exchangeDeviceToken(data.access_token);

    if (!response.ok) {
      logger.warning("Herman session exchange failed", { status: response.status });
      return { status: "unauthorized" };
    }

    const body = await response.json();
    if (!body.accessToken) {
      logger.error("Herman session exchange returned no token");
      return { status: "error", error: "Exchange returned no token" };
    }

    logger.info("Herman session token received");
    return { status: "authorized", accessToken: body.accessToken };
  }

  if (error) {
    logger.debug("Device token endpoint returned error", { error: error.error });
    switch (error.error) {
      case "authorization_pending":
      case "slow_down":
        return { status: "pending" };
      case "access_denied":
      case "expired_token":
        return { status: "unauthorized" };
      default:
        return {
          status: "error",
          error: error.error_description ?? error.error,
        };
    }
  }

  return { status: "pending" };
}
