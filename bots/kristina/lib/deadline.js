/**
 * Deadline normalization.
 *
 * The brain has emitted non-ISO deadline values (notably relative durations
 * like "+2h"/"+0h"). When such a value reached Atlas it became
 * `new Date("+2h")` → Invalid Date → a PrismaClientValidationError → HTTP 500
 * that stalled the whole sync pipe (incident 2026-06-07). Stored locally it
 * also breaks SQLite `datetime(deadline)` comparisons in the decay /
 * deadline-expiry crons.
 *
 * normalizeDeadline() is the single chokepoint every deadline passes through
 * before it is sent to Atlas or written to SQLite. It returns a parseable
 * date string or null — never an unparseable value.
 */
import { DateTime } from 'luxon';
import { TIMEZONE } from './working-hours.js';

/**
 * @param {unknown} input  Raw deadline from the brain (string | undefined).
 * @param {DateTime} [now] Reference time (ET); injectable for tests.
 * @returns {string|null}  ISO date/datetime string, or null if unparseable.
 */
export function normalizeDeadline(input, now) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  const ref = now || DateTime.now().setZone(TIMEZONE);

  // Relative durations: "+2h", "+0h", "+3 days", "+1w". Bare "m" is rejected
  // (month vs minute ambiguous) — only explicit "min"/"minute(s)" count.
  const rel = s.match(/^\+\s*(\d+(?:\.\d+)?)\s*(mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i);
  if (rel) {
    const n = parseFloat(rel[1]);
    const unit = rel[2].toLowerCase();
    let dur;
    if (unit.startsWith('min')) dur = { minutes: n };
    else if (unit.startsWith('h')) dur = { hours: n };
    else if (unit.startsWith('w')) dur = { weeks: n };
    else dur = { days: n };
    return ref.plus(dur).toISO();
  }

  // Bare calendar date — the documented, common case. Keep as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return DateTime.fromISO(s, { zone: TIMEZONE }).isValid ? s : null;
  }

  // Full ISO 8601 (e.g. "2026-06-04T05:00:00.000Z") — keep the original.
  if (DateTime.fromISO(s, { zone: TIMEZONE }).isValid) return s;

  // Last resort: anything the JS Date parser accepts (e.g. "June 4 2026").
  const js = new Date(s);
  if (!isNaN(js.getTime())) return s;

  // Unparseable — drop it rather than poison the pipe.
  return null;
}
