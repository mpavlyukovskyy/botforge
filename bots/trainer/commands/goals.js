/**
 * Command: /goals
 *
 * Sets goal-setting mode and sends initial prompt.
 * The brain (Sonnet) handles the multi-turn conversation via mode detection.
 */
import { ensureDb, getActiveGoals } from '../lib/db.js';

export default {
  command: 'goals',
  description: 'Set or review your training goals',
  async execute(args, ctx) {
    const chatId = ctx.chatId;

    try {
      ensureDb(ctx.config);
    } catch {
      await ctx.adapter.send({ chatId, text: 'Database not available.' });
      return;
    }

    const goals = getActiveGoals(ctx.config);

    if (goals.length > 0 && (!args || !args.trim())) {
      // Show existing goals
      const goalList = goals.map((g, i) => {
        let line = `${i + 1}. ${g.goal_text}`;
        if (g.category) line += ` [${g.category}]`;
        if (g.target_date) line += ` (target: ${g.target_date})`;
        return line;
      }).join('\n');

      await ctx.adapter.send({
        chatId,
        text: `Your current goals:\n${goalList}\n\nSay /goals new to set new goals, or just tell me what you want to change.`,
      });
      return;
    }

    // Enter goal-setting mode
    ctx.store.set('mode', 'goal-setting');

    await ctx.adapter.send({
      chatId,
      text: "Let's set your training goals. Tell me:\n\n1. What are you training for? (strength, muscle, endurance, body comp, etc.)\n2. What's your current experience level?\n3. How many days per week can you train?\n\nTake your time — we'll figure this out together.",
    });
  },
};
