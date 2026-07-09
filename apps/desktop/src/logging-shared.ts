import { configure, getConsoleSink, type LogLevel, type Sink } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { redactByField } from "@logtape/redaction";

const REDACT_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /api[-_]?key/i,
  /password/i,
  /authorization/i,
  /gh_token/i,
  /telegram_id/i,
  /email/i,
];

export function createRedactedConsoleSink() {
  return redactByField(
    getConsoleSink({
      formatter: getPrettyFormatter({ properties: true, timestamp: "time" }),
      nonBlocking: true,
    }),
    { fieldPatterns: REDACT_FIELD_PATTERNS },
  );
}

export async function configureBaseLogging(
  logLevel: LogLevel,
  extraSinks: Record<string, Sink | (Sink & Disposable) | (Sink & AsyncDisposable)> = {},
): Promise<void> {
  const sinks: Record<string, Sink | (Sink & Disposable) | (Sink & AsyncDisposable)> = {
    console: createRedactedConsoleSink(),
    ...extraSinks,
  };

  await configure({
    sinks,
    loggers: [
      { category: ["herman-desktop"], lowestLevel: logLevel, sinks: Object.keys(sinks) },
      { category: ["email"], lowestLevel: logLevel, sinks: Object.keys(sinks) },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: Object.keys(sinks) },
    ],
  });
}
