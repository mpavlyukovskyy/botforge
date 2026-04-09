/**
 * Command: /workout
 *
 * Triggers the morning workout flow on-demand.
 * Reuses the morning-workout cron logic.
 */
import { sendWorkoutPrompt } from '../cron/morning-workout.js';

export default {
  command: 'workout',
  description: "Get today's workout",
  async execute(args, ctx) {
    const chatId = ctx.chatId;

    try {
      await sendWorkoutPrompt(ctx, chatId);
    } catch (err) {
      await ctx.adapter.send({
        chatId,
        text: `Failed to generate workout: ${err.message}`,
      });
    }
  },
};
