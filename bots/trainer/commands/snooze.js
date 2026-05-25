/**
 * Command: /snooze [N]
 *
 * Pushes tonight's bedtime target N minutes later (default 15, range [5, 60]).
 * Per-night only — tomorrow recomputes from base. Caps at 1:45am ceiling.
 *
 * Unsets `source: skipped` if it was set earlier (user changed their mind).
 */
import { ensureDb } from '../lib/db.js';
import {
  resolveWakeDate,
  getEffectiveTarget,
  setBedtimeOverride,
  computeIdealBedtime,
  formatEtTime,
  toMinutes,
  fromMinutes,
  parseEtTime,
  getLastNightContext,
  CEILING_BED_TIME_ET,
  FLOOR_BED_TIME_ET,
} from '../lib/bedtime-helper.js';

const DEFAULT_SNOOZE_MIN = 15;
const MIN_SNOOZE_MIN = 5;
const MAX_SNOOZE_MIN = 60;

export default {
  command: 'snooze',
  description: 'Push tonight bedtime later (default +15, max +60)',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    // Parse minutes argument
    let minutes = DEFAULT_SNOOZE_MIN;
    const raw = (args || '').trim();
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        minutes = Math.max(MIN_SNOOZE_MIN, Math.min(MAX_SNOOZE_MIN, parsed));
      }
    }

    const wakeDate = resolveWakeDate();
    const { lastNightSleepMin, lastNightRecovery } = await getLastNightContext(ctx.config, ctx.log);

    // Current effective target (override > cached > computed)
    const current = getEffectiveTarget(ctx.config, wakeDate, {
      lastNightSleepMin,
      lastNightRecovery,
    });

    // If current was 'skipped', use computed base instead (user un-skipping)
    let baseHour = current.hour;
    let baseMinute = current.minute;
    if (current.source === 'skipped') {
      const fresh = computeIdealBedtime({ lastNightSleepMin, lastNightRecovery });
      baseHour = fresh.hour;
      baseMinute = fresh.minute;
    }

    // Apply snooze, clamped to ceiling
    const ceiling = toMinutes(parseEtTime(CEILING_BED_TIME_ET));
    const floor = toMinutes(parseEtTime(FLOOR_BED_TIME_ET));
    let newMin = toMinutes({ hour: baseHour, minute: baseMinute }) + minutes;
    // The day-rollover-ness: bedtime range 0:30-1:45 stays within early morning
    // hours, so straight clamp works.
    newMin = Math.max(floor, Math.min(ceiling, newMin));
    const newTime = fromMinutes(newMin);

    setBedtimeOverride(ctx.config, wakeDate, {
      target_h: newTime.hour,
      target_m: newTime.minute,
      source: 'snooze',
      snoozed_min: minutes,
    });

    await ctx.adapter.send({
      chatId,
      text: `Tonight only: ${formatEtTime(newTime)}. Back to normal tomorrow.`,
    });
  },
};
