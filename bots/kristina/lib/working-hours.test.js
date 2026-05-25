/**
 * Tests for working-hours.js — Kristina's non-standard Sun-Thu 3pm-1am ET workweek.
 *
 * Critical because the financial decay model multiplies overdue hours by
 * working-hours-only — a bug here corrupts every task's bounty.
 *
 * Uses vitest (workspace standard).
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  isWorkingHours,
  isWorkingDay,
  computeWorkingHours,
  addWorkingHours,
  TIMEZONE,
} from './working-hours.js';

const dt = (iso) => DateTime.fromISO(iso, { zone: TIMEZONE });

describe('isWorkingHours', () => {
  it('returns true at 3pm Sunday ET', () => {
    // 2026-05-17 is a Sunday
    expect(isWorkingHours(dt('2026-05-17T15:00'))).toBe(true);
  });
  it('returns true at 11pm Wednesday ET', () => {
    // 2026-05-13 is a Wednesday
    expect(isWorkingHours(dt('2026-05-13T23:00'))).toBe(true);
  });
  it('returns true at 12:30am Friday ET (tail of Thursday session)', () => {
    // 2026-05-15 is a Friday — Thursday session tails until 1am Fri
    expect(isWorkingHours(dt('2026-05-15T00:30'))).toBe(true);
  });
  it('returns false at 2pm Sunday ET (before session start)', () => {
    expect(isWorkingHours(dt('2026-05-17T14:00'))).toBe(false);
  });
  it('returns false at 4pm Friday ET (non-working day)', () => {
    // 2026-05-15 is Friday — not in WORK_DAYS
    expect(isWorkingHours(dt('2026-05-15T16:00'))).toBe(false);
  });
  it('returns false at 4pm Saturday ET (non-working day)', () => {
    // 2026-05-16 is Saturday
    expect(isWorkingHours(dt('2026-05-16T16:00'))).toBe(false);
  });
  it('returns false at 12:30am Saturday ET (Fri night is NOT a session tail)', () => {
    // 2026-05-16 is Saturday — previous day Friday is non-working,
    // so the tail rule doesn't apply.
    expect(isWorkingHours(dt('2026-05-16T00:30'))).toBe(false);
  });
});

describe('isWorkingDay', () => {
  it('Sun-Thu are working days', () => {
    expect(isWorkingDay(dt('2026-05-17T12:00'))).toBe(true); // Sun
    expect(isWorkingDay(dt('2026-05-18T12:00'))).toBe(true); // Mon
    expect(isWorkingDay(dt('2026-05-19T12:00'))).toBe(true); // Tue
    expect(isWorkingDay(dt('2026-05-20T12:00'))).toBe(true); // Wed
    expect(isWorkingDay(dt('2026-05-21T12:00'))).toBe(true); // Thu
  });
  it('Fri-Sat are not working days', () => {
    expect(isWorkingDay(dt('2026-05-22T12:00'))).toBe(false); // Fri
    expect(isWorkingDay(dt('2026-05-23T12:00'))).toBe(false); // Sat
  });
});

describe('computeWorkingHours', () => {
  it('returns 0 if end <= start', () => {
    expect(computeWorkingHours(dt('2026-05-18T17:00'), dt('2026-05-18T15:00'))).toBe(0);
    expect(computeWorkingHours(dt('2026-05-18T17:00'), dt('2026-05-18T17:00'))).toBe(0);
  });
  it('counts a single full Monday session as 10 hours', () => {
    // Mon 15:00 → Tue 01:00 = 10 working hours
    const hours = computeWorkingHours(dt('2026-05-18T15:00'), dt('2026-05-19T01:00'));
    expect(hours).toBeCloseTo(10, 5);
  });
  it('skips Friday/Saturday from totals', () => {
    // Thu 3pm Sat 12noon → only the Thu session counts (10h)
    const hours = computeWorkingHours(dt('2026-05-21T15:00'), dt('2026-05-23T12:00'));
    expect(hours).toBeCloseTo(10, 5);
  });
  it('handles a 2-day span (Wed full + Thu partial)', () => {
    // Wed 15:00 → Thu 21:00 = Wed session (10h) + Thu 15:00–21:00 (6h) = 16h
    const hours = computeWorkingHours(dt('2026-05-20T15:00'), dt('2026-05-21T21:00'));
    expect(hours).toBeCloseTo(16, 5);
  });
  it('zero working hours over a weekend-only span', () => {
    // Fri 12:00 → Sun 12:00 = no working hours (Sun session starts 15:00)
    const hours = computeWorkingHours(dt('2026-05-22T12:00'), dt('2026-05-24T12:00'));
    expect(hours).toBeCloseTo(0, 5);
  });
});

describe('addWorkingHours', () => {
  it('adds 2 hours within a current session', () => {
    // Mon 16:00 + 2h = Mon 18:00
    const result = addWorkingHours(dt('2026-05-18T16:00'), 2);
    expect(result.toISO()).toContain('2026-05-18T18:00');
  });
  it('jumps to next session when adding past current session end', () => {
    // Mon 23:00 + 3h = (2h to 01:00, then 1h into Tue session = Tue 16:00)
    const result = addWorkingHours(dt('2026-05-18T23:00'), 3);
    expect(result.toISO()).toContain('2026-05-19T16:00');
  });
  it('jumps over the weekend (Thu evening + many hours)', () => {
    // Thu 23:00 + 3h = (2h to Fri 01:00, then 1h into Sun session = Sun 16:00)
    // Thu = 2026-05-21
    const result = addWorkingHours(dt('2026-05-21T23:00'), 3);
    expect(result.toISO()).toContain('2026-05-24T16:00');
  });
  it('adds 30m relative deadline within a session', () => {
    const result = addWorkingHours(dt('2026-05-18T16:00'), 0.5);
    expect(result.toISO()).toContain('2026-05-18T16:30');
  });
});
