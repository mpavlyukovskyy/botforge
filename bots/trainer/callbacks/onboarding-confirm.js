/**
 * Callback: onboarding-confirm (prefix: 'ob')
 *
 * Handles inline keyboard from onboarding analysis.
 * Actions: confirm, adjust, fresh
 */
import {
  ensureDb, getOnboardingAnalysis, setGoal, clearOnboardingAnalysis,
  getActiveGoals, getActiveProgram,
} from '../lib/db.js';

export default {
  prefix: 'ob',
  async execute(data, ctx) {
    const action = data.split(':')[1];
    if (!action) {
      await ctx.answerCallback('Error: invalid data');
      return;
    }

    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    if (action === 'confirm') {
      // Guard: don't re-set goals if already confirmed (double-tap protection)
      const existingGoals = getActiveGoals(ctx.config);
      if (existingGoals.length === 0) {
        const analysis = getOnboardingAnalysis(ctx.config);
        const goals = analysis?.inferred_goals_json
          ? JSON.parse(analysis.inferred_goals_json)
          : [];

        for (const g of goals) {
          setGoal(ctx.config, g.goal_text, g.category, null);
        }
      }

      // Answer callback toast immediately (before long Opus call)
      await ctx.answerCallback('Creating program...');

      await ctx.adapter.send({
        chatId,
        text: `Goals confirmed! Creating your training program now — this takes about a minute...`,
      });

      // Call create_program tool directly — no brain needed
      try {
        const createProgramTool = (await import('../tools/create_program.js')).default;
        const result = await createProgramTool.execute({}, ctx);
        await ctx.adapter.send({ chatId, text: result });
      } catch (err) {
        ctx.log?.warn?.(`create_program failed: ${err.message}`);
        await ctx.adapter.send({
          chatId,
          text: "Hit a snag generating the program. Send me any message and I'll try again.",
        });
      }

      // If program was created, go to normal mode. Otherwise keep program-design so brain retries.
      const program = getActiveProgram(ctx.config);
      ctx.store.set('mode', program ? 'normal' : 'program-design');
      return;
    }

    if (action === 'adjust') {
      const analysis = getOnboardingAnalysis(ctx.config);
      const goals = analysis?.inferred_goals_json
        ? JSON.parse(analysis.inferred_goals_json)
        : [];

      const goalList = goals.length > 0
        ? goals.map((g, i) => `${i + 1}. ${g.goal_text} (${g.category})`).join('\n')
        : 'No goals inferred.';

      ctx.store.set('mode', 'goal-setting');

      await ctx.adapter.send({
        chatId,
        text: `Here are the goals I inferred:\n${goalList}\n\nWhat would you like to change? Tell me your actual goals and I'll adjust.`,
      });
      await ctx.answerCallback('Tell me what to change');
      return;
    }

    if (action === 'fresh') {
      clearOnboardingAnalysis(ctx.config);
      ctx.store.set('mode', 'goal-setting');

      await ctx.adapter.send({
        chatId,
        text: "Starting fresh. Tell me:\n1. What are you training for?\n2. How many days per week?\n3. Any injuries or limitations?",
      });
      await ctx.answerCallback('Starting fresh');
      return;
    }

    await ctx.answerCallback('Unknown action');
  },
};
