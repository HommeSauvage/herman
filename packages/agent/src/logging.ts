import { configure, getConsoleSink } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { redactByField } from "@logtape/redaction";

import { config } from "./env.js";

const REDACT_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /api[-_]?key/i,
  /password/i,
  /authorization/i,
  /session/i,
  /email/i,
];

export async function configureLogging(): Promise<void> {
  const consoleSink = redactByField(
    getConsoleSink({
      formatter: getPrettyFormatter({ properties: true, timestamp: "time" }),
      // Synchronous writes so stderr is flushed before a subprocess crash.
      nonBlocking: false,
    }),
    { fieldPatterns: REDACT_FIELD_PATTERNS },
  );

  await configure({
    sinks: { console: consoleSink },
    loggers: [
      { category: ["herman-agent"], lowestLevel: config.logLevel, sinks: ["console"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
    ],
  });
}
