/**
 * Brain tool: skip_workout
 *
 * Log a rest day / skipped workout.
 */
import { z } from 'zod';
import { ensureDb, createCheckIn } from '../lib/db.js';

export default {
  name: 'skip_workout',
  description: 'Log a skipped workout or rest day with an optional reason.',
  schema: {
    reason: z.string().optional().describe('Reason for skipping (e.g. "feeling sick", "travel day", "extra rest")'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const date = new Date().toISOString().slice(0, 10);
    const reason = args.reason || 'No reason specified';

    createCheckIn(ctx.config, 'skip', `Skipped workout on ${date}: ${reason}`, {
      date,
      reason,
    });

    return `Rest day logged for ${date}. Reason: ${reason}. Take it easy and recover well.`;
  },
};
