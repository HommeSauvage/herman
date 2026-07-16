import { MAX_ERROR_MESSAGE_CHARS } from "./types.js";

const SERVER_ERROR_PATTERNS: RegExp[] = [
  /\bError:/i,
  /\bERROR\b/,
  /\berror TS\d+/i,
  /\bFailed to compile\b/i,
  /\bCompilation failed\b/i,
  /\bModule not found\b/i,
  /\bCannot find (module|package)\b/i,
  /\bECONNREFUSED\b/,
  /\bENOENT\b/,
  /\bEADDRINUSE\b/,
  /\bnpm ERR!/i,
  /\bERR_PNPM\b/i,
  /^\s*at\s+\S+/,
  /\bUncaught\b/i,
  /\bUnhandled (Promise )?Rejection\b/i,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
];

export function looksLikeServerError(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return SERVER_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function truncateErrorMessage(message: string, max = MAX_ERROR_MESSAGE_CHARS): string {
  if (message.length <= max) return message;
  return message.slice(0, max);
}

/** Append to a bounded stderr ring buffer (keeps the last `maxChars` characters). */
export function appendStderrTail(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}
