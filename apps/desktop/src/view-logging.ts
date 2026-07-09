import type { LogLevel } from "@logtape/logtape";

import { configureBaseLogging } from "./logging-shared.js";

export async function configureViewLogging(): Promise<void> {
  const logLevel: LogLevel = import.meta.env.DEV ? "debug" : "info";
  await configureBaseLogging(logLevel);
}
