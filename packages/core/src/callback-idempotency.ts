/**
 * withCallbackIdempotency — wrap an inline-keyboard callback handler so a
 * second tap with the same callback_query.id within TTL is silently skipped.
 *
 * Three bots independently rediscovered the callback-double-tap bug
 * (Alfred, NZVC-LP, Kristina/Hevy). This helper makes the fix one-line
 * for any handler: wrap and forget.
 *
 * Storage: in-memory Map (per-process). Telegram callback_query.ids are
 * unique per tap, so a process restart resets the dedupe window — that's
 * fine because Telegram only delivers each query.id once.
 *
 * TTL: default 5 minutes. After that, an entry is GC'd on the next access.
 */

type Outcome = { kind: 'processed' } | { kind: 'duplicate'; firstSeenAt: number };

interface Entry {
  firstSeenAt: number;
  promise: Promise<unknown>;
}

export interface IdempotencyOptions {
  /** Time after which a query.id is forgotten (default 5min). */
  ttlMs?: number;
  /** Now-source override for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class CallbackIdempotency {
  private entries = new Map<string, Entry>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: IdempotencyOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns the outcome of attempting to handle this callback. If the same
   * queryId is in-flight or recently finished, returns 'duplicate' and the
   * timestamp of the first sighting; the caller should answer the callback
   * (so Telegram clears the spinner) but skip side effects.
   *
   * If new, the caller MUST call `tracked(queryId, work)` to register the
   * work promise — otherwise the helper has no way to know when to record
   * 'finished' state.
   */
  check(queryId: string): Outcome {
    this.gc();
    const existing = this.entries.get(queryId);
    if (existing) {
      return { kind: 'duplicate', firstSeenAt: existing.firstSeenAt };
    }
    return { kind: 'processed' };
  }

  /**
   * Wrap a handler invocation: dedupe by queryId. Returns the handler's
   * resolved value, or void on duplicate (the caller should answer the
   * callback to clear the spinner).
   */
  async wrap<T>(queryId: string, work: () => Promise<T>): Promise<T | { skipped: 'duplicate'; firstSeenAt: number }> {
    this.gc();
    const existing = this.entries.get(queryId);
    if (existing) {
      return { skipped: 'duplicate', firstSeenAt: existing.firstSeenAt };
    }
    const promise = work();
    this.entries.set(queryId, { firstSeenAt: this.now(), promise });
    try {
      return await promise;
    } finally {
      // Keep the entry in the map until TTL expires so a late retry still
      // sees 'duplicate'. gc() handles cleanup on next access.
    }
  }

  /** Sweep expired entries. Called lazily on each check/wrap. */
  private gc(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.firstSeenAt < cutoff) this.entries.delete(id);
    }
  }

  /** Current entry count (for tests + monitoring). */
  size(): number {
    return this.entries.size;
  }
}

/** Convenience: a module-level singleton for handlers that don't need DI. */
export const callbackIdempotency = new CallbackIdempotency();

/**
 * withCallbackIdempotency('cb-id', async () => { ... })
 *
 * Returns either the handler's value or { skipped: 'duplicate', firstSeenAt }.
 */
export function withCallbackIdempotency<T>(
  queryId: string,
  work: () => Promise<T>,
): Promise<T | { skipped: 'duplicate'; firstSeenAt: number }> {
  return callbackIdempotency.wrap(queryId, work);
}
