/**
 * Brain tool: generate_timed_workout
 *
 * Generate today's workout adapted to time + recovery.
 * Sends the workout card directly to chat.
 */
import { z } from 'zod';
import { ensureDb, getActiveProgram } from '../lib/db.js';
import { generateAdaptedWorkout } from '../cron/morning-workout.js';

export default {
  name: 'generate_timed_workout',
  description: "Generate today's workout adapted to the given time and current recovery. Sends the workout card directly.",
  schema: {
    minutes: z.number().min(15).max(120).describe('Workout duration in minutes'),
  },
  async execute(args, ctx) {
    ensureDb(ctx.config);
    const program = getActiveProgram(ctx.config);
    if (!program) return 'No active program. Use /program new to create one.';

    const chatId = ctx.chatId;
    try {
      await generateAdaptedWorkout(ctx, chatId, args.minutes);
      return 'Workout generated and sent.';
    } catch (err) {
      return `Failed to generate workout: ${err.message}`;
    }
  },
};
