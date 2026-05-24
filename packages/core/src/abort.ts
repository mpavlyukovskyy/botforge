/**
 * Per-stage timeouts via AbortController.
 *
 * Today's pattern is unbounded awaits — `await askBrain(...)` and the
 * library decides when to give up. When the LLM stalls, the whole bot
 * handler hangs. Wrapping each stage in a timeout-bound AbortSignal
 * makes hangs bounded and observable.
 *
 * Compose with a parent signal so an outer abort cascades to inner ones.
 */

export const DEFAULT_LLM_TIMEOUT_MS = 45_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 20_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface TimeoutOptions {
  /** Max time to wait for the work to complete. */
  timeoutMs: number;
  /** Optional parent signal — if it aborts, the timeout signal aborts too. */
  parent?: AbortSignal;
  /** Label included in the timeout error message for observability. */
  label?: string;
}

/** Error thrown when withTimeout fires its deadline. */
export class TimeoutError extends Error {
  readonly kind = 'TimeoutError';
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Run `fn` with an AbortSignal that fires after timeoutMs. If a parent signal
 * is supplied and aborts first, the inner signal aborts too. The work is
 * expected to honor the signal — Anthropic SDK and fetch() do.
 *
 * Returns the work's result, or throws TimeoutError on deadline.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: TimeoutOptions,
): Promise<T> {
  const label = opts.label ?? 'operation';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(label, opts.timeoutMs)), opts.timeoutMs);

  // Cascade parent → child abort.
  const onParentAbort = () => controller.abort(opts.parent?.reason);
  if (opts.parent) {
    if (opts.parent.aborted) controller.abort(opts.parent.reason);
    else opts.parent.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    // Race the work against the abort signal so callers that ignore the
    // signal (e.g. fixed-duration setTimeout) still see TimeoutError.
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason);
        }, { once: true });
      }),
    ]);
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (opts.parent) opts.parent.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Compose multiple AbortSignals into one that fires when any input fires.
 * Standard AbortSignal.any equivalent for Node versions where it isn't yet
 * exposed.
 */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  // Node 20.3+ ships AbortSignal.any.
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(
      signals.filter((s): s is AbortSignal => s !== undefined),
    );
  }
  const controller = new AbortController();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}
