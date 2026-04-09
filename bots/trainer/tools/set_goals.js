/**
 * Brain tool: set_goals
 *
 * Create or update training goals.
 */
import { z } from 'zod';
import { ensureDb, setGoal, updateGoalStatus, getActiveGoals } from '../lib/db.js';

export default {
  name: 'set_goals',
  description: 'Create a new training goal or update an existing one. Use action "create" for new goals, "complete" or "archive" for existing ones.',
  schema: {
    action: z.enum(['create', 'complete', 'archive']).describe('Action: create a new goal, or complete/archive an existing one'),
    goal_text: z.string().optional().describe('Goal description (required for create)'),
    category: z.string().optional().describe('Category: strength, hypertrophy, endurance, body_composition, mobility, general'),
    target_date: z.string().optional().describe('Target date in YYYY-MM-DD format'),
    goal_id: z.number().optional().describe('Goal ID (required for complete/archive)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    if (args.action === 'create') {
      if (!args.goal_text) return 'Goal text is required for creating a new goal.';

      setGoal(ctx.config, args.goal_text, args.category, args.target_date);
      const goals = getActiveGoals(ctx.config);
      return `Goal created: "${args.goal_text}"\n\nYou now have ${goals.length} active goal(s).`;
    }

    if (args.action === 'complete' || args.action === 'archive') {
      if (!args.goal_id) return 'Goal ID is required to complete or archive a goal.';
      updateGoalStatus(ctx.config, args.goal_id, args.action === 'complete' ? 'completed' : 'archived');
      return `Goal #${args.goal_id} marked as ${args.action === 'complete' ? 'completed' : 'archived'}.`;
    }

    return 'Invalid action. Use "create", "complete", or "archive".';
  },
};
