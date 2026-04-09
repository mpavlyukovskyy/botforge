/**
 * Command: /progress
 *
 * On-demand progress summary using recent workout data and goals.
 */
import { ensureDb, getActiveProgram, getActiveGoals, getCachedWorkouts, getRecoveryRange } from '../lib/db.js';
import { callSonnet } from '../lib/claude.js';

export default {
  command: 'progress',
  description: 'Get a progress report on your training',
  async execute(args, ctx) {
    const chatId = ctx.chatId;

    try {
      ensureDb(ctx.config);
    } catch {
      await ctx.adapter.send({ chatId, text: 'Database not available.' });
      return;
    }

    await ctx.adapter.send({ chatId, text: 'Generating progress report...' });

    // Gather data
    const goals = getActiveGoals(ctx.config);
    const program = getActiveProgram(ctx.config);

    const endDate = new Date().toISOString().slice(0, 10);
    const startDate14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const workouts = getCachedWorkouts(ctx.config, startDate14, endDate);
    const recovery = getRecoveryRange(ctx.config, startDate14, endDate);

    // Format data for Claude
    const dataContext = [];

    if (goals.length > 0) {
      dataContext.push('GOALS:\n' + goals.map(g => `- ${g.goal_text}`).join('\n'));
    }

    if (program) {
      dataContext.push(`PROGRAM: ${program.title}, Week ${program.current_week}/${program.total_weeks}`);
    }

    if (workouts.length > 0) {
      const workoutSummary = workouts.map(w => {
        const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
        const topSets = exercises.map(ex => {
          const top = ex.sets?.filter(s => s.type === 'normal')
            .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
          return top ? `${ex.title}: ${top.weight_kg}kg x ${top.reps}` : ex.title;
        }).join(', ');
        return `${w.date}: ${w.title} — ${topSets}`;
      }).join('\n');
      dataContext.push(`RECENT WORKOUTS (${workouts.length} in 14 days):\n${workoutSummary}`);
    } else {
      dataContext.push('No workouts in last 14 days.');
    }

    if (recovery.length > 0) {
      const avgRecovery = recovery
        .filter(r => r.whoop_recovery_score != null)
        .reduce((sum, r) => sum + r.whoop_recovery_score, 0) / recovery.filter(r => r.whoop_recovery_score != null).length;
      dataContext.push(`RECOVERY: ${recovery.length} days logged, avg Whoop recovery ${Math.round(avgRecovery)}%`);
    }

    const result = await callSonnet(
      'You are a personal trainer reviewing training progress. Be concise, specific, and actionable. Use Telegram-friendly formatting.',
      `Generate a brief progress report based on this data:\n\n${dataContext.join('\n\n')}\n\nInclude: training consistency, notable lifts, recovery trends, and 1-2 actionable suggestions.`
    );

    if (result.is_error) {
      await ctx.adapter.send({ chatId, text: `Failed to generate report: ${result.text}` });
      return;
    }

    await ctx.adapter.send({
      chatId,
      text: result.text,
      parseMode: 'Markdown',
    });
  },
};
