import { describe, it, expect } from 'vitest';
import { formatWorkoutDate } from '../cron/morning-workout.js';

describe('formatWorkoutDate', () => {
  it('returns weekday, month, and day', () => {
    const result = formatWorkoutDate(new Date('2026-05-12T12:00:00'));
    expect(result).toBe('Tuesday, May 12');
  });

  it('handles different days', () => {
    const result = formatWorkoutDate(new Date('2026-01-01T12:00:00'));
    expect(result).toBe('Thursday, January 1');
  });

  it('returns truthy value (not filtered by .filter(Boolean))', () => {
    expect(formatWorkoutDate()).toBeTruthy();
  });

  it('defaults to current date when no argument', () => {
    const result = formatWorkoutDate();
    expect(result).toMatch(/^\w+, \w+ \d{1,2}$/);
  });
});
