/**
 * Callback: workout-time (prefix: 'wt')
 *
 * Handles time selection buttons from the recovery prompt.
 * callback_data format: 'wt:MINUTES'
 * Actions: 30, 45, 60, 90
 *
 * Hardened 2026-05-21:
 *   - Dispatch counter for live diagnosis of dup-fire scenarios
 *   - In-flight guard so even if dedup is bypassed, generateAdaptedWorkout
 *     only runs once per chat at a time
 */
import { generateAdaptedWorkout } from '../cron/morning-workout.js';
import { ensureDb } from '../lib/db.js';

let _wtDispatchCount = 0;

export default {
  prefix: 'wt',
  async execute(data, ctx) {
    const timeStr = data.split(':')[1];

    // Red-day "Rest" button (added 2026-05-24) — explicit no-go acknowledgment.
    if (timeStr === 'rest') {
      await ctx.answerCallback('Resting today');
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: 'Rest day acknowledged. See you tomorrow.',
      });
      return;
    }

    const timeMinutes = parseInt(timeStr, 10);
    if (!timeMinutes || ![20, 30, 45, 60, 90].includes(timeMinutes)) {
      await ctx.answerCallback('Invalid time');
      return;
    }

    _wtDispatchCount += 1;
    const myCount = _wtDispatchCount;
    ctx.log?.info?.(`[WT_DISPATCH] count=${myCount} minutes=${timeMinutes} chat=${ctx.chatId}`);

    // ACK the callback FIRST — closes Telegram's 15s retry window before any
    // slow work begins.
    await ctx.answerCallback(`${timeMinutes}min workout...`);
    const chatId = ctx.chatId;

    // In-flight guard: refuse to run generateAdaptedWorkout twice in parallel.
    // Catches the "tapped Confirm twice while Sonnet is mid-call" class.
    if (ctx.store.get('generating_workout')) {
      ctx.log?.warn?.(`[WT_DISPATCH] count=${myCount} — generating_workout already in flight, skipping`);
      await ctx.adapter.send({ chatId, text: 'Already building your workout — give me a minute.' });
      return;
    }
    ctx.store.set('generating_workout', true);

    try {
      await ctx.adapter.send({ chatId, text: `Building your ${timeMinutes}-minute workout...` });
      ensureDb(ctx.config);
      await generateAdaptedWorkout(ctx, chatId, timeMinutes);
      ctx.log?.info?.(`[WT_DISPATCH] count=${myCount} — completed`);
    } catch (err) {
      ctx.log?.warn?.(`workout-time callback failed: ${err.message}`);
      await ctx.adapter.send({ chatId, text: `Failed to generate workout: ${err.message}` });
    } finally {
      ctx.store.set('generating_workout', false);
    }
  },
};
