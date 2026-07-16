import {
  configure,
  getConsoleSink,
  type LogLevel,
  type Logger,
  type Sink,
} from "@logtape/logtape";
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

export interface ConsoleSinkOptions {
  /** Whether to use ANSI colors. Disable for browser/SPA environments. */
  readonly colors?: boolean;
}

export function createRedactedConsoleSink(options: ConsoleSinkOptions = {}) {
  return redactByField(
    getConsoleSink({
      formatter: getPrettyFormatter({
        properties: true,
        timestamp: "time",
        colors: options.colors ?? true,
      }),
      nonBlocking: true,
    }),
    { fieldPatterns: REDACT_FIELD_PATTERNS },
  );
}

export async function configureBaseLogging(
  logLevel: LogLevel,
  extraSinks: Record<string, Sink | (Sink & Disposable) | (Sink & AsyncDisposable)> = {},
  consoleOptions: ConsoleSinkOptions = {},
): Promise<void> {
  const sinks: Record<string, Sink | (Sink & Disposable) | (Sink & AsyncDisposable)> = {
    console: createRedactedConsoleSink(consoleOptions),
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

export function logDuration(
  logger: Logger,
  label: string,
  startMs: number,
  meta: Record<string, unknown> = {},
): void {
  logger.debug(label, { ...meta, durationMs: Date.now() - startMs });
}

export function logStorageError(
  logger: Logger,
  operation: string,
  path: string,
  error: unknown,
): void {
  logger.warning("Storage operation failed", {
    operation,
    path,
    error: error instanceof Error ? error.message : String(error),
  });
}

type RpcHandler = (params: any) => any;

export function wrapRpcHandlers<T extends Record<string, RpcHandler>>(
  logger: Logger,
  handlers: T,
): T {
  const wrapped = {} as T;
  for (const [method, handler] of Object.entries(handlers)) {
    wrapped[method as keyof T] = (async (params: any) => {
      const startMs = Date.now();
      logger.trace("RPC request", { method, params });
      try {
        const result = await handler(params);
        logger.trace("RPC request completed", { method, durationMs: Date.now() - startMs });
        return result;
      } catch (error) {
        logger.error("RPC request failed", {
          method,
          durationMs: Date.now() - startMs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as T[keyof T];
  }
  return wrapped;
}
