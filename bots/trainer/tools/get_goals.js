/**
 * Brain tool: get_goals
 *
 * Returns active training goals.
 */
import { z } from 'zod';
import { ensureDb, getActiveGoals } from '../lib/db.js';

export default {
  name: 'get_goals',
  description: 'Get all active training goals.',
  schema: {},
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const goals = getActiveGoals(ctx.config);

    if (goals.length === 0) {
      return 'No active goals set. Use /goals to start setting training goals.';
    }

    const lines = goals.map((g, i) => {
      let line = `${i + 1}. ${g.goal_text}`;
      if (g.category) line += ` [${g.category}]`;
      if (g.target_date) line += ` (target: ${g.target_date})`;
      return line;
    });

    return `Active goals:\n${lines.join('\n')}`;
  },
};
