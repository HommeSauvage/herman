/**
 * Coalescing scheduler for `ui.notify` calls.
 *
 * Pi's `ui.notify` is fire-and-forget over RPC; firing it per-token (during
 * assistant streaming) would saturate the IPC. This helper debounces calls
 * to a single trailing-edge emit within a configurable window, while still
 * allowing callers to force an immediate emit on important lifecycle
 * events (`agent_end`, `session_compact`, `message_end`).
 *
 * Implementation notes:
 * - We use `setTimeout` rather than a microtask because we want a hard
 *   wall-clock bound, not just "until the event loop is free".
 * - `flush()` always emits immediately and cancels any pending debounced
 *   emit. Use it sparingly (lifecycle events); `schedule()` is for the
 *   hot streaming path.
 * - We intentionally do NOT use a leading-edge emit because the desktop
 *   prefers a stable stream of state updates over a flurry of
 *   intermediate values.
 */

export type NotifyFn = (message: string) => void;

export type ThrottledNotifier = {
  /** Mark the state as dirty and schedule a debounced emit (if not already pending). */
  schedule: () => void;
  /** Cancel any pending emit. Used on session teardown. */
  cancel: () => void;
  /**
   * Force an immediate emit, cancelling any pending debounced emit.
   * Unlike `schedule()`, this always produces a notify call (even when
   * nothing has been scheduled yet) so callers can rely on it for
   * "emit the current snapshot right now" semantics.
   */
  flush: () => void;
};

export function createThrottledNotifier(
  notify: NotifyFn,
  getPayload: () => string,
  windowMs: number,
  onError?: (error: unknown) => void,
): ThrottledNotifier {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => {
    timer = undefined;
    try {
      notify(getPayload());
    } catch (error) {
      onError?.(error);
    }
  };

  return {
    schedule: () => {
      if (timer !== undefined) return;
      timer = setTimeout(emit, windowMs);
    },
    cancel: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
    flush: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      emit();
    },
  };
}
