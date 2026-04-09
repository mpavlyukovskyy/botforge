/**
 * Command: /program
 *
 * View current program or initiate program design.
 */
import { ensureDb, getActiveProgram, getActiveGoals } from '../lib/db.js';

export default {
  command: 'program',
  description: 'View current program or design a new one',
  async execute(args, ctx) {
    const chatId = ctx.chatId;

    try {
      ensureDb(ctx.config);
    } catch {
      await ctx.adapter.send({ chatId, text: 'Database not available.' });
      return;
    }

    const program = getActiveProgram(ctx.config);

    if (args && args.trim().toLowerCase() === 'new') {
      // Start program design
      const goals = getActiveGoals(ctx.config);
      if (goals.length === 0) {
        await ctx.adapter.send({
          chatId,
          text: "You don't have any goals set yet. Use /goals first to define what you're training for.",
        });
        return;
      }

      ctx.store.set('mode', 'program-design');

      await ctx.adapter.send({
        chatId,
        text: "Let's design a new program. I'll review your goals and recent training to build something tailored.\n\nAnything specific you want me to keep in mind? (equipment, schedule constraints, exercises you love/hate, injuries)\n\nOr just say 'go' and I'll design based on your goals.",
      });
      return;
    }

    if (!program) {
      await ctx.adapter.send({
        chatId,
        text: "No active program. Use /program new to design one (set goals first with /goals).",
      });
      return;
    }

    // Show current program summary
    let programData;
    try {
      programData = JSON.parse(program.program_json);
    } catch {
      await ctx.adapter.send({ chatId, text: 'Program data is corrupted.' });
      return;
    }

    const template = programData.weekly_template || {};
    const daysSummary = Object.entries(template).map(([day, session]) => {
      const exCount = session.exercises?.length || 0;
      return `  ${day}: ${session.name} (${exCount} exercises)`;
    }).join('\n');

    await ctx.adapter.send({
      chatId,
      text: `*${program.title}*\nWeek ${program.current_week} of ${program.total_weeks}\n${programData.split} split, ${programData.days_per_week} days/week\n\n${daysSummary}\n\nUse /program new to design a replacement.`,
      parseMode: 'Markdown',
    });
  },
};
