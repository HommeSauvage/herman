import {
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  type PreviewProbeResult,
} from "./types.js";

export type WaitForReadyOpts = {
  url: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Abort readiness (stop / restart / generation change). */
  signal?: AbortSignal;
  /** When set, abort early if the subprocess exits before the URL is ready. */
  processExited?: Promise<number>;
  probe: (url: string, signal?: AbortSignal) => Promise<PreviewProbeResult>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll until HTTP readiness, abort, process exit, or timeout.
 * Never puts `undefined` into Promise.race (that would resolve immediately).
 */
export async function waitForReady(opts: WaitForReadyOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? PREVIEW_READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PREVIEW_READY_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const started = now();

  let exited = false;
  let exitCode: number | undefined;
  if (opts.processExited) {
    void opts.processExited.then((code) => {
      exited = true;
      exitCode = code;
    });
  }

  while (now() - started < timeoutMs) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (exited) {
      throw new Error(
        `Preview server exited before becoming ready at ${opts.url}` +
          (exitCode != null ? ` (exit ${exitCode})` : ""),
      );
    }

    try {
      const probeSignal =
        opts.signal ?? AbortSignal.timeout(Math.min(pollMs * 5, 2_000));
      const result = await opts.probe(opts.url, probeSignal);
      if (result.ok || (result.status != null && result.status < 500)) return;
    } catch {
      // keep polling (includes AbortError from per-probe timeout)
      if (opts.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
    }

    const waiters: Promise<unknown>[] = [sleep(pollMs, opts.signal)];
    if (opts.processExited && !exited) {
      waiters.push(
        opts.processExited.then((code) => {
          exited = true;
          exitCode = code;
        }),
      );
    }
    await Promise.race(waiters);
  }

  if (exited) {
    throw new Error(
      `Preview server exited before becoming ready at ${opts.url}` +
        (exitCode != null ? ` (exit ${exitCode})` : ""),
    );
  }
  throw new Error(`Preview server did not become ready at ${opts.url}`);
}

export async function httpProbe(
  url: string,
  signal?: AbortSignal,
): Promise<PreviewProbeResult> {
  try {
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(1_000),
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}
