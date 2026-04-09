/**
 * Context builder: goal_summary
 *
 * Injects active goals (1 line each).
 */
import { ensureDb, getActiveGoals } from '../lib/db.js';

export default {
  type: 'goal_summary',
  async build(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return '';
    }

    const goals = getActiveGoals(ctx.config);
    if (goals.length === 0) return '';

    const lines = goals.map(g => {
      let line = g.goal_text;
      if (g.category) line += ` [${g.category}]`;
      return line;
    });

    return `<goal_summary>${lines.join('; ')}</goal_summary>`;
  },
};
