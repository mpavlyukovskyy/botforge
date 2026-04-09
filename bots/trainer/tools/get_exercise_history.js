/**
 * Brain tool: get_exercise_history
 *
 * Returns weight/rep history for a specific exercise from the workout cache.
 */
import { z } from 'zod';
import { ensureDb, getCachedWorkouts } from '../lib/db.js';

export default {
  name: 'get_exercise_history',
  description: 'Get weight and rep history for a specific exercise name. Searches cached workouts.',
  schema: {
    exercise_name: z.string().describe('Exercise name to search for (e.g. "Bench Press")'),
    days: z.number().optional().describe('Number of days to look back (default 60)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const days = args.days || 60;
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const searchName = args.exercise_name.toLowerCase();

    const workouts = getCachedWorkouts(ctx.config, startDate, endDate);
    const history = [];

    for (const w of workouts) {
      const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
      for (const ex of exercises) {
        if (ex.title?.toLowerCase().includes(searchName)) {
          const workingSets = (ex.sets || []).filter(s => s.type === 'normal');
          const topSet = workingSets.sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
          history.push({
            date: w.date,
            exercise: ex.title,
            sets: workingSets.length,
            top_weight_kg: topSet?.weight_kg || 0,
            top_reps: topSet?.reps || 0,
            total_volume: workingSets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0),
          });
        }
      }
    }

    if (history.length === 0) {
      return `No history found for "${args.exercise_name}" in the last ${days} days.`;
    }

    const lines = history.map(h =>
      `${h.date}: ${h.exercise} — ${h.sets} sets, top ${h.top_weight_kg}kg x ${h.top_reps}, vol ${Math.round(h.total_volume)}kg`
    );

    return `Exercise history for "${args.exercise_name}" (last ${days} days):\n${lines.join('\n')}`;
  },
};
