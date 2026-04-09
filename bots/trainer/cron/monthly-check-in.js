/**
 * Cron handler: monthly_check_in
 *
 * 1st of month 9am ET — Deep analysis with Opus, program adjustment suggestions.
 */
import {
  ensureDb, getActiveProgram, getActiveGoals,
  getCachedWorkouts, getRecoveryRange,
  getRecentCheckIns, createCheckIn,
} from '../lib/db.js';
import { callOpus } from '../lib/claude.js';

export default {
  name: 'monthly_check_in',
  async execute(ctx) {
    const chatId = ctx.store?.get('chat_id')
      || ctx.config.platform?.chat_ids?.[0]
      || process.env.TRAINER_CHAT_ID;

    if (!chatId) {
      ctx.log.warn('Monthly check-in: no chat ID configured');
      return;
    }

    try {
      ensureDb(ctx.config);
    } catch {
      ctx.log.error('Monthly check-in: DB not available');
      return;
    }

    const program = getActiveProgram(ctx.config);
    const goals = getActiveGoals(ctx.config);

    // Gather 30 days of data
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const workouts = getCachedWorkouts(ctx.config, monthAgo, today);
    const recovery = getRecoveryRange(ctx.config, monthAgo, today);
    const weeklyCheckIns = getRecentCheckIns(ctx.config, 'weekly', 4);

    // Build comprehensive data package
    const workoutSummary = workouts.map(w => {
      const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
      const topSets = exercises.slice(0, 3).map(e => {
        const top = e.sets?.filter(s => s.type === 'normal')
          .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
        return top ? `${e.title}: ${top.weight_kg}kg x ${top.reps}` : e.title;
      }).join(', ');
      return `${w.date}: ${w.title} — ${topSets}`;
    }).join('\n') || 'No workouts logged.';

    // Recovery trends
    const weeklyRecovery = [];
    for (let i = 0; i < 4; i++) {
      const weekEnd = new Date(Date.now() - i * 7 * 86400000).toISOString().slice(0, 10);
      const weekStart = new Date(Date.now() - (i + 1) * 7 * 86400000).toISOString().slice(0, 10);
      const weekRecovery = recovery.filter(r =>
        r.date >= weekStart && r.date <= weekEnd && r.whoop_recovery_score != null
      );
      if (weekRecovery.length > 0) {
        const avg = Math.round(weekRecovery.reduce((s, r) => s + r.whoop_recovery_score, 0) / weekRecovery.length);
        weeklyRecovery.push(`Week ${4 - i}: avg ${avg}%`);
      }
    }

    // Previous weekly reviews
    const weeklyNotes = weeklyCheckIns.map(c => `- ${c.created_at?.slice(0, 10)}: ${c.summary.slice(0, 200)}`).join('\n');

    const dataContext = `
PROGRAM: ${program ? `${program.title}, currently week ${program.current_week}/${program.total_weeks}` : 'No active program'}

GOALS:
${goals.map(g => `- ${g.goal_text}${g.category ? ` [${g.category}]` : ''}`).join('\n') || 'None set.'}

WORKOUT LOG (last 30 days, ${workouts.length} total):
${workoutSummary}

RECOVERY TREND:
${weeklyRecovery.join('\n') || 'No recovery data.'}

WEEKLY REVIEW HIGHLIGHTS:
${weeklyNotes || 'No weekly reviews yet.'}
`.trim();

    // Call Opus for deep analysis
    const result = await callOpus(
      `You are an expert strength and conditioning coach doing a monthly progress review.
Analyze the data comprehensively. Cover:
1. Training consistency and volume trends
2. Strength progression (are weights going up?)
3. Recovery patterns (is the athlete recovering well?)
4. Goal progress (are they on track?)
5. Plateaus or concerns
6. Specific recommendations for next month

Be direct, specific, and actionable. Use Telegram-friendly formatting with bullet points.`,
      `Monthly training review:\n\n${dataContext}`
    );

    const review = result.is_error
      ? `Monthly check-in: ${workouts.length} workouts in 30 days. Data analysis unavailable.`
      : result.text;

    // Store check-in
    createCheckIn(ctx.config, 'monthly', review, {
      total_workouts: workouts.length,
      period_days: 30,
    });

    // Send
    await ctx.adapter.send({
      chatId,
      text: `*Monthly Training Review*\n\n${review}`,
      parseMode: 'Markdown',
    });

    ctx.log.info(`Monthly check-in sent. ${workouts.length} workouts in 30 days.`);
  },
};
