import type { LogLevel } from "@logtape/logtape";

const VALID_LEVELS = new Set<LogLevel>(["trace", "debug", "info", "warning", "error", "fatal"]);

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value && VALID_LEVELS.has(value as LogLevel)) {
    return value as LogLevel;
  }
  return fallback;
}
