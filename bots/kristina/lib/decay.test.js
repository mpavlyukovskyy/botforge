/**
 * Tests for decay.js — the linear $1→$0 over 20 working hours decay model.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { computeDecayValue, formatFinancialNote, BOUNTY, DECAY_HOURS } from './decay.js';
import { TIMEZONE } from './working-hours.js';

const dt = (iso) => DateTime.fromISO(iso, { zone: TIMEZONE });

describe('computeDecayValue', () => {
  it('returns full $1.00 before deadline', () => {
    // Deadline = end of Friday, now = Thursday morning → before deadline
    const result = computeDecayValue('2026-05-22', dt('2026-05-21T10:00'));
    expect(result.value).toBe(BOUNTY);
    expect(result.tenthsElapsed).toBe(0);
    expect(result.daysOverdue).toBe(0);
  });
  it('returns full $1.00 at exact end-of-deadline-day', () => {
    // deadline becomes end-of-day in ET
    const result = computeDecayValue('2026-05-18', dt('2026-05-18T23:59'));
    expect(result.value).toBe(BOUNTY);
  });
  it('decays partially after some overtime working hours', () => {
    // Deadline = 2026-05-18 endOfDay ET = 2026-05-19T00:00 in calendar terms
    // (this is the tail of Monday's session, since Mon session runs 15:00 Mon → 01:00 Tue).
    // Now = Tue 20:00. Working hours past deadline:
    //   00:00→01:00 = 1h (tail of Mon session)
    //   01:00→15:00 = 0h (out of session)
    //   15:00→20:00 = 5h (Tue session)
    // Total = 6h → value = 1.0 - 6/20 = 0.70
    const result = computeDecayValue('2026-05-18', dt('2026-05-19T20:00'));
    expect(result.value).toBeCloseTo(BOUNTY - 6 / DECAY_HOURS, 2);
    expect(result.value).toBeGreaterThan(0);
  });
  it('reaches $0 after exactly 20 working hours overdue', () => {
    // Deadline = Mon end-of-day (00:00 Tue). 20 working hours past =
    // Tue session (10h) + Wed session (10h) — but we start AT Mon 23:59ish.
    // Use a clean reference: deadline 2026-05-18, 20wh later via Tue 01:00 + Wed 01:00.
    // 10wh through Mon→Tue session, 10wh through Tue→Wed session = Wed 01:00.
    // Actually deadline is end-of-day Mon = Tue 00:00 (entering tail of Mon session).
    // From Tue 00:00, 1h to Tue 01:00 (session end), then Tue session 15:00-Wed 01:00 (10h),
    // then Wed 15:00 + 9h = Thu 00:00. That's 1+10+9 = 20 working hours.
    const result = computeDecayValue('2026-05-18', dt('2026-05-21T00:00'));
    expect(result.value).toBeCloseTo(0, 1);
  });
  it('goes negative past 20 working hours overdue', () => {
    // Far past deadline → negative value
    const result = computeDecayValue('2026-05-01', dt('2026-05-22T16:00'));
    expect(result.value).toBeLessThan(0);
  });
  it('value rounded to 2 decimal places', () => {
    const result = computeDecayValue('2026-05-18', dt('2026-05-19T18:30'));
    // Should be a number with at most 2 decimal places
    expect(Math.round(result.value * 100) / 100).toBe(result.value);
  });
});

describe('formatFinancialNote', () => {
  it('formats $1.00 plainly', () => {
    expect(formatFinancialNote(1.0)).toBe('+$1.00');
  });
  it('formats partial value with hoursLate', () => {
    expect(formatFinancialNote(0.5, 0.5)).toBe('+$0.50 (5h overdue)');
  });
  it('formats negative value with sessions overdue', () => {
    expect(formatFinancialNote(-0.5, 3)).toBe('-$0.50 (3 sessions overdue)');
  });
  it('uses singular session', () => {
    expect(formatFinancialNote(-0.1, 1)).toBe('-$0.10 (1 session overdue)');
  });
});
