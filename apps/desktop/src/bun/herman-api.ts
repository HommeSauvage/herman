import type { AdClickReport, AdImpressionReport } from "@herman/rpc/ads";
import { config } from "../env.js";

function apiUrl(path: string): string {
  return `${config.serverUrl.replace(/\/$/, "")}${path}`;
}

async function apiFetch(
  path: string,
  token: string | undefined,
  init?: RequestInit,
): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : undefined),
      ...init?.headers,
    },
  });
}

export async function exchangeDeviceToken(accessToken: string): Promise<Response> {
  return apiFetch("/auth/device/exchange", accessToken, { method: "POST" });
}

export async function reportImpression(
  token: string,
  params: AdImpressionReport,
): Promise<Response> {
  return apiFetch("/api/ads/impression", token, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function reportAdClick(
  token: string,
  params: AdClickReport,
): Promise<Response> {
  return apiFetch("/api/ads/click", token, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function reportWindowFocus(
  token: string,
  params: { focused: boolean; visible: boolean; timestamp: number },
): Promise<Response> {
  return apiFetch("/analytics/window-focus", token, {
    method: "POST",
    body: JSON.stringify(params),
  });
}
