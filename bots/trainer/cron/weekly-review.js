/**
 * Cron handler: weekly_review
 *
 * Sunday 8pm ET — Progress review, advance program week, detect completion.
 */
import {
  ensureDb, getActiveProgram, getActiveGoals,
  getCachedWorkouts, getRecoveryRange,
  advanceProgramWeek, completeProgramById,
  createCheckIn,
} from '../lib/db.js';
import { callSonnet } from '../lib/claude.js';

export default {
  name: 'weekly_review',
  async execute(ctx) {
    const chatId = ctx.store?.get('chat_id')
      || ctx.config.platform?.chat_ids?.[0]
      || process.env.TRAINER_CHAT_ID;

    if (!chatId) {
      ctx.log.warn('Weekly review: no chat ID configured');
      return;
    }

    try {
      ensureDb(ctx.config);
    } catch {
      ctx.log.error('Weekly review: DB not available');
      return;
    }

    const program = getActiveProgram(ctx.config);
    if (!program) {
      ctx.log.info('Weekly review: no active program, skipping');
      return;
    }

    const goals = getActiveGoals(ctx.config);

    // Gather this week's data
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const workouts = getCachedWorkouts(ctx.config, weekAgo, today);
    const recovery = getRecoveryRange(ctx.config, weekAgo, today);

    // Count programmed sessions this week
    let programData;
    try {
      programData = JSON.parse(program.program_json);
    } catch {
      return;
    }
    const programmedDays = Object.keys(programData.weekly_template || {}).length;

    // Format data for Claude
    const workoutSummary = workouts.map(w => {
      const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
      return `${w.date}: ${w.title} — ${exercises.map(e => e.title).join(', ')}`;
    }).join('\n') || 'No workouts logged.';

    const recoveryAvg = recovery.filter(r => r.whoop_recovery_score != null);
    const avgRecovery = recoveryAvg.length > 0
      ? Math.round(recoveryAvg.reduce((s, r) => s + r.whoop_recovery_score, 0) / recoveryAvg.length)
      : null;

    const dataContext = `
PROGRAM: ${program.title}, completing week ${program.current_week} of ${program.total_weeks}
PROGRAMMED SESSIONS: ${programmedDays}/week
ACTUAL WORKOUTS THIS WEEK: ${workouts.length}

WORKOUTS:
${workoutSummary}

RECOVERY: ${avgRecovery != null ? `avg ${avgRecovery}%` : 'no data'} over ${recovery.length} days

GOALS:
${goals.map(g => `- ${g.goal_text}`).join('\n') || 'None set.'}
`.trim();

    // Generate narrative
    const result = await callSonnet(
      'You are a personal trainer writing a weekly review. Be concise, specific, and actionable. Use bullet points. Telegram-friendly formatting.',
      `Write a brief weekly training review based on this data:\n\n${dataContext}\n\nInclude: compliance (sessions done vs planned), notable performances, recovery trends, and 1-2 focus points for next week.`
    );

    const narrative = result.is_error
      ? `Week ${program.current_week} complete. ${workouts.length}/${programmedDays} sessions.`
      : result.text;

    // Store check-in
    createCheckIn(ctx.config, 'weekly', narrative, {
      week: program.current_week,
      workouts_done: workouts.length,
      workouts_planned: programmedDays,
      avg_recovery: avgRecovery,
    });

    // Advance program week
    advanceProgramWeek(ctx.config, program.id);

    // Check if program is complete
    const isComplete = program.current_week >= program.total_weeks;
    let completionNote = '';
    if (isComplete) {
      completeProgramById(ctx.config, program.id);
      completionNote = '\n\n*Program complete!* Time to design the next block. Use /program new when you\'re ready.';
    }

    // Send
    await ctx.adapter.send({
      chatId,
      text: `*Week ${program.current_week} Review*\n\n${narrative}${completionNote}`,
      parseMode: 'Markdown',
    });

    ctx.log.info(`Weekly review sent. Week ${program.current_week}/${program.total_weeks}, ${workouts.length} workouts.`);
  },
};
