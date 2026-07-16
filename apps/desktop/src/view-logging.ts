import type { LogLevel } from "@logtape/logtape";

import { configureBaseLogging } from "./logging-shared.js";
import { parseLogLevel } from "./shared/log-config.js";

export async function configureViewLogging(): Promise<void> {
  const envLevel =
    typeof import.meta.env.HERMAN_DESKTOP_LOG_LEVEL === "string"
      ? import.meta.env.HERMAN_DESKTOP_LOG_LEVEL
      : undefined;
  const fallback: LogLevel = import.meta.env.DEV ? "debug" : "info";
  await configureBaseLogging(parseLogLevel(envLevel, fallback), {}, { colors: false });
}

export function getViewLogLevel(): LogLevel {
  const envLevel =
    typeof import.meta.env.HERMAN_DESKTOP_LOG_LEVEL === "string"
      ? import.meta.env.HERMAN_DESKTOP_LOG_LEVEL
      : undefined;
  const fallback: LogLevel = import.meta.env.DEV ? "debug" : "info";
  return parseLogLevel(envLevel, fallback);
}
