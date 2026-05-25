/**
 * Command: /late <hour>
 *
 * Travel mode for one night — overrides tonight's bedtime target. Examples:
 *   /late 3am
 *   /late 3:30am
 *   /late 03:30
 *
 * Clamped to [11:00pm, 4:00am]. Tomorrow recomputes from base.
 */
import { ensureDb } from '../lib/db.js';
import {
  resolveWakeDate,
  setBedtimeOverride,
  parseEtTime,
  formatEtTime,
  toMinutes,
  fromMinutes,
} from '../lib/bedtime-helper.js';

const LATE_FLOOR_HOUR = 23;     // 11:00pm
const LATE_FLOOR_MIN = 23 * 60;
const LATE_CEILING_MIN = 4 * 60; // 4:00am

export default {
  command: 'late',
  description: 'Travel mode — override target for tonight (e.g. /late 3am)',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    const raw = (args || '').trim();
    const parsed = parseEtTime(raw);
    if (!parsed) {
      await ctx.adapter.send({
        chatId,
        text: 'Usage: /late <hour>  — e.g. /late 3am, /late 3:30am, /late 03:30',
      });
      return;
    }

    // Validate: target must be in [11pm, 4am] window
    const parsedMin = toMinutes(parsed);
    const inRange = parsedMin >= LATE_FLOOR_MIN || parsedMin <= LATE_CEILING_MIN;
    if (!inRange) {
      await ctx.adapter.send({
        chatId,
        text: `Travel target must be 11pm-4am ET. Got ${formatEtTime(parsed)}.`,
      });
      return;
    }

    const wakeDate = resolveWakeDate();
    setBedtimeOverride(ctx.config, wakeDate, {
      target_h: parsed.hour,
      target_m: parsed.minute,
      source: 'travel',
    });

    await ctx.adapter.send({
      chatId,
      text: `Travel mode: ${formatEtTime(parsed)}. Normal schedule resumes tomorrow.`,
    });
  },
};
