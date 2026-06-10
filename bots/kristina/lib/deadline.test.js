/**
 * Tests for normalizeDeadline — the chokepoint that stops poison deadline
 * values (e.g. "+2h") from reaching Atlas/SQLite. Regression guard for the
 * 2026-06-07 task-loss incident.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { normalizeDeadline } from './deadline.js';
import { TIMEZONE } from './working-hours.js';

const REF = DateTime.fromISO('2026-06-08T12:00', { zone: TIMEZONE });

describe('normalizeDeadline — poison values (the incident)', () => {
  it('converts "+2h" to a valid ISO datetime, not Invalid Date', () => {
    const out = normalizeDeadline('+2h', REF);
    expect(out).not.toBeNull();
    expect(new Date(out).toString()).not.toBe('Invalid Date');
    expect(DateTime.fromISO(out).toMillis()).toBe(REF.plus({ hours: 2 }).toMillis());
  });

  it('converts "+0h" to now (valid)', () => {
    const out = normalizeDeadline('+0h', REF);
    expect(DateTime.fromISO(out).toMillis()).toBe(REF.toMillis());
  });

  it('parses "+3 days" and "+1w"', () => {
    expect(DateTime.fromISO(normalizeDeadline('+3 days', REF)).toMillis())
      .toBe(REF.plus({ days: 3 }).toMillis());
    expect(DateTime.fromISO(normalizeDeadline('+1w', REF)).toMillis())
      .toBe(REF.plus({ weeks: 1 }).toMillis());
  });
});

describe('normalizeDeadline — valid passthrough', () => {
  it('keeps a bare YYYY-MM-DD unchanged', () => {
    expect(normalizeDeadline('2026-06-09', REF)).toBe('2026-06-09');
  });
  it('keeps a full ISO datetime unchanged', () => {
    expect(normalizeDeadline('2026-06-04T05:00:00.000Z', REF)).toBe('2026-06-04T05:00:00.000Z');
  });
});

describe('normalizeDeadline — garbage drops to null', () => {
  it.each([null, undefined, '', '   ', 'soon', 'next sprint', '+2m', '+', 'tomorrowish'])(
    'returns null for %p',
    (v) => expect(normalizeDeadline(v, REF)).toBeNull()
  );
  it('every non-null result is parseable by JS Date (never poisons Atlas)', () => {
    for (const v of ['+2h', '+0h', '2026-06-09', '2026-06-04T05:00:00.000Z', '+5 days']) {
      const out = normalizeDeadline(v, REF);
      expect(new Date(out).toString()).not.toBe('Invalid Date');
    }
  });
});
