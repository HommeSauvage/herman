import { Writable } from "node:stream";

import { configure, getStreamSink } from "@logtape/logtape";
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
  // stdout is reserved for pi RPC JSONL; all agent logs must go to stderr.
  const stderrSink = redactByField(
    getStreamSink(Writable.toWeb(process.stderr), {
      formatter: getPrettyFormatter({ properties: true, timestamp: "time" }),
      nonBlocking: false,
    }),
    { fieldPatterns: REDACT_FIELD_PATTERNS },
  );

  await configure({
    sinks: { stderr: stderrSink },
    loggers: [
      { category: ["herman-agent"], lowestLevel: config.logLevel, sinks: ["stderr"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["stderr"] },
    ],
  });
}
