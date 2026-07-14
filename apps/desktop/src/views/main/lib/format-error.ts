/**
 * Format a raw error string into a human-readable message.
 *
 * Handles common provider error shapes:
 * - Full JSON objects like `{"error":{"type":"...","message":"..."}}`
 * - Status-code prefixes like `401 {"type":"error", ...}`
 * - Plain strings are returned unchanged.
 */
export function formatErrorMessage(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();

  // Try parsing the whole thing as JSON.
  const full = tryExtract(trimmed);
  if (full) return full;

  // Try a status-code prefix followed by JSON (e.g. "401 {...}").
  const match = trimmed.match(/^(\d{3})(?:\s+|-)?(.+)$/s);
  if (match) {
    const status = match[1];
    const rest = match[2].trim();
    const extracted = tryExtract(rest, status);
    if (extracted) return extracted;
    return `${status} ${rest}`;
  }

  return raw;
}

function tryExtract(text: string, status?: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return extractMessage(parsed, status);
  } catch {
    return undefined;
  }
}

function extractMessage(
  parsed: unknown,
  status?: string,
): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;

  let type: string | undefined;
  let message: string | undefined;
  const statusCode =
    status ??
    (typeof obj.status === "number"
      ? String(obj.status)
      : typeof obj.status_code === "number"
        ? String(obj.status_code)
        : typeof obj.code === "number"
          ? String(obj.code)
          : undefined);

  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    type =
      typeof err.type === "string"
        ? err.type
        : typeof err.code === "string"
          ? err.code
          : undefined;
    message =
      typeof err.message === "string"
        ? err.message
        : typeof err.description === "string"
          ? err.description
          : typeof err.error === "string"
            ? err.error
            : undefined;
  } else {
    type = typeof obj.type === "string" ? obj.type : undefined;
    message =
      typeof obj.message === "string"
        ? obj.message
        : typeof obj.description === "string"
          ? obj.description
          : typeof obj.error === "string"
            ? obj.error
            : undefined;
  }

  if (!message) return undefined;

  let result = message;
  if (type) {
    result = `${humanizeType(type)}: ${result}`;
  }
  if (statusCode) {
    result = `${statusCode} ${result}`;
  }
  return result;
}

function humanizeType(type: string): string {
  return type
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
