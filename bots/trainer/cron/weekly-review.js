/**
 * Cron handler: weekly_review
 *
 * Sunday 8pm ET — Progress review, advance program week, detect completion.
 */
import {
  ensureDb, getActiveProgram, getActiveGoals,
  getCachedWorkouts, getRecoveryRange,
  advanceProgramWeek, completeProgramById,
  createCheckIn, saveWeeklyAdjustment,
  getProgressionForProgram, getRecentFeedback,
  saveProgramHistory,
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

    // Gather progression data for review context
    let progressionContext = '';
    try {
      const progressions = getProgressionForProgram(ctx.config, program.id);
      if (progressions.length > 0) {
        const lines = progressions.map(p => {
          let status = p.status;
          if (p.status === 'stalled') status = `STALLED (${p.stall_weeks}wk)`;
          return `- ${p.exercise_title}: ${status}${p.current_weight_kg ? ` @ ${p.current_weight_kg}kg` : ''}`;
        });
        progressionContext = `\nEXERCISE PROGRESSION:\n${lines.join('\n')}`;
      }
    } catch { /* skip */ }

    // Gather recent feedback
    let feedbackContext = '';
    try {
      const feedback = getRecentFeedback(ctx.config, 5);
      if (feedback.length > 0) {
        const lines = feedback.map(f =>
          `- ${f.workout_date}: ${f.rpe_accuracy?.replace(/_/g, ' ')}, ${f.fatigue_level}${f.joint_pain !== 'none' ? `, ${f.joint_pain} pain (${f.joint_pain_location})` : ''}`
        );
        feedbackContext = `\nRECENT FEEDBACK:\n${lines.join('\n')}`;
      }
    } catch { /* skip */ }

    const dataContext = `
PROGRAM: ${program.title}, completing week ${program.current_week} of ${program.total_weeks}
PROGRAMMED SESSIONS: ${programmedDays}/week
ACTUAL WORKOUTS THIS WEEK: ${workouts.length}

WORKOUTS:
${workoutSummary}

RECOVERY: ${avgRecovery != null ? `avg ${avgRecovery}%` : 'no data'} over ${recovery.length} days
${progressionContext}${feedbackContext}
GOALS:
${goals.map(g => `- ${g.goal_text}`).join('\n') || 'None set.'}
`.trim();

    // Generate narrative with structured adjustment output
    const result = await callSonnet(
      'You are a personal trainer writing a weekly review. Be concise, specific, and actionable. Use bullet points. Telegram-friendly formatting.',
      `Write a brief weekly training review based on this data:\n\n${dataContext}\n\nInclude: compliance (sessions done vs planned), notable performances, recovery trends, progression status, and 1-2 focus points for next week.

After the narrative, output on a new line exactly:
ADJUSTMENT_JSON:{"volume_delta":0,"rpe_delta":0,"recommendation":"maintain","exercises_to_watch":[],"notes":""}

Decision rules:
- If fatigue is low AND performance is progressing: volume_delta=+1, recommendation="push"
- If fatigue is low AND performance is stagnant: rpe_delta=+0.5, recommendation="push"
- If fatigue is high AND performance declining: volume_delta=-1, recommendation="back_off"
- If fatigue is moderate AND performance stable: recommendation="maintain"
- If multiple exercises stalling: list them in exercises_to_watch`
    );

    let narrative;
    if (result.is_error) {
      narrative = `Week ${program.current_week} complete. ${workouts.length}/${programmedDays} sessions.`;
    } else {
      // Parse ADJUSTMENT_JSON from response
      const lines = result.text.split('\n');
      const cardLines = [];
      let adjustmentJson = null;

      for (const line of lines) {
        if (line.startsWith('ADJUSTMENT_JSON:')) {
          try {
            adjustmentJson = JSON.parse(line.slice('ADJUSTMENT_JSON:'.length).trim());
          } catch { /* malformed JSON, skip */ }
        } else {
          cardLines.push(line);
        }
      }

      narrative = cardLines.join('\n').trimEnd();

      // Store structured adjustment for next week
      if (adjustmentJson) {
        try {
          saveWeeklyAdjustment(ctx.config, {
            program_id: program.id,
            week_number: program.current_week + 1, // adjustment applies to NEXT week
            volume_delta: adjustmentJson.volume_delta ?? 0,
            rpe_delta: adjustmentJson.rpe_delta ?? 0,
            recommendation: adjustmentJson.recommendation ?? 'maintain',
            exercises_to_watch: adjustmentJson.exercises_to_watch ?? [],
            notes: adjustmentJson.notes ?? null,
          });
        } catch (err) {
          ctx.log.warn(`Failed to save weekly adjustment: ${err.message}`);
        }
      }
    }

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

      // Store program history for exercise rotation
      try {
        const progressions = getProgressionForProgram(ctx.config, program.id);
        if (progressions.length > 0) {
          const historyEntries = progressions.map(p => ({
            exercise_title: p.exercise_title,
            total_sessions: null, // could be computed from workout_cache but not critical
            final_status: p.status,
            final_weight_kg: p.current_weight_kg,
            muscle_group: null,
          }));
          saveProgramHistory(ctx.config, program.id, historyEntries);
        }
      } catch (err) {
        ctx.log.warn(`Failed to save program history: ${err.message}`);
      }

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
