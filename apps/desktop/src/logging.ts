import { getTimeRotatingFileSink } from "@logtape/file";
import { getJsonLinesFormatter, type Sink } from "@logtape/logtape";
import { join } from "node:path";

import { appDir } from "./bun/app-paths.js";
import { config } from "./env.js";
import { configureBaseLogging } from "./logging-shared.js";

export async function configureLogging(): Promise<void> {
  const extraSinks: Record<string, Sink | (Sink & Disposable) | (Sink & AsyncDisposable)> = {};

  if (config.logFile) {
    const directory =
      typeof config.logFile === "string" ? config.logFile : join(appDir(), "logs");
    extraSinks.file = getTimeRotatingFileSink({
      directory,
      formatter: getJsonLinesFormatter(),
      nonBlocking: true,
      bufferSize: 1000,
      flushInterval: 500,
      filename: (date: Date) => `herman-desktop-${date.toISOString().slice(0, 10)}.txt`,
      interval: "daily",
    });
  }

  await configureBaseLogging(config.logLevel, extraSinks);
}
