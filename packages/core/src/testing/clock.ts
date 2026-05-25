/**
 * Thin ergonomic wrapper around node:test mock.timers.
 *
 * Usage:
 *   import { fakeClock } from '@botforge/core/testing';
 *   const clock = fakeClock();
 *   try {
 *     clock.advance(60_000);    // tick Date, setTimeout, setInterval
 *   } finally {
 *     clock.restore();
 *   }
 *
 * Wrapping node:test's mock.timers makes test setup small and consistent
 * across packages. Direct use of mock.timers also works.
 */

import { mock } from 'node:test';

export interface FakeClock {
  /** Advance time by N ms, firing any pending timers. */
  advance(ms: number): void;
  /** Fire ALL pending timers regardless of scheduled time. */
  runAll(): void;
  /** Current mock time as a unix-ms number. */
  now(): number;
  /** Restore real timers. */
  restore(): void;
}

export function fakeClock(opts: { startAt?: number; apis?: Array<'Date' | 'setTimeout' | 'setInterval' | 'setImmediate'> } = {}): FakeClock {
  const apis = opts.apis ?? ['Date', 'setTimeout', 'setInterval'];
  mock.timers.enable({ apis, now: opts.startAt ?? 0 });

  return {
    advance(ms: number): void {
      mock.timers.tick(ms);
    },
    runAll(): void {
      mock.timers.runAll();
    },
    now(): number {
      return Date.now();
    },
    restore(): void {
      mock.timers.reset();
    },
  };
}
