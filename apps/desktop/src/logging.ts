import { getTimeRotatingFileSink } from "@logtape/file";
import { configure, getConsoleSink, getJsonLinesFormatter, Sink } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { redactByField } from "@logtape/redaction";
import { join } from "node:path";

import { appDir } from "./bun/app-paths.js";
import { config } from "./env.js";

export async function configureLogging(): Promise<void> {
  const consoleSink = redactByField(
    getConsoleSink({
      formatter: getPrettyFormatter({ properties: true }),
      nonBlocking: true,
    }),
    {
      fieldPatterns: [
        /token/i,
        /secret/i,
        /api[-_]?key/i,
        /password/i,
        /authorization/i,
        /gh_token/i,
        /telegram_id/i,
        /email/i,
      ],
    },
  );

  const sinks: Record<string, Sink | (Sink & Disposable) | (Sink & AsyncDisposable)> = {
    console: consoleSink,
  };

  if (config.logFile) {
    const directory =
      typeof config.logFile === "string" ? config.logFile : join(appDir(), "logs");
    sinks.file = getTimeRotatingFileSink({
      directory,
      formatter: getJsonLinesFormatter(),
      nonBlocking: true,
      bufferSize: 1000,
      flushInterval: 500,
      filename: (date: Date) => `herman-desktop-${date.toISOString().slice(0, 10)}.txt`,
      interval: "daily",
    });
  }

  await configure({
    sinks,
    loggers: [
      { category: ["herman-desktop"], lowestLevel: config.logLevel, sinks: Object.keys(sinks) },
      { category: ["email"], lowestLevel: config.logLevel, sinks: Object.keys(sinks) },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: Object.keys(sinks) },
    ],
  });
}
