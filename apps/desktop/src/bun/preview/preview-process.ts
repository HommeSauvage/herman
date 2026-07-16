import { spawn } from "bun";

import { getLogger } from "@logtape/logtape";

import { waitForSubprocessExit } from "../subprocess-exit.js";
import { appendStderrTail, looksLikeServerError, truncateErrorMessage } from "./preview-log-filter.js";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_STDERR_CHARS,
  wrapBunSubprocess,
  type PreviewChildProcess,
  type SpawnChildOpts,
} from "./types.js";

const logger = getLogger(["herman-desktop", "preview", "process"]);

const SIGTERM_TIMEOUT_MS = 3_000;
const SIGKILL_TIMEOUT_MS = 2_000;

/**
 * Spawn a preview command via `sh -c` so quoted args / chains work
 * (matches worktree.ts install pattern).
 *
 * Uses a new process group so grandchildren (npm → vite/next) die with the shell.
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
    // Bun: setpgid(0, 0) so kill(-pid) reaches the whole tree while keeping pipes.
    new_process_group: true,
    env: {
      ...process.env,
      ...opts.env,
      PORT: String(opts.port),
    },
  } as Parameters<typeof spawn>[1]);

  return wrapBunSubprocess(proc);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH / EPERM — group may already be gone
  }
}

/**
 * SIGTERM the process group (and the direct child), wait, then SIGKILL if needed.
 * Awaits exit so ports are free before the next findFreePort / restart.
 */
export async function killPreviewTree(child: PreviewChildProcess): Promise<void> {
  const pid = child.pid;

  if (pid != null && pid > 0) {
    signalProcessGroup(pid, "SIGTERM");
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }

  const exitedAfterSigterm = await waitForSubprocessExit(child.exited, SIGTERM_TIMEOUT_MS);
  if (exitedAfterSigterm) return;

  logger.warning("Preview process did not exit after SIGTERM; sending SIGKILL", { pid });
  if (pid != null && pid > 0) {
    signalProcessGroup(pid, "SIGKILL");
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already dead
  }
  await waitForSubprocessExit(child.exited, SIGKILL_TIMEOUT_MS);
}

export type LineHandler = (source: "stdout" | "stderr", line: string) => void;

/**
 * Attach line readers to stdout/stderr. Returns a cancel function.
 * Readers ignore read errors on process exit.
 */
export function attachLineReaders(
  child: PreviewChildProcess,
  onLine: LineHandler & { flush?: () => void },
): () => void {
  let cancelled = false;
  let alive = 0;
  const cancel = () => {
    cancelled = true;
  };

  const maybeFlush = () => {
    if (alive === 0) onLine.flush?.();
  };

  const attach = (
    stream: ReadableStream<Uint8Array> | null,
    source: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    alive++;
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
      } finally {
        alive--;
        maybeFlush();
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

/** Number of lines captured before and after each detected error line. */
const ERROR_CONTEXT_LINES = 25;

type PendingContext = {
  source: "stdout" | "stderr";
  before: string[];
  errorLine: string;
  after: string[];
  remainingAfter: number;
};

/**
 * Create a line handler that updates stderr tail and filters error lines.
 *
 * Multi-line errors (stack traces, turborepo-style arrays, etc.) are captured
 * as a single entry by snapping ERROR_CONTEXT_LINES before and after each
 * detected error line.  The returned handler exposes a `flush()` method so
 * callers can drain an in-progress context window before the process exits.
 */
export function createInstanceLineHandler(sink: InstanceLogSink): LineHandler & { flush: () => void } {
  // Sliding window of recent log lines used for "before" context snapshots.
  const ring: string[] = [];
  let pending: PendingContext | null = null;

  function flushPending() {
    if (!pending) return;
    const fullMessage = [
      ...pending.before,
      pending.errorLine,
      ...pending.after,
    ].join("\n");
    sink.onErrorLine(
      pending.source,
      truncateErrorMessage(fullMessage, MAX_ERROR_MESSAGE_CHARS),
    );
    pending = null;
  }

  const handler: LineHandler = (source, line) => {
    if (source === "stderr") {
      sink.onStderrChunk(line + "\n");
      // Always log stderr at info level — most build tools route errors here.
      logger.info(`[preview stderr]`, { msg: line });
    } else {
      // stdout is logged at debug level to keep terminal noise manageable;
      // errors on stdout are still detected and forwarded.
      logger.debug(`[preview stdout]`, { msg: line });
    }

    if (looksLikeServerError(line)) {
      // Flush any in-progress context window so overlapping errors don't merge.
      flushPending();

      // Snapshot the N lines leading up to this error.  The ring doesn't
      // contain this line yet — it's pushed after the error check.
      pending = {
        source,
        before: ring.slice(-ERROR_CONTEXT_LINES),
        errorLine: line,
        after: [],
        remainingAfter: ERROR_CONTEXT_LINES,
      };
    } else if (pending) {
      // Collect "after" context for the current error window.
      pending.after.push(line);
      pending.remainingAfter--;
      if (pending.remainingAfter <= 0) {
        flushPending();
      }
    }

    // Push to the sliding window so future errors can use it as "before" context.
    ring.push(line);
    // Keep memory bounded (2× context, one shift per line keeps it exactly at the cap).
    if (ring.length > ERROR_CONTEXT_LINES * 2) {
      ring.shift();
    }
  };

  return Object.assign(handler, { flush: flushPending });
}

export { appendStderrTail, MAX_STDERR_CHARS };
