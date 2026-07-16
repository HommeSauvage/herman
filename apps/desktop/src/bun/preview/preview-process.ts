import { spawn } from "bun";

import { getLogger } from "@logtape/logtape";

import { appendStderrTail, looksLikeServerError, truncateErrorMessage } from "./preview-log-filter.js";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_STDERR_CHARS,
  wrapBunSubprocess,
  type PreviewChildProcess,
  type SpawnChildOpts,
} from "./types.js";

const logger = getLogger(["herman-desktop", "preview", "process"]);

/**
 * Spawn a preview command via `sh -c` so quoted args / chains work
 * (matches worktree.ts install pattern).
 */
export function spawnPreviewChild(opts: SpawnChildOpts): PreviewChildProcess {
  logger.info("Spawning preview child", {
    folderPath: opts.folderPath,
    command: opts.command,
    port: opts.port,
  });

  const proc = spawn(["sh", "-c", opts.command], {
    cwd: opts.folderPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...opts.env,
      PORT: String(opts.port),
    },
  });

  return wrapBunSubprocess(proc);
}

export type LineHandler = (source: "stdout" | "stderr", line: string) => void;

/**
 * Attach line readers to stdout/stderr. Returns a cancel function.
 * Readers ignore read errors on process exit.
 */
export function attachLineReaders(
  child: PreviewChildProcess,
  onLine: LineHandler,
): () => void {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const attach = (
    stream: ReadableStream<Uint8Array> | null,
    source: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const line of parts) {
            const trimmed = line.replace(/\r$/, "");
            if (trimmed.length > 0) onLine(source, trimmed);
          }
        }
        if (!cancelled && buffer.trim()) onLine(source, buffer.replace(/\r$/, ""));
      } catch {
        // ignore read errors on process exit
      }
    })();
  };

  attach(child.stdout, "stdout");
  attach(child.stderr, "stderr");
  return cancel;
}

export type InstanceLogSink = {
  onStderrChunk: (chunk: string) => void;
  onErrorLine: (source: "stdout" | "stderr", line: string) => void;
};

/** Create a line handler that updates stderr tail and filters error lines. */
export function createInstanceLineHandler(sink: InstanceLogSink): LineHandler {
  return (source, line) => {
    if (source === "stderr") {
      sink.onStderrChunk(line + "\n");
    }
    logger.debug(`[preview ${source}]`, { msg: line });
    if (looksLikeServerError(line)) {
      sink.onErrorLine(source, truncateErrorMessage(line, MAX_ERROR_MESSAGE_CHARS));
    }
  };
}

export { appendStderrTail, MAX_STDERR_CHARS };
