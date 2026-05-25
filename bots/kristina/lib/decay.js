/**
 * Decay calculations for the Kristina financial model.
 *
 * Each task is worth $1.00 if delivered on time. Past deadline, the value
 * decays linearly to $0 over 20 working hours, then continues negative
 * (capped only by sanity in the UI). Handed-off tasks freeze at $1.00.
 *
 * "Working hour" = Sun-Thu 3pm-1am ET. See lib/working-hours.js.
 *
 * Extracted from standalone kristina-bot src/ai/tools.ts:computeDecayValue
 * so it can be unit-tested independently of the tool registry.
 */
import { DateTime } from 'luxon';
import { computeWorkingHours, TIMEZONE } from './working-hours.js';

const BOUNTY_USD = 1.0;
const DECAY_WINDOW_WORKING_HOURS = 20;

/**
 * Compute current decaying value for a task.
 *
 * @param {string} deadlineIso - ISO date or datetime string
 * @param {DateTime} [now] - override "now" for testing
 * @returns {{value:number, tenthsElapsed:number, daysOverdue:number}}
 *   - value: current dollar value (can go negative past 20 working hours)
 *   - tenthsElapsed: 0-10, how many tenths of the 20h decay window have passed
 *   - daysOverdue: working hours overdue / 10 (one "session" = 10 working hours)
 */
export function computeDecayValue(deadlineIso, now) {
  const end = DateTime.fromISO(deadlineIso, { zone: TIMEZONE }).endOf('day');
  const current = now || DateTime.now().setZone(TIMEZONE);

  // Before/at deadline: full bounty
  if (current <= end) {
    return { value: BOUNTY_USD, tenthsElapsed: 0, daysOverdue: 0 };
  }

  // Past deadline: linear from $1.00 → $0 over 20 working hours
  const overtimeHours = computeWorkingHours(end, current);
  const value = Math.round((BOUNTY_USD - overtimeHours / DECAY_WINDOW_WORKING_HOURS) * 100) / 100;
  const tenthsElapsed = Math.min(Math.floor(overtimeHours / 2), 10);
  const daysOverdue = overtimeHours / 10; // 10 working hours = 1 "session"

  return { value, tenthsElapsed, daysOverdue };
}

/**
 * Format a financial note for use in user-facing strings.
 *
 * @param {number} earnedValue
 * @param {number} daysOverdue
 * @returns {string}
 */
export function formatFinancialNote(earnedValue, daysOverdue = 0) {
  if (earnedValue >= BOUNTY_USD) return '+$1.00';
  if (earnedValue > 0) {
    const hoursLate = Math.round(daysOverdue * 10);
    return `+$${earnedValue.toFixed(2)} (${hoursLate}h overdue)`;
  }
  const sessions = Math.round(daysOverdue);
  return `-$${Math.abs(earnedValue).toFixed(2)} (${sessions} session${sessions === 1 ? '' : 's'} overdue)`;
}

export const BOUNTY = BOUNTY_USD;
export const DECAY_HOURS = DECAY_WINDOW_WORKING_HOURS;
