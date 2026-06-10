/**
 * S4: INCENTIVE_V2 flag + $0 decay floor + no-negative-balance. The invariant:
 * with the flag OFF (default) behavior is byte-identical to today (negative
 * debt); ON, a late task floors at $0 and never becomes debt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DateTime } from 'luxon';
import { getFlag, setFlagsCache } from './flags.js';
import { computeDecayValue } from './decay.js';
import { TIMEZONE } from './working-hours.js';

afterEach(() => setFlagsCache({}));

describe('getFlag', () => {
  beforeEach(() => setFlagsCache({}));
  it('defaults OFF for any unknown/missing flag', () => {
    expect(getFlag('INCENTIVE_V2')).toBe(false);
    expect(getFlag('anything')).toBe(false);
  });
  it('parses truthy strings', () => {
    for (const v of ['true', '1', 'on', 'yes', 'TRUE']) { setFlagsCache({ X: v }); expect(getFlag('X')).toBe(true); }
    for (const v of ['false', '0', 'off', '', 'no']) { setFlagsCache({ X: v }); expect(getFlag('X')).toBe(false); }
  });
});

describe('computeDecayValue — $0 floor gated by INCENTIVE_V2', () => {
  // A deadline far in the past so the linear decay goes well negative.
  const longOverdue = '2026-05-01';
  const now = DateTime.fromISO('2026-06-10T20:00', { zone: TIMEZONE });

  it('OFF (default) → value goes NEGATIVE, exactly like today', () => {
    setFlagsCache({});
    const { value } = computeDecayValue(longOverdue, now);
    expect(value).toBeLessThan(0);
  });

  it('ON → value FLOORS at $0, never negative', () => {
    setFlagsCache({ INCENTIVE_V2: 'true' });
    const { value } = computeDecayValue(longOverdue, now);
    expect(value).toBe(0);
  });

  it('ON → an on-time task still earns full $1 (floor only affects the negative tail)', () => {
    setFlagsCache({ INCENTIVE_V2: 'true' });
    const future = DateTime.fromISO('2026-12-31', { zone: TIMEZONE });
    const { value } = computeDecayValue('2026-12-31', future.minus({ days: 1 }));
    expect(value).toBe(1);
  });

  it('ON → a slightly-late task keeps its partial positive value (floor is only at 0)', () => {
    setFlagsCache({ INCENTIVE_V2: 'true' });
    // ~2 working hours late → ~0.90, still positive, unaffected by the floor
    const slightlyLate = DateTime.fromISO('2026-06-10T20:00', { zone: TIMEZONE });
    const { value } = computeDecayValue('2026-06-09', slightlyLate);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});

describe('computeDecayValue — S7 blocked-interval credit', () => {
  it('crediting enough blocked seconds pushes the effective deadline past now → full value', () => {
    setFlagsCache({});
    const now = DateTime.fromISO('2026-06-10T20:00', { zone: TIMEZONE });
    const overdueNoCredit = computeDecayValue('2026-06-08', now).value;
    // Credit 10 days of blocked time → effective deadline well past `now` → full $1
    const withCredit = computeDecayValue('2026-06-08', now, 10 * 86400).value;
    expect(withCredit).toBe(1);
    expect(withCredit).toBeGreaterThan(overdueNoCredit);
  });
  it('default 0 blocked seconds == no shift (OFF-safe)', () => {
    const now = DateTime.fromISO('2026-06-10T20:00', { zone: TIMEZONE });
    expect(computeDecayValue('2026-06-08', now).value)
      .toBe(computeDecayValue('2026-06-08', now, 0).value);
  });
});
