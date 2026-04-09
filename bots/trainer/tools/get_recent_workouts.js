/**
 * Brain tool: get_recent_workouts
 *
 * Returns recent workouts from the local cache (populated by daily sync).
 */
import { z } from 'zod';
import { ensureDb, getCachedWorkouts } from '../lib/db.js';

export default {
  name: 'get_recent_workouts',
  description: 'Get recent workouts from cache. Returns last 14 days by default.',
  schema: {
    days: z.number().optional().describe('Number of days to look back (default 14)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Workout database not available.';
    }

    const days = args.days || 14;
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const workouts = getCachedWorkouts(ctx.config, startDate, endDate);

    if (workouts.length === 0) {
      return `No cached workouts in the last ${days} days. The daily sync may not have run yet.`;
    }

    const formatted = workouts.map(w => {
      const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
      const exerciseList = exercises.map(ex => {
        const topSet = ex.sets?.filter(s => s.type === 'normal')
          .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
        const topStr = topSet
          ? `${topSet.weight_kg || 0}kg x ${topSet.reps || 0}`
          : '';
        return `  - ${ex.title} (${ex.sets?.length || 0} sets${topStr ? ', top: ' + topStr : ''})`;
      }).join('\n');

      return `${w.date} — ${w.title || 'Workout'}${w.duration_seconds ? ` (${Math.round(w.duration_seconds / 60)}min)` : ''}\n${exerciseList}`;
    });

    return formatted.join('\n\n');
  },
};
