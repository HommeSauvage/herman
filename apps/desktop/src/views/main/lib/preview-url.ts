/** Helpers for preview URL bar: fixed origin + editable path suffix. */

export function formatOriginDisplay(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

export function getPathSuffix(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search + u.hash;
    return path || "/";
  } catch {
    return "/";
  }
}

export function buildUrlWithPath(baseUrl: string, pathSuffix: string): string {
  const base = new URL(baseUrl);
  const raw = pathSuffix.trim() || "/";
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const next = new URL(normalized, base.origin);
  next.protocol = base.protocol;
  next.hostname = base.hostname;
  next.port = base.port;
  return next.href;
}

export function isSameOrigin(baseUrl: string, targetUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}
