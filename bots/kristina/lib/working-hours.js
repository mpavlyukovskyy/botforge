/**
 * Working hours math for Kristina's financial model.
 *
 * Workweek is Sun-Thu 3pm-1am Eastern (Mark's actual working window).
 * NOT a standard Mon-Fri workweek — do NOT change without consulting Mark.
 *
 * Ported verbatim from standalone kristina-bot src/scheduler/working-hours.ts.
 * Tested in working-hours.test.js (covers DST + relative deadlines).
 */
import { DateTime } from 'luxon';

const TZ = 'America/New_York';
// Luxon weekdays: 1=Mon ... 7=Sun. Work days = Sun, Mon, Tue, Wed, Thu.
const WORK_DAYS = new Set([7, 1, 2, 3, 4]);
const SESSION_HOURS = 10; // 15:00 → 01:00 next day

/** True if `dt` falls inside Mark's working window. */
export function isWorkingHours(dt) {
  const t = dt.setZone(TZ);
  const day = t.weekday;
  const hour = t.hour;

  // Main session: 15:00–23:59 on a work day
  if (hour >= 15 && WORK_DAYS.has(day)) return true;

  // Tail of session: 00:00–00:59 on the day AFTER a work day
  if (hour < 1) {
    const prevDay = day === 1 ? 7 : day - 1;
    if (WORK_DAYS.has(prevDay)) return true;
  }

  return false;
}

function getCurrentSession(dt) {
  const t = dt.setZone(TZ);
  const day = t.weekday;
  const hour = t.hour;

  if (hour >= 15 && WORK_DAYS.has(day)) {
    const start = t.set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
    const end = t.plus({ days: 1 }).set({ hour: 1, minute: 0, second: 0, millisecond: 0 });
    return { start, end };
  }

  if (hour < 1) {
    const prevDay = day === 1 ? 7 : day - 1;
    if (WORK_DAYS.has(prevDay)) {
      const start = t.minus({ days: 1 }).set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
      const end = t.set({ hour: 1, minute: 0, second: 0, millisecond: 0 });
      return { start, end };
    }
  }

  return null;
}

function getNextSessionStart(dt) {
  const t = dt.setZone(TZ);

  // Inside a session tail (<1am): if today is also a work day, next session starts today at 15:00
  if (t.hour < 1) {
    const prevDay = t.weekday === 1 ? 7 : t.weekday - 1;
    if (WORK_DAYS.has(prevDay) && WORK_DAYS.has(t.weekday)) {
      return t.set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
    }
  }

  // Same-day afternoon valid?
  if (t.hour < 15 && WORK_DAYS.has(t.weekday)) {
    return t.set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
  }

  // Otherwise advance day by day
  let candidate = t.hour < 15 ? t.startOf('day') : t.plus({ days: 1 }).startOf('day');
  for (let i = 0; i < 8; i++) {
    if (WORK_DAYS.has(candidate.weekday)) {
      return candidate.set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
    }
    candidate = candidate.plus({ days: 1 });
  }
  return candidate.set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
}

/**
 * Working hours elapsed between two DateTime points.
 * Counts ONLY time inside Sun-Thu 3pm-1am sessions.
 */
export function computeWorkingHours(start, end) {
  const s = start.setZone(TZ);
  const e = end.setZone(TZ);
  if (e <= s) return 0;

  let total = 0;
  let day = s.minus({ days: 1 }).startOf('day');
  const endBound = e.plus({ days: 1 }).startOf('day');

  while (day <= endBound) {
    if (WORK_DAYS.has(day.weekday)) {
      const sessionStart = day.set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
      const sessionEnd = day.plus({ days: 1 }).set({ hour: 1, minute: 0, second: 0, millisecond: 0 });
      const overlapStart = sessionStart > s ? sessionStart : s;
      const overlapEnd = sessionEnd < e ? sessionEnd : e;
      if (overlapStart < overlapEnd) {
        total += overlapEnd.diff(overlapStart, 'hours').hours;
      }
    }
    day = day.plus({ days: 1 });
  }
  return total;
}

/**
 * Add N working hours to a DateTime, skipping non-working periods.
 * Used to resolve "+2h" / "+30m" relative deadlines.
 */
export function addWorkingHours(from, hours) {
  let remaining = hours;
  let current = from.setZone(TZ);

  const session = getCurrentSession(current);
  if (session) {
    const available = session.end.diff(current, 'hours').hours;
    if (remaining <= available) return current.plus({ hours: remaining });
    remaining -= available;
    current = session.end;
  }

  while (remaining > 0) {
    const nextStart = getNextSessionStart(current);
    if (remaining <= SESSION_HOURS) return nextStart.plus({ hours: remaining });
    remaining -= SESSION_HOURS;
    current = nextStart.plus({ hours: SESSION_HOURS });
  }
  return current;
}

/**
 * True if `dt` is on a work day (Sun-Thu), regardless of hour.
 * Used by nudge cron — even if the cron fires inside working hours,
 * we only nudge on work days.
 */
export function isWorkingDay(dt) {
  const wd = dt.setZone(TZ).weekday;
  return wd === 7 || wd <= 4;
}

export const TIMEZONE = TZ;
