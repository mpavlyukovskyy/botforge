/**
 * Context builder: training_state
 *
 * Injects today's training session from program + detects conversation mode.
 * Keeps output lean (<1KB).
 */
import { ensureDb, getActiveProgram, getActiveGoals, getOnboardingAnalysis } from '../lib/db.js';

export default {
  type: 'training_state',
  async build(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return '';
    }

    const mode = ctx.store?.get('mode') || 'normal';
    const program = getActiveProgram(ctx.config);
    const goals = getActiveGoals(ctx.config);

    const parts = [];

    // Mode detection
    if (mode !== 'normal') {
      parts.push(`mode: ${mode}`);
    }

    if (mode === 'workout-time-ask') {
      parts.push('MODE: workout-time-ask — User was shown recovery and asked for workout duration. If they type a time (e.g. "45 min", "an hour", "30"), call generate_timed_workout tool. If they want to skip or change topic, that is fine — respond naturally. Do NOT generate a workout yourself.');
      return `<training_state>${parts.join(' | ')}</training_state>`;
    }

    // Onboarding detection
    if (goals.length === 0 && !program) {
      const analysis = getOnboardingAnalysis(ctx.config);

      if (analysis?.status === 'complete' && analysis.narrative) {
        const inferred = analysis.inferred_goals_json
          ? JSON.parse(analysis.inferred_goals_json)
          : [];
        const goalLines = inferred
          .map(g => `${g.goal_text} [${g.category}]`)
          .join('; ');
        parts.push('onboarding: analysis-ready');
        parts.push(`${analysis.workout_count} workouts analyzed`);
        if (goalLines) parts.push(`inferred goals: ${goalLines}`);
        parts.push('Present findings and ask CONFIRMING questions. Do NOT ask open-ended questions.');
      } else if (analysis?.status === 'pending') {
        parts.push('onboarding: analysis-in-progress');
        parts.push('Workout data is being analyzed. Tell the user to wait a moment.');
      } else {
        parts.push('No goals or program set. Guide the user through goal setting.');
      }

      return `<training_state>${parts.join(' | ')}</training_state>`;
    }

    // Goals summary
    if (goals.length > 0) {
      parts.push(`goals: ${goals.length} active`);
    }

    // Program + today's session
    if (program) {
      parts.push(`program: "${program.title}" week ${program.current_week}/${program.total_weeks}`);

      try {
        const data = JSON.parse(program.program_json);
        const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const session = data.weekly_template?.[dayName];

        if (session) {
          const exercises = (session.exercises || [])
            .map(e => `${e.name} ${e.sets}x${e.rep_range}`)
            .join(', ');
          parts.push(`today (${dayName}): ${session.name} — ${exercises}`);
        } else {
          parts.push(`today (${dayName}): rest day`);
        }
      } catch {}
    } else if (goals.length > 0) {
      if (mode === 'program-design') {
        parts.push('MODE: program-design — goals confirmed, CALL create_program TOOL NOW. Do NOT ask questions.');
      } else {
        parts.push('no program yet — suggest /program new');
      }
    }

    if (parts.length === 0) return '';
    return `<training_state>${parts.join(' | ')}</training_state>`;
  },
};
