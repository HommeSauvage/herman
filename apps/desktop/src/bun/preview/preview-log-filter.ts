import { MAX_ERROR_MESSAGE_CHARS } from "./types.js";

const SERVER_ERROR_PATTERNS: RegExp[] = [
  // Generic JS/TS errors
  /\bError:/i,
  /\bERROR\b/,
  /\bFATAL ERROR\b/i,
  // TypeScript
  /\berror TS\d+/i,
  // Build tool failures
  /\bFailed to compile\b/i,
  /\bCompilation failed\b/i,
  /\bBuild failed\b/i,
  /\bBuild error\b/i,
  /\bFailed to build\b/i,
  /\bFailed to resolve\b/i,
  // Module resolution
  /\bModule not found\b/i,
  /\bCannot find (module|package)\b/i,
  /\bCould not resolve\b/i,
  /\bUnable to resolve\b/i,
  // System errors
  /\bECONNREFUSED\b/,
  /\bENOENT\b/,
  /\bEADDRINUSE\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  // Package manager errors
  /\bnpm ERR!/i,
  /\bERR_PNPM\b/i,
  /\berror: .*command.*not found/i,
  /\bcommand not found\b/i,
  // Stack traces
  /^\s*at\s+\S+/,
  // Runtime errors
  /\bUncaught\b/i,
  /\bUnhandled (Promise )?Rejection\b/i,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bRangeError\b/,
  // Vite-specific
  /\[ERROR\]/,
  /✘.*\[ERROR\]/,
  // Next.js
  /⨯\s/,
  /\bNext\.js.*error\b/i,
  // Bun
  /\bBun\.(build|serve).*error\b/i,
  // Common crash signals
  /\bFATAL\b/,
  /\bpanic\b/i,
  /\babort\b/i,
  /\bSIGSEGV\b/,
  /\bSIGABRT\b/,
  // CSS / asset errors
  /\bUnknown word\b/,
  /\bUnexpected token\b/i,
  /\bParse error\b/i,
  // Import / export
  /\bdoes not provide an export named\b/i,
  /\bhas no exported member\b/i,
  /\bCannot import\b/i,
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
