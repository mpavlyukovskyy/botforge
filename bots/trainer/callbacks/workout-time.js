/**
 * Callback: workout-time (prefix: 'wt')
 *
 * Handles time selection buttons from the recovery prompt.
 * callback_data format: 'wt:MINUTES'
 * Actions: 30, 45, 60, 90
 */
import { generateAdaptedWorkout } from '../cron/morning-workout.js';
import { ensureDb } from '../lib/db.js';

export default {
  prefix: 'wt',
  async execute(data, ctx) {
    const timeStr = data.split(':')[1];
    const timeMinutes = parseInt(timeStr, 10);
    if (!timeMinutes || ![30, 45, 60, 90].includes(timeMinutes)) {
      await ctx.answerCallback('Invalid time');
      return;
    }

    await ctx.answerCallback(`${timeMinutes}min workout...`);
    const chatId = ctx.chatId;

    try {
      await ctx.adapter.send({ chatId, text: `Building your ${timeMinutes}-minute workout...` });
      ensureDb(ctx.config);
      await generateAdaptedWorkout(ctx, chatId, timeMinutes);
    } catch (err) {
      ctx.log?.warn?.(`workout-time callback failed: ${err.message}`);
      await ctx.adapter.send({ chatId, text: `Failed to generate workout: ${err.message}` });
    }
  },
};
